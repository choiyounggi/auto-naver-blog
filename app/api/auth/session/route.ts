import { NextResponse } from 'next/server';
import { AuthConfigError, loadAuthConfig } from '@/lib/auth/config';
import { readAuthContext } from '@/lib/auth/guard';

/**
 * 화면이 처음 부르는 곳. 비밀번호 화면을 띄울지, 바로 업로드 화면을 띄울지 여기서 정한다.
 * 로그인하지 않은 사람도 불러야 하므로 이 경로만 가드가 없다 — 대신 아무 비밀도 주지 않는다.
 */
export async function GET(request: Request): Promise<Response> {
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

  const ctx = readAuthContext(request);
  return NextResponse.json({
    authRequired: config.mode === 'password',
    authenticated: ctx !== null,
    role: ctx?.session.role ?? null,
    // 관리자 비밀번호가 아예 없으면 화면이 "관리자에게 문의" 대신 다른 안내를 해야 한다.
    adminAvailable: config.mode === 'open' || config.adminPasswordHash !== null,
  });
}
