import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { OPEN_MODE_SID, canAccessJob, forbiddenIfNotOwner, readAuthContext, requireAdmin, requireUser } from '@/lib/auth/guard';
import { SESSION_COOKIE_NAME, createSession, signSession, type SessionRole } from '@/lib/auth/session';

const SECRET = 'c'.repeat(64);
const AUTH_ENV_KEYS = ['ANB_ACCESS_PASSWORD', 'ANB_ADMIN_PASSWORD', 'ANB_SESSION_SECRET', 'ANB_HOST'] as const;

const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of AUTH_ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of AUTH_ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function lockDown(): void {
  process.env.ANB_ACCESS_PASSWORD = 'shared-secret';
  process.env.ANB_ADMIN_PASSWORD = 'admin-secret';
  process.env.ANB_SESSION_SECRET = SECRET;
}

function requestWithSession(role: SessionRole, sid?: string): Request {
  const session = { ...createSession(role, Date.now()), ...(sid ? { sid } : {}) };
  const token = signSession(session, SECRET);
  return new Request('http://localhost/api/jobs', {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
  });
}

describe('readAuthContext — 인증이 꺼진 상태', () => {
  test('비밀번호가 없으면 관리자 세션을 준다 (기존 로컬 단일 사용자 동작 유지)', () => {
    const ctx = readAuthContext(new Request('http://localhost/api/jobs'));
    expect(ctx).toEqual({ session: { sid: OPEN_MODE_SID, role: 'admin', exp: Number.MAX_SAFE_INTEGER }, mode: 'open' });
  });

  test('쿠키가 없어도 requireAdmin 이 통과한다', () => {
    const guard = requireAdmin(new Request('http://localhost/api/setup/login', { method: 'POST' }));
    expect(guard.ok).toBe(true);
  });
});

describe('requireUser — 잠긴 상태', () => {
  test('올바른 쿠키를 가진 요청은 통과한다', () => {
    lockDown();
    const guard = requireUser(requestWithSession('user'));
    expect(guard.ok).toBe(true);
    if (guard.ok) expect(guard.ctx.session.role).toBe('user');
  });

  test('쿠키가 없으면 401 이다 (완료 기준 1)', async () => {
    lockDown();
    const guard = requireUser(new Request('http://localhost/api/jobs', { method: 'POST' }));
    expect(guard.ok).toBe(false);
    if (!guard.ok) {
      expect(guard.response.status).toBe(401);
      expect(await guard.response.json()).toEqual({ error: '로그인이 필요합니다.' });
    }
  });

  test('위조한 쿠키는 401 이다', () => {
    lockDown();
    const token = signSession(createSession('admin', Date.now()), 'd'.repeat(64));
    const request = new Request('http://localhost/api/jobs', {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
    });
    const guard = requireUser(request);
    expect(guard.ok).toBe(false);
    if (!guard.ok) expect(guard.response.status).toBe(401);
  });

  test('설정이 깨져 있으면 열지 않고 500 으로 거절한다 (경계값)', async () => {
    process.env.ANB_HOST = '0.0.0.0'; // 비밀번호 없이 외부 바인딩 = 잘못된 설정
    const guard = requireUser(new Request('http://localhost/api/jobs'));
    expect(guard.ok).toBe(false);
    if (!guard.ok) {
      expect(guard.response.status).toBe(500);
      expect((await guard.response.json()).error).toMatch(/인증 설정/);
    }
  });
});

describe('requireAdmin — 잠긴 상태', () => {
  test('관리자 세션은 통과한다', () => {
    lockDown();
    expect(requireAdmin(requestWithSession('admin')).ok).toBe(true);
  });

  test('일반 세션은 403 이다 (완료 기준 2)', async () => {
    lockDown();
    const guard = requireAdmin(requestWithSession('user'));
    expect(guard.ok).toBe(false);
    if (!guard.ok) {
      expect(guard.response.status).toBe(403);
      expect((await guard.response.json()).error).toMatch(/관리자/);
    }
  });

  test('로그인하지 않았으면 403 이 아니라 401 이다 (경계값)', () => {
    lockDown();
    const guard = requireAdmin(new Request('http://localhost/api/setup/relogin', { method: 'POST' }));
    expect(guard.ok).toBe(false);
    if (!guard.ok) expect(guard.response.status).toBe(401);
  });
});

describe('canAccessJob / forbiddenIfNotOwner', () => {
  const userCtx = { session: { sid: 'sid-a', role: 'user' as const, exp: 1 }, mode: 'password' as const };
  const otherCtx = { session: { sid: 'sid-b', role: 'user' as const, exp: 1 }, mode: 'password' as const };
  const adminCtx = { session: { sid: 'sid-admin', role: 'admin' as const, exp: 1 }, mode: 'password' as const };

  test('자기 잡은 만질 수 있다', () => {
    expect(canAccessJob(userCtx, { owner: 'sid-a' })).toBe(true);
    expect(forbiddenIfNotOwner(userCtx, { owner: 'sid-a' })).toBeNull();
  });

  test('남의 잡은 403 이다 (완료 기준 3)', async () => {
    expect(canAccessJob(otherCtx, { owner: 'sid-a' })).toBe(false);
    const response = forbiddenIfNotOwner(otherCtx, { owner: 'sid-a' });
    expect(response?.status).toBe(403);
    expect((await (response as Response).json()).error).toMatch(/다른 사람/);
  });

  test('관리자도 남의 잡은 만질 수 없다', () => {
    expect(canAccessJob(adminCtx, { owner: 'sid-a' })).toBe(false);
  });

  test('소유자가 없는 옛 잡은 관리자에게만 연다 (경계값)', () => {
    expect(canAccessJob(adminCtx, { owner: null })).toBe(true);
    expect(canAccessJob(userCtx, { owner: null })).toBe(false);
  });

  // 혼자 쓰던 서버에 비밀번호를 붙이는 전환 — 그때 돌던 잡의 소유자는 'local' 이다.
  // 세션 식별자는 UUID 라 절대 'local' 이 될 수 없으므로, 이걸 소유자로 취급하면 관리자를
  // 포함한 모두에게 영영 403 이 된다.
  test('무인증 시절에 만들어진 잡도 관리자에게만 연다 (경계값)', () => {
    expect(canAccessJob(adminCtx, { owner: OPEN_MODE_SID })).toBe(true);
    expect(canAccessJob(userCtx, { owner: OPEN_MODE_SID })).toBe(false);
    expect(forbiddenIfNotOwner(adminCtx, { owner: OPEN_MODE_SID })).toBeNull();
    expect(forbiddenIfNotOwner(userCtx, { owner: OPEN_MODE_SID })?.status).toBe(403);
  });

  test('인증이 꺼진 상태에서는 소유자를 따지지 않는다', () => {
    const openCtx = { session: { sid: OPEN_MODE_SID, role: 'admin' as const, exp: 1 }, mode: 'open' as const };
    expect(canAccessJob(openCtx, { owner: 'sid-a' })).toBe(true);
    expect(canAccessJob(openCtx, { owner: null })).toBe(true);
  });
});
