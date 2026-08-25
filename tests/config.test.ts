import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { loadConfig } from '@/lib/config';

// Next.js가 전역 NodeJS.ProcessEnv에 NODE_ENV를 필수로 선언하므로,
// 테스트 fixture는 실제로 필요한 키만 담고 타입만 맞춰 준다.
function fixtureEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  return overrides as NodeJS.ProcessEnv;
}

describe('loadConfig — 정상', () => {
  test('환경변수로 claudeBin을 주입하면 그 값이 반영된다', () => {
    const config = loadConfig(fixtureEnv({ ANB_CLAUDE_BIN: '/usr/local/bin/claude' }));
    expect(config.claudeBin).toBe('/usr/local/bin/claude');
  });
});

describe('loadConfig — 숫자 기본값 (D7)', () => {
  test('메커니즘: 출하 기본값과 다른 값을 주입하면 그 값이 반영된다', () => {
    const config = loadConfig(
      fixtureEnv({
        ANB_CLAUDE_TIMEOUT_MS: '12345',
        ANB_ASIDE_STEP_TIMEOUT_MS: '999',
      }),
    );
    expect(config.claudeTimeoutMs).toBe(12345);
    expect(config.asideStepTimeoutMs).toBe(999);
  });

  test('출하 기본값: 빈 환경에서는 600000/60000이 그대로 나온다', () => {
    const config = loadConfig(fixtureEnv({}));
    expect(config.claudeTimeoutMs).toBe(600000);
    expect(config.asideStepTimeoutMs).toBe(60000);
  });
});

describe('loadConfig — 에러', () => {
  test.each(['./data', 'data', 'relative/path'])('ANB_DATA_DIR=%s 는 원시값을 포함해 throw한다', (raw) => {
    expect(() => loadConfig(fixtureEnv({ ANB_DATA_DIR: raw }))).toThrowError(new RegExp(`got: '${raw}'`));
  });

  test('ANB_CLAUDE_TIMEOUT_MS=abc 는 메시지에 abc를 포함해 throw한다', () => {
    expect(() => loadConfig(fixtureEnv({ ANB_CLAUDE_TIMEOUT_MS: 'abc' }))).toThrowError(/abc/);
  });
});

describe('loadConfig — 경계값', () => {
  test('ANB_CLAUDE_TIMEOUT_MS=0 은 throw한다 (양의 정수 필요)', () => {
    expect(() => loadConfig(fixtureEnv({ ANB_CLAUDE_TIMEOUT_MS: '0' }))).toThrow();
  });

  test('ANB_CLAUDE_TIMEOUT_MS=1 은 성공하고 1이 나온다', () => {
    const config = loadConfig(fixtureEnv({ ANB_CLAUDE_TIMEOUT_MS: '1' }));
    expect(config.claudeTimeoutMs).toBe(1);
  });

  test('빈 환경에서 모든 기본값이 채워지고 dataDir이 절대경로다', () => {
    const config = loadConfig(fixtureEnv({}));
    expect(path.isAbsolute(config.dataDir)).toBe(true);
    expect(config.naverBlogId).toBeNull();
  });

  test('ANB_DATA_DIR=~/anb-data 는 확장되어 절대경로로 통과한다', () => {
    const config = loadConfig(fixtureEnv({ ANB_DATA_DIR: '~/anb-data' }));
    expect(path.isAbsolute(config.dataDir)).toBe(true);
    expect(config.dataDir).not.toContain('~');
  });
});
