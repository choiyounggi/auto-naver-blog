import { describe, expect, test } from 'vitest';
import {
  AuthConfigError,
  DEFAULT_HOST,
  checkBootConfig,
  isLoopbackHost,
  loadAuthConfig,
  resolveHost,
} from '@/lib/auth/config';
import { passwordMatches } from '@/lib/auth/password';

const SECRET = 'f'.repeat(64);

function env(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return overrides as NodeJS.ProcessEnv;
}

describe('isLoopbackHost', () => {
  test('루프백 주소를 알아본다', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('127.0.0.53')).toBe(true);
  });

  test('외부로 열리는 주소는 루프백이 아니다', () => {
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('::')).toBe(false);
    expect(isLoopbackHost('192.168.0.10')).toBe(false);
  });

  test('모르는 값은 외부로 본다 (모호하면 잠그는 쪽) — 경계값', () => {
    expect(isLoopbackHost('')).toBe(false);
    expect(isLoopbackHost('127.0.0.1.evil.com')).toBe(false);
    expect(isLoopbackHost('localhost.evil.com')).toBe(false);
  });
});

describe('resolveHost', () => {
  test('기본값은 루프백이다', () => {
    expect(resolveHost(env({}))).toBe(DEFAULT_HOST);
  });

  test('ANB_HOST 를 주면 그 값을 쓴다', () => {
    expect(resolveHost(env({ ANB_HOST: '0.0.0.0' }))).toBe('0.0.0.0');
  });

  test('빈 문자열·공백은 미설정으로 본다 (경계값)', () => {
    expect(resolveHost(env({ ANB_HOST: '   ' }))).toBe(DEFAULT_HOST);
  });
});

describe('loadAuthConfig — 정상', () => {
  test('비밀번호가 없고 루프백이면 인증이 꺼진 상태다', () => {
    const config = loadAuthConfig(env({}));
    expect(config.mode).toBe('open');
    expect(config.loopback).toBe(true);
    expect(config.sessionSecret).toBeNull();
  });

  test('비밀번호·서명 키가 있으면 잠긴 상태가 되고, 해시로만 보관한다', () => {
    const config = loadAuthConfig(
      env({ ANB_ACCESS_PASSWORD: 'shared-secret', ANB_ADMIN_PASSWORD: 'admin-secret', ANB_SESSION_SECRET: SECRET }),
    );
    expect(config.mode).toBe('password');
    expect(passwordMatches('shared-secret', config.accessPasswordHash as Buffer)).toBe(true);
    expect(passwordMatches('admin-secret', config.adminPasswordHash as Buffer)).toBe(true);
    // 평문은 어디에도 남지 않는다
    expect(JSON.stringify(config)).not.toContain('shared-secret');
  });

  test('외부 바인딩이어도 인증이 갖춰져 있으면 통과한다', () => {
    const config = loadAuthConfig(
      env({ ANB_HOST: '0.0.0.0', ANB_ACCESS_PASSWORD: 'shared-secret', ANB_SESSION_SECRET: SECRET }),
    );
    expect(config.mode).toBe('password');
    expect(config.loopback).toBe(false);
    expect(config.adminPasswordHash).toBeNull();
  });
});

describe('loadAuthConfig — 에러', () => {
  test('외부 바인딩인데 비밀번호가 없으면 던진다', () => {
    expect(() => loadAuthConfig(env({ ANB_HOST: '0.0.0.0' }))).toThrow(AuthConfigError);
    expect(() => loadAuthConfig(env({ ANB_HOST: '0.0.0.0' }))).toThrow(/ANB_ACCESS_PASSWORD/);
  });

  test('비밀번호는 있는데 서명 키가 없으면 던진다', () => {
    expect(() => loadAuthConfig(env({ ANB_ACCESS_PASSWORD: 'shared-secret' }))).toThrow(/ANB_SESSION_SECRET/);
  });

  test('서명 키가 너무 짧으면 던진다 (경계값)', () => {
    expect(() =>
      loadAuthConfig(env({ ANB_ACCESS_PASSWORD: 'shared-secret', ANB_SESSION_SECRET: 'x'.repeat(31) })),
    ).toThrow(/32자 이상/);
    expect(() =>
      loadAuthConfig(env({ ANB_ACCESS_PASSWORD: 'shared-secret', ANB_SESSION_SECRET: 'x'.repeat(32) })),
    ).not.toThrow();
  });

  test('비밀번호가 너무 짧으면 던진다 (경계값)', () => {
    expect(() =>
      loadAuthConfig(env({ ANB_ACCESS_PASSWORD: '1234567', ANB_SESSION_SECRET: SECRET })),
    ).toThrow(/8자 이상/);
    expect(() =>
      loadAuthConfig(env({ ANB_ACCESS_PASSWORD: '12345678', ANB_SESSION_SECRET: SECRET })),
    ).not.toThrow();
  });

  test('관리자 비밀번호가 일반 비밀번호와 같으면 던진다', () => {
    expect(() =>
      loadAuthConfig(
        env({ ANB_ACCESS_PASSWORD: 'same-secret', ANB_ADMIN_PASSWORD: 'same-secret', ANB_SESSION_SECRET: SECRET }),
      ),
    ).toThrow(/같습니다/);
  });

  test('관리자 비밀번호만 있으면 던진다', () => {
    expect(() => loadAuthConfig(env({ ANB_ADMIN_PASSWORD: 'admin-secret' }))).toThrow(/ANB_ADMIN_PASSWORD/);
  });

  test('공백뿐인 비밀번호는 설정하지 않은 것으로 본다 (경계값)', () => {
    expect(loadAuthConfig(env({ ANB_ACCESS_PASSWORD: '   ' })).mode).toBe('open');
    expect(() => loadAuthConfig(env({ ANB_HOST: '0.0.0.0', ANB_ACCESS_PASSWORD: '   ' }))).toThrow(AuthConfigError);
  });
});

describe('checkBootConfig', () => {
  test('설정이 갖춰졌으면 통과하고 알릴 말이 없다', () => {
    const result = checkBootConfig(
      env({ ANB_ACCESS_PASSWORD: 'shared-secret', ANB_ADMIN_PASSWORD: 'admin-secret', ANB_SESSION_SECRET: SECRET }),
    );
    expect(result.ok).toBe(true);
    expect(result.message).toBeNull();
  });

  test('인증이 꺼진 상태는 통과하되 그 사실을 알린다', () => {
    const result = checkBootConfig(env({}));
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/인증이 꺼져/);
  });

  test('관리자 비밀번호가 없으면 통과하되 경고한다', () => {
    const result = checkBootConfig(env({ ANB_ACCESS_PASSWORD: 'shared-secret', ANB_SESSION_SECRET: SECRET }));
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/ANB_ADMIN_PASSWORD/);
  });

  test('외부 바인딩 + 인증 없음이면 이유와 함께 거부한다 (완료 기준 5)', () => {
    const result = checkBootConfig(env({ ANB_HOST: '0.0.0.0' }));
    expect(result.ok).toBe(false);
    expect(result.config).toBeNull();
    expect(result.message).toMatch(/ANB_ACCESS_PASSWORD/);
  });
});
