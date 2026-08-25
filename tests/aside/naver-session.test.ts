import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { NaverSession } from '@/lib/aside/naver-session';
import type { AppConfig } from '@/lib/config';
import type { AsideEvalResult, AsideReplApi } from '@/lib/types';

const testDir = path.dirname(fileURLToPath(import.meta.url));
// 보안 정책: /tmp·$TMPDIR 대신 프로젝트 내부(gitignore 된 .vitest-tmp)에만 파일을 만든다
const scratchDir = path.join(testDir, '..', '..', '.vitest-tmp', 'aside-naver-session-tests');

function ok(stdout: string): AsideEvalResult {
  return { ok: true, stdout, durationMs: 1, error: null };
}

function fail(error: string): AsideEvalResult {
  return { ok: false, stdout: '', durationMs: 1, error };
}

interface FakeReplResponses {
  getCookies?: AsideEvalResult;
  setCookies?: AsideEvalResult;
  statusCheck?: AsideEvalResult;
}

function fakeRepl(responses: FakeReplResponses = {}): AsideReplApi {
  return {
    async start() {},
    async dispose() {},
    async evaluate(js: string): Promise<AsideEvalResult> {
      if (js.includes('Storage.getCookies')) {
        return responses.getCookies ?? ok('{"cookies":[]}');
      }
      if (js.includes('Storage.setCookies')) {
        return responses.setCookies ?? ok('{"restored":0}');
      }
      if (js.includes('page.goto')) {
        return responses.statusCheck ?? ok('{"blogId":null}');
      }
      throw new Error(`예상치 못한 js: ${js}`);
    },
  };
}

function fixtureConfig(cookieFile: string, overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    dataDir: scratchDir,
    claudeBin: 'claude',
    asideBin: 'unused',
    naverBlogId: null,
    cookieFile,
    claudeTimeoutMs: 600000,
    asideStepTimeoutMs: 60000,
    ...overrides,
  };
}

let cookieFile: string;

beforeEach(async () => {
  await mkdir(scratchDir, { recursive: true });
  cookieFile = path.join(scratchDir, `cookies-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
});

afterEach(async () => {
  await rm(scratchDir, { recursive: true, force: true });
});

const naverCookie1 = { name: 'NID_AUT', value: 'x', domain: '.naver.com', path: '/' };
const naverCookie2 = { name: 'NID_SES', value: 'y', domain: 'naver.com', path: '/' };
const otherCookie1 = { name: 'foo', value: 'z', domain: 'example.com', path: '/' };
const otherCookie2 = { name: 'bar', value: 'w', domain: '.google.com', path: '/' };

describe('exportCookies — 정상', () => {
  test('네이버 쿠키 2개 + 다른 도메인 쿠키 2개 중 2개만 저장하고, 파일에 다른 도메인이 없다', async () => {
    const repl = fakeRepl({
      getCookies: ok(JSON.stringify({ cookies: [naverCookie1, naverCookie2, otherCookie1, otherCookie2] })),
    });
    const session = new NaverSession(repl, fixtureConfig(cookieFile));

    const count = await session.exportCookies();
    expect(count).toBe(2);

    const saved = JSON.parse(await readFile(cookieFile, 'utf8'));
    expect(saved).toHaveLength(2);
    expect(saved.some((c: { domain: string }) => c.domain === 'example.com')).toBe(false);
    expect(saved.some((c: { domain: string }) => c.domain === '.google.com')).toBe(false);
  });

  test('저장 후 importCookies() 가 같은 개수를 반환한다', async () => {
    const repl = fakeRepl({
      getCookies: ok(JSON.stringify({ cookies: [naverCookie1, naverCookie2, otherCookie1] })),
    });
    const session = new NaverSession(repl, fixtureConfig(cookieFile));

    const exported = await session.exportCookies();
    const imported = await session.importCookies();
    expect(imported).toBe(exported);
    expect(imported).toBe(2);
  });
});

describe('exportCookies — 경계값', () => {
  test('Storage.getCookies 가 빈 배열을 돌려주면 0을 반환한다', async () => {
    const repl = fakeRepl({ getCookies: ok('{"cookies":[]}') });
    const session = new NaverSession(repl, fixtureConfig(cookieFile));
    const count = await session.exportCookies();
    expect(count).toBe(0);
  });
});

describe('exportCookies — 보안', () => {
  test('저장된 쿠키 파일의 mode 가 0600 이다', async () => {
    const repl = fakeRepl({ getCookies: ok(JSON.stringify({ cookies: [naverCookie1] })) });
    const session = new NaverSession(repl, fixtureConfig(cookieFile));
    await session.exportCookies();

    const stats = await import('node:fs/promises').then((fs) => fs.stat(cookieFile));
    expect(stats.mode & 0o777).toBe(0o600);
  });
});

describe('status — 정상/에러', () => {
  test('쿠키 파일이 없으면 reason:"no-cookies" 를 반환하고 importCookies() 는 0을 반환한다', async () => {
    const repl = fakeRepl();
    const session = new NaverSession(repl, fixtureConfig(cookieFile));

    expect(existsSync(cookieFile)).toBe(false);
    const status = await session.status();
    expect(status.loggedIn).toBe(false);
    if (!status.loggedIn) expect(status.reason).toBe('no-cookies');

    const imported = await session.importCookies();
    expect(imported).toBe(0);
  });

  test('evaluate() 가 ok:false 를 돌려주면 status() 가 reason:"unknown" 을 반환한다', async () => {
    // status() 는 쿠키 파일이 있으면 먼저 importCookies() 를 호출한다(D10) —
    // 그 evaluate() 가 실패하면 로그인 페이지 확인까지 가지 못하므로 'unknown' 이어야 한다.
    await mkdir(path.dirname(cookieFile), { recursive: true });
    await (await import('node:fs/promises')).writeFile(cookieFile, JSON.stringify([naverCookie1]), 'utf8');

    const repl = fakeRepl({ setCookies: fail('boom') });
    const session = new NaverSession(repl, fixtureConfig(cookieFile));
    const status = await session.status();
    expect(status.loggedIn).toBe(false);
    if (!status.loggedIn) expect(status.reason).toBe('unknown');
  });

  // F2(r1): 로그인 여부는 "로그인 페이지로 튕기지 않았다"는 부재가 아니라, 로그인 상태에서만
  // 존재하는 신호(blogId 추출 성공)의 존재로 판정한다. 아래 세 케이스가 그 판정을 고정한다.

  test('(a) 양성 신호(blogId 추출 성공)가 있으면 loggedIn:true 와 그 blogId 를 반환한다', async () => {
    await mkdir(path.dirname(cookieFile), { recursive: true });
    await (await import('node:fs/promises')).writeFile(cookieFile, JSON.stringify([naverCookie1]), 'utf8');

    const repl = fakeRepl({ statusCheck: ok('{"blogId":"myblog"}') });
    const session = new NaverSession(repl, fixtureConfig(cookieFile));
    const status = await session.status();
    expect(status.loggedIn).toBe(true);
    if (status.loggedIn) expect(status.blogId).toBe('myblog');
  });

  test('(b) 양성 신호가 없고 쿠키는 있으면 reason:"expired" 를 반환한다', async () => {
    await mkdir(path.dirname(cookieFile), { recursive: true });
    await (await import('node:fs/promises')).writeFile(cookieFile, JSON.stringify([naverCookie1]), 'utf8');

    // 로그인 페이지로 튕기지 않고 그냥 blog.naver.com 홈을 보여주는 경우도 포함 — url 에
    // nid.naver.com 이 없다고 해서 loggedIn:true 가 되면 안 된다(F2 가 고치려던 바로 그 버그).
    const repl = fakeRepl({ statusCheck: ok('{"blogId":null}') });
    const session = new NaverSession(repl, fixtureConfig(cookieFile));
    const status = await session.status();
    expect(status.loggedIn).toBe(false);
    if (!status.loggedIn) expect(status.reason).toBe('expired');
  });

  test('(c) 로그인 확인 evaluate() 자체가 실패하면(ok:false) reason:"unknown" 을 반환한다', async () => {
    await mkdir(path.dirname(cookieFile), { recursive: true });
    await (await import('node:fs/promises')).writeFile(cookieFile, JSON.stringify([naverCookie1]), 'utf8');

    const repl = fakeRepl({ statusCheck: fail('네비게이션 실패') });
    const session = new NaverSession(repl, fixtureConfig(cookieFile));
    const status = await session.status();
    expect(status.loggedIn).toBe(false);
    if (!status.loggedIn) expect(status.reason).toBe('unknown');
  });
});
