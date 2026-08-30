import { NextResponse } from 'next/server';
import { AuthConfigError, loadAuthConfig } from '@/lib/auth/config';
import { passwordMatches } from '@/lib/auth/password';
import { clearLoginAttempts, clientKey, recordLoginAttempt } from '@/lib/auth/rate-limit';
import {
  SESSION_TTL_MS,
  createSession,
  isSecureRequest,
  sessionCookieHeader,
  signSession,
  type SessionRole,
} from '@/lib/auth/session';

/**
 * 공유 비밀번호로 로그인한다. 아이디는 없다 — 비밀번호 하나가 곧 신분이다.
 *
 * 관리자 비밀번호를 넣으면 관리자 세션이, 일반 비밀번호를 넣으면 일반 세션이 된다.
 * 비밀번호는 해시로만 비교하고(lib/auth/password), 응답은 어느 쪽이 틀렸는지 알려 주지 않는다.
 */
export async function POST(request: Request): Promise<Response> {
  let config;
  try {
    config = loadAuthConfig();
  } catch (err) {
    if (err instanceof AuthConfigError) {
      console.error('[auth] 인증 설정이 잘못됐습니다:', err.message);
      return NextResponse.json({ error: '서버 인증 설정이 잘못됐습니다 — 관리자에게 알려 주세요.' }, { status: 500 });
    }
    throw err;
  }

  if (config.mode === 'open') {
    return NextResponse.json({ error: '이 서버는 비밀번호 없이 씁니다 (로컬 전용).' }, { status: 400 });
  }

  // 대입 공격을 막는다. 본문을 읽기 전에 센다 — 큰 본문을 보내 우회하지 못하게.
  const key = clientKey(request);
  const decision = recordLoginAttempt(key, Date.now());
  if (!decision.allowed) {
    return NextResponse.json(
      { error: `로그인 시도가 너무 잦습니다 — ${decision.retryAfterSec}초 뒤에 다시 시도해 주세요.` },
      { status: 429, headers: { 'Retry-After': String(decision.retryAfterSec) } },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  const password = (body as { password?: unknown })?.password;
  if (typeof password !== 'string') {
    return NextResponse.json({ error: '비밀번호를 입력해 주세요.' }, { status: 400 });
  }

  // 관리자 비밀번호를 먼저 본다 — 둘 다 확인하므로 어느 쪽이든 같은 만큼 시간이 걸린다.
  let role: SessionRole | null = null;
  if (config.adminPasswordHash !== null && passwordMatches(password, config.adminPasswordHash)) {
    role = 'admin';
  } else if (config.accessPasswordHash !== null && passwordMatches(password, config.accessPasswordHash)) {
    role = 'user';
  }

  if (role === null) {
    return NextResponse.json({ error: '비밀번호가 맞지 않습니다.' }, { status: 401 });
  }

  // 성공한 사람의 카운터는 비운다 — 옆에서 누가 틀렸다고 정상 사용자가 막히지 않게.
  clearLoginAttempts(key);

  const token = signSession(createSession(role, Date.now()), config.sessionSecret as string);
  return NextResponse.json(
    { role },
    { headers: { 'Set-Cookie': sessionCookieHeader(token, isSecureRequest(request), SESSION_TTL_MS) } },
  );
}
