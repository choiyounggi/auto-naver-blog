import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/** 세션 쿠키 이름. HttpOnly 라 스크립트에서는 읽히지 않는다. */
export const SESSION_COOKIE_NAME = 'anb_session';

/** 세션 유효 기간. 한 번 로그인하면 일주일은 다시 묻지 않는다. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const SessionRoleSchema = z.enum(['user', 'admin']);
export type SessionRole = z.infer<typeof SessionRoleSchema>;

// 쿠키는 브라우저를 거쳐 들어오는 경계 데이터다 — 서명을 확인한 뒤에도 모양을 zod 로 한 번
// 더 검증한다(서명 키가 유출되지 않아도, 옛 버전이 만든 다른 모양이 섞일 수 있다).
export const SessionSchema = z.object({
  /** 세션 식별자. 잡의 소유자로 기록된다 — 남의 잡을 만지지 못하게 하는 근거다. */
  sid: z.string().min(1),
  role: SessionRoleSchema,
  /** 만료 시각 (epoch ms) */
  exp: z.number().int().positive(),
});
export type Session = z.infer<typeof SessionSchema>;

export function newSessionId(): string {
  return randomUUID();
}

export function createSession(role: SessionRole, now: number, ttlMs: number = SESSION_TTL_MS): Session {
  return { sid: newSessionId(), role, exp: now + ttlMs };
}

function toBase64Url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

function sign(payload: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(payload, 'utf8').digest();
}

/** `<base64url(payload)>.<base64url(hmac)>` 형태의 서명 토큰을 만든다. */
export function signSession(session: Session, secret: string): string {
  const payload = toBase64Url(JSON.stringify(session));
  return `${payload}.${toBase64Url(sign(payload, secret))}`;
}

/**
 * 토큰을 검증해 세션을 돌려준다. 서명이 틀렸거나 만료됐으면 null —
 * 어느 쪽인지 호출자에게 구분해 주지 않는다(어차피 대응이 같고, 정보를 덜 흘린다).
 */
export function verifySession(token: string | null | undefined, secret: string, now: number): Session | null {
  if (!token) return null;

  const separator = token.indexOf('.');
  if (separator <= 0 || separator === token.length - 1) return null;

  const payload = token.slice(0, separator);
  const signature = Buffer.from(token.slice(separator + 1), 'base64url');
  const expected = sign(payload, secret);
  // 길이가 다르면 timingSafeEqual 이 던진다 — 위조된 토큰은 예외가 아니라 null 이어야 한다.
  if (signature.length !== expected.length) return null;
  if (!timingSafeEqual(signature, expected)) return null;

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  const parsed = SessionSchema.safeParse(parsedJson);
  if (!parsed.success) return null;
  if (parsed.data.exp <= now) return null;

  return parsed.data;
}

/** 쿠키 헤더에서 이름 하나를 꺼낸다. 값에 `=` 가 들어 있어도 첫 `=` 만 구분자로 쓴다. */
export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq) !== name) continue;
    return decodeURIComponent(trimmed.slice(eq + 1));
  }
  return null;
}

/**
 * `Secure` 는 HTTPS 일 때만 붙인다 — 평문 HTTP 로 열어 둔 로컬/사내망에서 Secure 를 붙이면
 * 브라우저가 쿠키를 아예 저장하지 않아 로그인이 되지 않는다.
 *
 * 프록시 뒤라면 `x-forwarded-proto` 가 실제 프로토콜을 알려 준다.
 */
export function isSecureRequest(request: Request): boolean {
  const forwarded = request.headers.get('x-forwarded-proto');
  if (forwarded) return forwarded.split(',')[0].trim() === 'https';
  try {
    return new URL(request.url).protocol === 'https:';
  } catch {
    return false;
  }
}

export function sessionCookieHeader(token: string, secure: boolean, ttlMs: number = SESSION_TTL_MS): string {
  const attributes = [
    `${SESSION_COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    // Lax: 같은 사이트 탐색에는 실려 가지만, 남의 사이트가 만든 POST 에는 실리지 않는다
    // (발행 같은 상태 변경을 CSRF 로 유발당하지 않는다).
    'SameSite=Lax',
    `Max-Age=${Math.floor(ttlMs / 1000)}`,
  ];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}

export function clearedSessionCookieHeader(secure: boolean): string {
  const attributes = [`${SESSION_COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}
