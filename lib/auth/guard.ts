import { NextResponse } from 'next/server';
import { AuthConfigError, loadAuthConfig, type AuthMode } from './config';
import { SESSION_COOKIE_NAME, readCookie, verifySession, type Session } from './session';
import type { JobState } from '../types';

/** 인증이 꺼진(루프백 전용) 상태에서 쓰는 가상의 세션 식별자. */
export const OPEN_MODE_SID = 'local';

export interface AuthContext {
  session: Session;
  mode: AuthMode;
}

export type GuardResult = { ok: true; ctx: AuthContext } | { ok: false; response: Response };

function jsonError(message: string, status: number): Response {
  return NextResponse.json({ error: message }, { status });
}

/**
 * 요청의 세션을 읽는다. 인증이 꺼져 있으면 관리자 세션을 하나 만들어 준다 —
 * 루프백 전용이라 이 기계의 사람만 도달할 수 있고, 기존 단일 사용자 동작이 그대로 유지된다.
 */
export function readAuthContext(request: Request): AuthContext | null {
  const config = loadAuthConfig();
  if (config.mode === 'open') {
    return { session: { sid: OPEN_MODE_SID, role: 'admin', exp: Number.MAX_SAFE_INTEGER }, mode: 'open' };
  }

  const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE_NAME);
  // sessionSecret 은 mode==='password' 이면 반드시 있다 (loadAuthConfig 가 보장).
  const session = verifySession(token, config.sessionSecret as string, Date.now());
  return session === null ? null : { session, mode: 'password' };
}

/** 로그인한 사람만 통과시킨다. */
export function requireUser(request: Request): GuardResult {
  let ctx: AuthContext | null;
  try {
    ctx = readAuthContext(request);
  } catch (err) {
    // 설정이 깨졌으면 열린 채로 계속 도는 대신 전부 거절한다.
    if (err instanceof AuthConfigError) {
      console.error('[auth] 인증 설정이 잘못됐습니다:', err.message);
      return { ok: false, response: jsonError('서버 인증 설정이 잘못됐습니다 — 관리자에게 알려 주세요.', 500) };
    }
    throw err;
  }

  if (ctx === null) {
    return { ok: false, response: jsonError('로그인이 필요합니다.', 401) };
  }
  return { ok: true, ctx };
}

/** 네이버 계정을 건드리는 경로. 로그인하지 않았으면 401, 일반 사용자면 403. */
export function requireAdmin(request: Request): GuardResult {
  const guard = requireUser(request);
  if (!guard.ok) return guard;
  if (guard.ctx.session.role !== 'admin') {
    return { ok: false, response: jsonError('관리자만 할 수 있는 작업입니다.', 403) };
  }
  return guard;
}

/**
 * 이 세션이 이 잡을 만질 수 있는가.
 *
 * 인증이 꺼진 상태에서는 이 기계의 사람 하나뿐이라 구분하지 않는다.
 *
 * 인증을 켜기 전에 만들어진 잡은 둘 중 하나다: `owner` 가 아예 없거나(인증 코드가 없던 시절의
 * 잡 파일), 무인증 모드의 고정 식별자(`OPEN_MODE_SID`)다. 둘 다 "누구 것인지 알 수 없다" 는
 * 같은 뜻이므로 관리자에게만 연다 — 이걸 구분하지 않으면, 혼자 쓰던 서버에 비밀번호를 붙인
 * 순간 그때 돌던 잡이 관리자를 포함한 **모두에게** 영영 403 이 된다(세션 식별자는 매번 새로
 * 만들어지는 UUID 라 'local' 과 절대 같아지지 않는다).
 */
export function canAccessJob(ctx: AuthContext, job: Pick<JobState, 'owner'>): boolean {
  if (ctx.mode === 'open') return true;
  if (job.owner === null || job.owner === OPEN_MODE_SID) return ctx.session.role === 'admin';
  return job.owner === ctx.session.sid;
}

/** 접근할 수 없으면 403 응답을, 괜찮으면 null 을 돌려준다. */
export function forbiddenIfNotOwner(ctx: AuthContext, job: Pick<JobState, 'owner'>): Response | null {
  return canAccessJob(ctx, job) ? null : jsonError('다른 사람이 만든 잡입니다.', 403);
}
