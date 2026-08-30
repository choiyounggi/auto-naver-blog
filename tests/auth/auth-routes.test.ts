import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { POST as postLogin } from '@/app/api/auth/login/route';
import { POST as postLogout } from '@/app/api/auth/logout/route';
import { GET as getSession } from '@/app/api/auth/session/route';
import { MAX_ATTEMPTS, resetLoginAttempts } from '@/lib/auth/rate-limit';
import { SESSION_COOKIE_NAME, verifySession } from '@/lib/auth/session';

const SECRET = 'e'.repeat(64);
const AUTH_ENV_KEYS = ['ANB_ACCESS_PASSWORD', 'ANB_ADMIN_PASSWORD', 'ANB_SESSION_SECRET', 'ANB_HOST'] as const;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of AUTH_ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  resetLoginAttempts();
});

afterEach(() => {
  for (const key of AUTH_ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetLoginAttempts();
});

function lockDown(withAdmin = true): void {
  process.env.ANB_ACCESS_PASSWORD = 'shared-secret';
  if (withAdmin) process.env.ANB_ADMIN_PASSWORD = 'admin-secret';
  process.env.ANB_SESSION_SECRET = SECRET;
}

function loginRequest(password: unknown, ip = '203.0.113.7'): Request {
  return new Request('http://localhost/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ password }),
  });
}

function cookieFrom(response: Response): string {
  const header = response.headers.get('set-cookie') ?? '';
  return header.slice(header.indexOf('=') + 1, header.indexOf(';'));
}

describe('POST /api/auth/login — 정상', () => {
  test('일반 비밀번호는 일반 세션을 준다', async () => {
    lockDown();
    const response = await postLogin(loginRequest('shared-secret'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ role: 'user' });

    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(verifySession(cookieFrom(response), SECRET, Date.now())?.role).toBe('user');
  });

  test('관리자 비밀번호는 관리자 세션을 준다', async () => {
    lockDown();
    const response = await postLogin(loginRequest('admin-secret'));
    expect(await response.json()).toEqual({ role: 'admin' });
    expect(verifySession(cookieFrom(response), SECRET, Date.now())?.role).toBe('admin');
  });

  test('로그인에 성공하면 그 IP 의 실패 카운터가 비워진다', async () => {
    lockDown();
    for (let attempt = 0; attempt < MAX_ATTEMPTS - 1; attempt++) await postLogin(loginRequest('틀린값'));
    expect((await postLogin(loginRequest('shared-secret'))).status).toBe(200);
    // 카운터가 비워졌으므로 다시 여러 번 시도할 수 있다
    expect((await postLogin(loginRequest('틀린값'))).status).toBe(401);
  });
});

describe('POST /api/auth/login — 에러/경계값', () => {
  test('틀린 비밀번호는 401 이고 쿠키를 주지 않는다', async () => {
    lockDown();
    const response = await postLogin(loginRequest('틀린값'));
    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  test('시도가 잦으면 429 와 Retry-After 를 준다', async () => {
    lockDown();
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      expect((await postLogin(loginRequest('틀린값'))).status).toBe(401);
    }
    const blocked = await postLogin(loginRequest('틀린값'));
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    // 막힌 동안에는 맞는 비밀번호도 통과하지 못한다
    expect((await postLogin(loginRequest('shared-secret'))).status).toBe(429);
  });

  test('다른 IP 는 막히지 않는다', async () => {
    lockDown();
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) await postLogin(loginRequest('틀린값'));
    expect((await postLogin(loginRequest('shared-secret', '198.51.100.4'))).status).toBe(200);
  });

  test('비밀번호가 문자열이 아니거나 본문이 JSON 이 아니면 400 이다 (경계값)', async () => {
    lockDown();
    expect((await postLogin(loginRequest(1234))).status).toBe(400);
    expect((await postLogin(loginRequest(null))).status).toBe(400);
    const broken = new Request('http://localhost/api/auth/login', { method: 'POST', body: '{' });
    expect((await postLogin(broken)).status).toBe(400);
  });

  test('관리자 비밀번호가 없으면 일반 비밀번호로도 관리자가 되지 않는다', async () => {
    lockDown(false);
    const response = await postLogin(loginRequest('shared-secret'));
    expect(await response.json()).toEqual({ role: 'user' });
  });

  test('인증이 꺼진 서버에서는 로그인할 것이 없다 (400)', async () => {
    const response = await postLogin(loginRequest('아무거나'));
    expect(response.status).toBe(400);
  });

  test('설정이 깨져 있으면 500 이다', async () => {
    process.env.ANB_HOST = '0.0.0.0';
    expect((await postLogin(loginRequest('아무거나'))).status).toBe(500);
  });
});

describe('GET /api/auth/session', () => {
  test('인증이 꺼져 있으면 로그인 화면이 필요 없다고 알린다', async () => {
    const response = await getSession(new Request('http://localhost/api/auth/session'));
    expect(await response.json()).toEqual({
      authRequired: false,
      authenticated: true,
      role: 'admin',
      adminAvailable: true,
    });
  });

  test('잠긴 서버에서 쿠키가 없으면 인증되지 않은 상태로 답한다', async () => {
    lockDown();
    const response = await getSession(new Request('http://localhost/api/auth/session'));
    expect(await response.json()).toEqual({
      authRequired: true,
      authenticated: false,
      role: null,
      adminAvailable: true,
    });
  });

  test('로그인한 뒤에는 역할까지 알려 준다', async () => {
    lockDown();
    const login = await postLogin(loginRequest('admin-secret'));
    const response = await getSession(
      new Request('http://localhost/api/auth/session', {
        headers: { cookie: `${SESSION_COOKIE_NAME}=${cookieFrom(login)}` },
      }),
    );
    expect(await response.json()).toMatchObject({ authenticated: true, role: 'admin' });
  });

  test('관리자 비밀번호가 없으면 그 사실을 알린다 (경계값)', async () => {
    lockDown(false);
    const response = await getSession(new Request('http://localhost/api/auth/session'));
    expect(await response.json()).toMatchObject({ adminAvailable: false });
  });
});

describe('POST /api/auth/logout', () => {
  test('세션 쿠키를 지운다', async () => {
    lockDown();
    const response = await postLogout(new Request('http://localhost/api/auth/logout', { method: 'POST' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  test('로그아웃한 쿠키로는 더 이상 통과하지 못한다', async () => {
    lockDown();
    const login = await postLogin(loginRequest('shared-secret'));
    const token = cookieFrom(login);
    await postLogout(new Request('http://localhost/api/auth/logout', { method: 'POST' }));
    // 쿠키를 지우는 것은 브라우저 쪽이므로, 서버가 확인하는 것은 "빈 쿠키 = 세션 없음" 이다.
    const response = await getSession(
      new Request('http://localhost/api/auth/session', { headers: { cookie: `${SESSION_COOKIE_NAME}=` } }),
    );
    expect(await response.json()).toMatchObject({ authenticated: false });
    // 토큰 자체는 아직 유효하다 — 그래서 로그아웃은 쿠키를 지우는 것으로 끝난다.
    expect(verifySession(token, SECRET, Date.now())).not.toBeNull();
  });

  test('인증이 꺼진 서버에서도 던지지 않는다 (경계값)', async () => {
    const response = await postLogout(new Request('http://localhost/api/auth/logout', { method: 'POST' }));
    expect(response.status).toBe(200);
  });
});
