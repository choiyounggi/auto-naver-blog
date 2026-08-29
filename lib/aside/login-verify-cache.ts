/**
 * 라이브 로그인 확인 결과를 잠깐 저장해 둔다.
 *
 * 확인 한 번에 Aside 브라우저를 띄워 네이버에 다녀오므로 5초 안팎이 걸린다(실측). 화면을
 * 새로고침할 때마다 그걸 다시 하면 매번 몇 초씩 "확인 중" 이 뜬다 — 로그인 상태가 초 단위로
 * 바뀌지는 않으므로 짧게 캐시해서 두 번째 이후는 즉시 답한다.
 *
 * 값을 globalThis 에 두는 이유는 lib/job/services 와 같다: dev 서버를 켠 채 코드를 고치면
 * 모듈 인스턴스가 하나 더 생겨 모듈 지역 변수는 공유되지 않는다.
 */
const CACHE_KEY = Symbol.for('auto-naver-blog.loginVerifyCache');

export interface LoginVerifyResult {
  loggedIn: boolean;
  reason: string | null;
}

interface CacheEntry extends LoginVerifyResult {
  at: number;
}

interface CacheGlobal {
  [CACHE_KEY]?: CacheEntry | null;
}

function slot(): CacheGlobal {
  return globalThis as unknown as CacheGlobal;
}

/** 기본 유효 기간. 사람이 로그아웃한 걸 알아채기까지 최대 이만큼 늦어진다. */
export const DEFAULT_VERIFY_TTL_MS = 60_000;

/** 아직 유효한 확인 결과. 없거나 오래됐으면 null. */
export function readVerifyCache(now: number, ttlMs: number = DEFAULT_VERIFY_TTL_MS): LoginVerifyResult | null {
  const entry = slot()[CACHE_KEY];
  if (!entry) return null;
  if (now - entry.at >= ttlMs) return null;
  return { loggedIn: entry.loggedIn, reason: entry.reason };
}

export function writeVerifyCache(result: LoginVerifyResult, now: number): void {
  slot()[CACHE_KEY] = { ...result, at: now };
}

/** 로그인·재로그인처럼 상태를 바꾼 직후에는 캐시를 버린다. */
export function clearVerifyCache(): void {
  slot()[CACHE_KEY] = null;
}
