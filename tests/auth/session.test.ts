import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  clearedSessionCookieHeader,
  createSession,
  isSecureRequest,
  readCookie,
  sessionCookieHeader,
  signSession,
  verifySession,
} from '@/lib/auth/session';

const SECRET = 'a'.repeat(64);
const NOW = 1_800_000_000_000;

describe('createSession/signSession/verifySession — 정상', () => {
  test('서명한 토큰을 같은 키로 검증하면 같은 세션이 나온다', () => {
    const session = createSession('user', NOW);
    expect(verifySession(signSession(session, SECRET), SECRET, NOW)).toEqual(session);
  });

  test('세션 식별자는 매번 다르다 (사람마다 다른 소유자가 된다)', () => {
    expect(createSession('user', NOW).sid).not.toBe(createSession('user', NOW).sid);
  });

  test('역할이 토큰에 실려 온다', () => {
    const token = signSession(createSession('admin', NOW), SECRET);
    expect(verifySession(token, SECRET, NOW)?.role).toBe('admin');
  });

  test('기본 유효 기간은 7일이다', () => {
    expect(createSession('user', NOW).exp).toBe(NOW + SESSION_TTL_MS);
  });
});

describe('verifySession — 에러(위조·만료)', () => {
  test('다른 키로 서명한 토큰은 거부한다', () => {
    const token = signSession(createSession('admin', NOW), 'b'.repeat(64));
    expect(verifySession(token, SECRET, NOW)).toBeNull();
  });

  test('역할을 admin 으로 바꿔치기한 페이로드는 서명이 깨져 거부된다', () => {
    const token = signSession(createSession('user', NOW), SECRET);
    const [, signature] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ sid: 'x', role: 'admin', exp: NOW + 1000 })).toString('base64url');
    expect(verifySession(`${forged}.${signature}`, SECRET, NOW)).toBeNull();
  });

  test('만료된 토큰은 거부한다', () => {
    const token = signSession(createSession('user', NOW, 1000), SECRET);
    expect(verifySession(token, SECRET, NOW + 1001)).toBeNull();
  });

  test('만료 직전은 통과하고 만료 시각 정각은 거부한다 (경계값)', () => {
    const token = signSession(createSession('user', NOW, 1000), SECRET);
    expect(verifySession(token, SECRET, NOW + 999)).not.toBeNull();
    expect(verifySession(token, SECRET, NOW + 1000)).toBeNull();
  });

  test('서명 길이가 다르거나 형식이 깨진 토큰도 던지지 않고 null 이다', () => {
    expect(verifySession('짧다', SECRET, NOW)).toBeNull();
    expect(verifySession('.onlysig', SECRET, NOW)).toBeNull();
    expect(verifySession('payload.', SECRET, NOW)).toBeNull();
    expect(verifySession(`${Buffer.from('{}').toString('base64url')}.AA`, SECRET, NOW)).toBeNull();
  });

  test('빈 값·null·undefined 는 null 이다 (경계값)', () => {
    expect(verifySession('', SECRET, NOW)).toBeNull();
    expect(verifySession(null, SECRET, NOW)).toBeNull();
    expect(verifySession(undefined, SECRET, NOW)).toBeNull();
  });

  test('서명은 유효해도 모양이 스키마에 맞지 않으면 거부한다', () => {
    // 서명 키를 아는 쪽이 만든 토큰이라도 role 이 스키마 밖이면 통과시키지 않는다.
    const sign = (payload: string) => createHmac('sha256', SECRET).update(payload, 'utf8').digest('base64url');
    const bad = Buffer.from(JSON.stringify({ sid: 'x', role: 'superuser', exp: NOW + 1000 })).toString('base64url');
    expect(verifySession(`${bad}.${sign(bad)}`, SECRET, NOW)).toBeNull();

    // 같은 방식으로 만든 정상 페이로드는 통과한다 — 위 실패가 서명 때문이 아님을 보인다.
    const good = Buffer.from(JSON.stringify({ sid: 'x', role: 'user', exp: NOW + 1000 })).toString('base64url');
    expect(verifySession(`${good}.${sign(good)}`, SECRET, NOW)).not.toBeNull();
  });
});

describe('쿠키 헬퍼', () => {
  test('세션 쿠키에는 HttpOnly·SameSite=Lax·Path 가 붙는다', () => {
    const header = sessionCookieHeader('tok', false);
    expect(header).toContain(`${SESSION_COOKIE_NAME}=tok`);
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    expect(header).not.toContain('Secure');
  });

  test('HTTPS 면 Secure 를 붙인다', () => {
    expect(sessionCookieHeader('tok', true)).toContain('Secure');
  });

  test('로그아웃 쿠키는 Max-Age=0 이다', () => {
    expect(clearedSessionCookieHeader(false)).toContain('Max-Age=0');
  });

  test('readCookie 는 여러 쿠키 중 이름이 맞는 것만 꺼낸다', () => {
    expect(readCookie(`a=1; ${SESSION_COOKIE_NAME}=tok.sig; b=2`, SESSION_COOKIE_NAME)).toBe('tok.sig');
  });

  test('readCookie 는 없는 이름·빈 헤더에 null 을 준다 (경계값)', () => {
    expect(readCookie('a=1', SESSION_COOKIE_NAME)).toBeNull();
    expect(readCookie('', SESSION_COOKIE_NAME)).toBeNull();
    expect(readCookie(null, SESSION_COOKIE_NAME)).toBeNull();
  });

  test('isSecureRequest 는 x-forwarded-proto 를 먼저 본다', () => {
    const forwarded = new Request('http://example.test/', { headers: { 'x-forwarded-proto': 'https, http' } });
    expect(isSecureRequest(forwarded)).toBe(true);
    expect(isSecureRequest(new Request('http://example.test/'))).toBe(false);
    expect(isSecureRequest(new Request('https://example.test/'))).toBe(true);
  });
});
