import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

export interface LoginPersistence {
  /** '로그인 상태 유지' 가 켜진 채 로그인했는가 — 인증 쿠키가 영속 쿠키로 발급됐는가 */
  keepLoggedIn: boolean;
  /** 인증 쿠키의 만료 시각(ISO). 세션 쿠키면 null */
  expiresAt: string | null;
}

// 실측(2026-08-25): '로그인 상태 유지' 를 켜지 않고 로그인하면 NID_AUT·NID_SES 가 만료일
// 없는 **세션 쿠키**로 내려온다. 브라우저를 닫으면 사라지고, 저장해 둔 쿠키를 복원해도
// 서버 세션이 이미 끝나 로그인이 풀린다(이틀 만에 끊겼다). 체크를 켜면 영속 쿠키가 되어
// 브라우저를 닫아도, 쿠키 파일에서 복원해도 로그인이 유지된다.
const AUTH_COOKIE_NAME = 'NID_AUT';

/** 세션 쿠키는 expires 가 없거나 0·-1 로 온다(관측된 세 가지 형태를 모두 세션으로 본다). */
function toExpiresAt(expires: unknown): string | null {
  if (typeof expires !== 'number') return null;
  if (expires <= 0) return null;
  const ms = expires * 1000;
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

export function describeLoginPersistence(cookies: unknown): LoginPersistence {
  if (!Array.isArray(cookies)) return { keepLoggedIn: false, expiresAt: null };

  const auth = cookies.find(
    (cookie) =>
      typeof cookie === 'object' &&
      cookie !== null &&
      (cookie as Record<string, unknown>).name === AUTH_COOKIE_NAME,
  );
  if (auth === undefined) return { keepLoggedIn: false, expiresAt: null };

  const expiresAt = toExpiresAt((auth as Record<string, unknown>).expires);
  return { keepLoggedIn: expiresAt !== null, expiresAt };
}

/** 저장된 쿠키 파일을 읽어 로그인 지속성을 판정한다. 파일이 없거나 깨졌으면 유지 안 됨으로 본다. */
export async function readLoginPersistence(cookieFile: string): Promise<LoginPersistence> {
  if (!existsSync(cookieFile)) return { keepLoggedIn: false, expiresAt: null };
  try {
    return describeLoginPersistence(JSON.parse(await readFile(cookieFile, 'utf8')));
  } catch {
    return { keepLoggedIn: false, expiresAt: null };
  }
}
