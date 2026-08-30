import { NextResponse } from 'next/server';
import { clearedSessionCookieHeader, isSecureRequest } from '@/lib/auth/session';

/** 세션 쿠키를 지운다. 인증이 꺼진 상태에서도 무해하게 동작한다(지울 쿠키가 없을 뿐이다). */
export async function POST(request: Request): Promise<Response> {
  return NextResponse.json(
    { ok: true },
    { headers: { 'Set-Cookie': clearedSessionCookieHeader(isSecureRequest(request)) } },
  );
}
