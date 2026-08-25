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
});

// F1 리뷰(r1): 타임아웃된 스텝의 센티넬이 나중에라도 도착하면, 그 시점에 이미 큐에서 시작된
// 다음 스텝의 버퍼에 붙어 다음 스텝의 결과로 잘못 resolve 되던 문제. 드레이닝 상태가 그
// 늦은 출력을 다음 스텝이 시작되기 전에 흡수/폐기해야 한다.
describe('AsideRepl.evaluate — F1 드레이닝/오염 상태 회귀', () => {
  test('타임아웃된 스텝의 늦은 출력이 다음 스텝의 결과로 새지 않는다', async () => {
    const repl = await startRepl();
    // A: 타임아웃(30ms)보다 훨씬 뒤(150ms)에 실제로 센티넬을 낸다.
    // B: 그보다도 더 늦게(자기 줄을 받은 시점부터 250ms 뒤) 센티넬을 낸다 — 그래서 A의
    // 늦은 출력(150ms 시점)이 도착할 때 B 는 아직 자기 센티넬을 받기 전, 즉 "아직 진행
    // 중"인 상태가 된다. 드레이닝이 없다면 이 시점에 A의 센티넬이 B의 버퍼에 붙어 B를
    // "A의 결과"로 잘못 resolve 한다 — 이게 F1 이 실제로 재현되는 조건이다.
    const timedOut = await repl.evaluate('__FAKE_SLOW__:150:late-A', { timeoutMs: 30 });
    expect(timedOut.ok).toBe(false);
    expect(timedOut.error).toMatch(/timeout/);

    const second = await repl.evaluate('__FAKE_SLOW__:250:B-text');
    expect(second.ok).toBe(true);
    expect(second.stdout).toContain('B-text');
    expect(second.stdout).not.toContain('late-A');
  });

  test('드레이닝 예산을 넘기면 poisoned 상태로 전환되어 이후 evaluate() 가 즉시 실패한다', async () => {
    const repl = await startRepl({ asideStepTimeoutMs: 150 });
    // __FAKE_HANG__ 은 영원히 침묵하므로 드레이닝이 끝날 신호(늦은 센티넬)가 오지 않는다 —
    // 드레이닝 예산(asideStepTimeoutMs=150ms)을 넘기면 poisoned 로 전환돼야 한다.
    const timedOut = await repl.evaluate('__FAKE_HANG__', { timeoutMs: 30 });
    expect(timedOut.ok).toBe(false);
    expect(timedOut.error).toMatch(/timeout/);

    await new Promise((resolve) => setTimeout(resolve, 250));

    const afterPoison = await repl.evaluate('__FAKE_ECHO__:should-not-run');
    expect(afterPoison.ok).toBe(false);
    expect(afterPoison.error).toMatch(/동기화 상실/);
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
