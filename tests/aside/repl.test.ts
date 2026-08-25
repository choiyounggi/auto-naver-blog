import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { AsideRepl } from '@/lib/aside/repl';
import type { AppConfig } from '@/lib/config';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const fakeReplPath = path.join(testDir, 'fake-repl.mjs');

function fixtureConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    dataDir: '/unused',
    claudeBin: 'claude',
    asideBin: `${process.execPath} ${fakeReplPath}`,
    naverBlogId: null,
    cookieFile: '/unused/naver-cookies.json',
    claudeTimeoutMs: 600000,
    asideStepTimeoutMs: 5000,
    ...overrides,
  };
}

const repls: AsideRepl[] = [];

async function startRepl(overrides: Partial<AppConfig> = {}): Promise<AsideRepl> {
  const repl = new AsideRepl(fixtureConfig(overrides));
  repls.push(repl);
  await repl.start();
  return repl;
}

afterEach(async () => {
  await Promise.all(repls.splice(0).map((r) => r.dispose()));
});

describe('AsideRepl.evaluate — 정상', () => {
  test('__FAKE_ECHO__ 를 보내면 ok===true, stdout 에 echo 내용이 포함되고 durationMs 는 숫자다', async () => {
    const repl = await startRepl();
    const result = await repl.evaluate('__FAKE_ECHO__:hello');
    expect(result.ok).toBe(true);
    expect(result.stdout).toContain('hello');
    expect(typeof result.durationMs).toBe('number');
    expect(result.error).toBeNull();
  });
});

describe('AsideRepl.evaluate — 에러 (D3)', () => {
  test('__FAKE_ERROR__ 를 보내면 ok===false 이고 error 가 스크립트 실패를 가리킨다', async () => {
    const repl = await startRepl();
    const result = await repl.evaluate('__FAKE_ERROR__');
    expect(result.ok).toBe(false);
    expect(result.error).not.toBeNull();
    expect(result.error).toContain('script failed');
  });

  test('__FAKE_DIE__ 를 보내면 ok===false 이고 error 는 프로세스 사망을 가리키며 타임아웃 문자열과 다르다', async () => {
    const repl = await startRepl();
    const result = await repl.evaluate('__FAKE_DIE__');
    expect(result.ok).toBe(false);
    expect(result.error).not.toBeNull();
    expect(result.error).toMatch(/process exited/);
    expect(result.error).not.toMatch(/timeout/);
  });
});

describe('AsideRepl.evaluate — 경계값/타임아웃', () => {
  test('__FAKE_HANG__ + 짧은 timeoutMs 는 ok===false 이고 error 가 타임아웃을 가리킨다', async () => {
    const repl = await startRepl();
    const result = await repl.evaluate('__FAKE_HANG__', { timeoutMs: 200 });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timeout/);
  });

  test('D6 회귀: 타임아웃 직후 정상 스텝을 실행하면 자기 결과만 담고 앞 스텝의 흔적이 없다', async () => {
    const repl = await startRepl();
    const timedOut = await repl.evaluate('__FAKE_HANG__', { timeoutMs: 200 });
    expect(timedOut.ok).toBe(false);

    const second = await repl.evaluate('__FAKE_ECHO__:second');
    expect(second.ok).toBe(true);
    expect(second.stdout).toContain('second');
    expect(second.stdout).not.toMatch(/HANG|timeout/i);
  });
});

describe('AsideRepl.dispose', () => {
  test('두 번 호출해도 throw 하지 않는다', async () => {
    const repl = await startRepl();
    await expect(repl.dispose()).resolves.toBeUndefined();
    await expect(repl.dispose()).resolves.toBeUndefined();
  });

  test('dispose 후 자식 프로세스가 종료된다 (exitCode 또는 signalCode 가 설정됨)', async () => {
    const repl = await startRepl();
    // 내부 child 참조를 얻기 위해 evaluate 로 살아있음을 먼저 확인한다
    const before = await repl.evaluate('__FAKE_ECHO__:alive');
    expect(before.ok).toBe(true);

    const child = (repl as unknown as { child: import('node:child_process').ChildProcess }).child;
    await repl.dispose();
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });
});
