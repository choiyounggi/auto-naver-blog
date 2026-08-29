import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { LoginTimeoutError, runNaverLoginFlow } from '@/lib/aside/login-flow';
import type { AsideEvalResult, AsideReplApi, NaverSessionApi, NaverSessionStatus } from '@/lib/types';

const testDir = path.dirname(fileURLToPath(import.meta.url));
// 보안 정책: /tmp·$TMPDIR 대신 프로젝트 내부(gitignore 된 .vitest-tmp)에만 파일을 만든다
const scratchDir = path.join(testDir, '..', '..', '.vitest-tmp', 'login-flow-tests');

const BANNER = '✔︎ Opened a new tab and set it active: tabs[0], page → NAVER';

function ok(stdout: string): AsideEvalResult {
  return { ok: true, stdout, durationMs: 1, error: null };
}

function fail(error: string): AsideEvalResult {
  return { ok: false, stdout: '', durationMs: 1, error };
}

/** URL 시퀀스를 흉내내는 가짜 REPL. openTab 은 배너를 앞에 붙여 실제 동작을 재현한다. */
function scriptedRepl(urls: (string | null)[], overrides: { open?: AsideEvalResult } = {}) {
  const calls: string[] = [];
  let index = 0;
  const repl: AsideReplApi = {
    async start() {},
    async dispose() {},
    async evaluate(js: string): Promise<AsideEvalResult> {
      calls.push(js);
      if (js.includes('openTab')) {
        if (overrides.open) return overrides.open;
        const url = urls[index++] ?? null;
        return ok(`${BANNER}\n${JSON.stringify({ url })}`);
      }
      if (js.includes('loginStay')) {
        return ok(JSON.stringify({ keepLoggedInChecked: true }));
      }
      if (js.includes('querySelectorAll')) {
        return ok(JSON.stringify({ links: [{ text: '테슬라', href: '?categoryNo=6' }] }));
      }
      // MyBlog.naver 로 goto 하는 blogId 재확인·discoverBlogMeta 공용 경로
      const url = urls[index++] ?? null;
      return ok(JSON.stringify({ url }));
    },
  };
  return { repl, calls };
}

function fakeSession(cookieCount = 12): NaverSessionApi {
  return {
    async exportCookies() {
      return cookieCount;
    },
    async importCookies() {
      return cookieCount;
    },
    async status(): Promise<NaverSessionStatus> {
      return { loggedIn: true, blogId: 'dev_king', checkedAt: new Date().toISOString() };
    },
  };
}

let envPath: string;

beforeEach(async () => {
  await mkdir(scratchDir, { recursive: true });
  envPath = path.join(scratchDir, '.env');
});

afterEach(async () => {
  await rm(scratchDir, { recursive: true, force: true });
});

describe('runNaverLoginFlow — 정상', () => {
  test('이미 로그인되어 있으면 대기 없이 쿠키·메타를 저장한다', async () => {
    const { repl } = scriptedRepl([
      'https://blog.naver.com/dev_king', // openTab 결과
      'https://blog.naver.com/dev_king', // discoverBlogMeta 의 blogId 조회
    ]);

    const result = await runNaverLoginFlow(repl, fakeSession(), { envPath });

    expect(result.alreadyLoggedIn).toBe(true);
    expect(result.blogId).toBe('dev_king');
    expect(result.categories).toEqual(['테슬라']);
    expect(result.cookieCount).toBe(12);
    expect(await readFile(envPath, 'utf8')).toContain('NAVER_BLOG_ID=dev_king');
  });

  test('로그인 페이지에서 시작해도 로그인이 끝나면 진행된다', async () => {
    const { repl } = scriptedRepl([
      'https://nid.naver.com/nidlogin.login', // openTab — 아직 로그인 전
      'https://blog.naver.com/dev_king', // 첫 폴링에서 로그인 확인
      'https://blog.naver.com/dev_king', // discoverBlogMeta
    ]);

    const result = await runNaverLoginFlow(repl, fakeSession(), { envPath, pollIntervalMs: 1 });

    expect(result.alreadyLoggedIn).toBe(false);
    expect(result.blogId).toBe('dev_king');
  });

  test('진행 메시지를 onMessage 로 알린다', async () => {
    const { repl } = scriptedRepl(['https://blog.naver.com/dev_king', 'https://blog.naver.com/dev_king']);
    const messages: string[] = [];

    await runNaverLoginFlow(repl, fakeSession(), { envPath, onMessage: (m) => messages.push(m) });

    expect(messages.some((m) => m.includes('이미 로그인'))).toBe(true);
    expect(messages.some((m) => m.includes('쿠키'))).toBe(true);
  });

  test('openTab 배너가 섞여 있어도 URL 을 읽어낸다(회귀)', async () => {
    const { repl, calls } = scriptedRepl([
      'https://blog.naver.com/dev_king',
      'https://blog.naver.com/dev_king',
    ]);

    const result = await runNaverLoginFlow(repl, fakeSession(), { envPath });

    expect(result.alreadyLoggedIn).toBe(true);
    expect(calls[0]).toContain('openTab');
  });
});

describe('runNaverLoginFlow — 에러/경계값', () => {
  test('로그인 대기가 시간 초과되면 LoginTimeoutError 를 던진다', async () => {
    // 계속 로그인 페이지에 머무는 상황
    const repl: AsideReplApi = {
      async start() {},
      async dispose() {},
      async evaluate(js: string): Promise<AsideEvalResult> {
        const url = 'https://nid.naver.com/nidlogin.login';
        return ok(js.includes('openTab') ? `${BANNER}\n${JSON.stringify({ url })}` : JSON.stringify({ url }));
      },
    };

    await expect(
      runNaverLoginFlow(repl, fakeSession(), { envPath, pollIntervalMs: 1, loginTimeoutMs: 10 }),
    ).rejects.toBeInstanceOf(LoginTimeoutError);
  });

  test('내 블로그 페이지를 열지 못하면 사유를 담아 던진다', async () => {
    const { repl } = scriptedRepl([], { open: fail('aside 죽음') });

    await expect(runNaverLoginFlow(repl, fakeSession(), { envPath })).rejects.toThrow('aside 죽음');
  });

  test('로그인은 됐지만 blogId 를 못 읽으면 던진다', async () => {
    const { repl } = scriptedRepl([
      'https://blog.naver.com/dev_king', // openTab
      'https://nid.naver.com/nidlogin.login', // discoverBlogMeta 에서 튕김
    ]);

    await expect(runNaverLoginFlow(repl, fakeSession(), { envPath })).rejects.toThrow(
      '로그인 상태를 확인하세요',
    );
  });

  test('경계값: 쿠키가 0개여도 흐름은 끝까지 진행된다', async () => {
    const { repl } = scriptedRepl(['https://blog.naver.com/dev_king', 'https://blog.naver.com/dev_king']);

    const result = await runNaverLoginFlow(repl, fakeSession(0), { envPath });

    expect(result.cookieCount).toBe(0);
    expect(result.blogId).toBe('dev_king');
  });
});


// 실측 회귀(2026-08-25): '로그인 상태 유지' 를 켜지 않으면 인증 쿠키가 세션 쿠키로 내려와
// 브라우저를 닫는 순간 로그인이 풀린다. 로그인 전에 그 체크박스를 대신 켜 준다.
describe("runNaverLoginFlow — '로그인 상태 유지'", () => {
  test('로그인이 필요하면 체크박스를 켜는 스텝을 먼저 보낸다', async () => {
    const { repl, calls } = scriptedRepl([
      'https://nid.naver.com/nidlogin.login',
      'https://blog.naver.com/dev_king',
      'https://blog.naver.com/dev_king',
    ]);

    await runNaverLoginFlow(repl, fakeSession(), { envPath, pollIntervalMs: 1 });

    const keepIndex = calls.findIndex((js) => js.includes('loginStay'));
    expect(keepIndex).toBeGreaterThanOrEqual(0);
    // 체크는 사람이 로그인하기 전에 끝나야 한다 — URL 폴링보다 앞서야 한다.
    const pollIndex = calls.findIndex((js) => js.includes('url: page.url()') && !js.includes('openTab'));
    expect(keepIndex).toBeLessThan(pollIndex);
  });

  test('이미 로그인돼 있으면 체크박스를 건드리지 않는다', async () => {
    const { repl, calls } = scriptedRepl(['https://blog.naver.com/dev_king', 'https://blog.naver.com/dev_king']);

    await runNaverLoginFlow(repl, fakeSession(), { envPath });

    expect(calls.some((js) => js.includes('loginStay'))).toBe(false);
  });

  test('cookieFile 을 주면 로그인 지속성을 판정해 돌려준다', async () => {
    const { repl } = scriptedRepl(['https://blog.naver.com/dev_king', 'https://blog.naver.com/dev_king']);
    const cookieFile = path.join(scratchDir, 'cookies.json');
    await writeFile(
      cookieFile,
      JSON.stringify([{ name: 'NID_AUT', expires: Math.floor(Date.parse('2027-01-01T00:00:00Z') / 1000) }]),
      'utf8',
    );

    const result = await runNaverLoginFlow(repl, fakeSession(), { envPath, cookieFile });

    expect(result.persistence.keepLoggedIn).toBe(true);
    expect(result.persistence.expiresAt).toBe('2027-01-01T00:00:00.000Z');
  });

  test('경계값: cookieFile 을 주지 않으면 판정을 건너뛴다(유지 안 됨으로 본다)', async () => {
    const { repl } = scriptedRepl(['https://blog.naver.com/dev_king', 'https://blog.naver.com/dev_king']);

    const result = await runNaverLoginFlow(repl, fakeSession(), { envPath });

    expect(result.persistence).toEqual({ keepLoggedIn: false, expiresAt: null });
  });
});
