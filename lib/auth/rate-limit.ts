/**
 * 로그인 시도 속도 제한.
 *
 * 공유 비밀번호 하나가 앱 전체의 문이므로, 무한 대입을 그냥 두면 언젠가 뚫린다.
 * 상태를 globalThis 에 두는 이유는 lib/job/services 와 같다 — dev 서버에서 모듈 인스턴스가
 * 갈려도 같은 카운터를 봐야 한다.
 */
const BUCKETS_KEY = Symbol.for('auto-naver-blog.loginRateBuckets');

/** 한 키(보통 IP)당 이 창 안에서 허용하는 시도 횟수. */
export const MAX_ATTEMPTS = 10;
export const WINDOW_MS = 60_000;

/**
 * 한 키의 최근 시도 시각들(epoch ms). 개수는 MAX_ATTEMPTS 를 넘지 않는다 —
 * 거절된 시도는 기록하지 않기 때문이다.
 *
 * 고정 창(창 시작 시각 + 카운터) 대신 시각 목록을 두는 이유: 고정 창은 창이 바뀌는 순간
 * 카운터가 통째로 비워져, 창 끝에 10회 + 창이 바뀌자마자 10회 = 몇 초 만에 20회를 허용한다.
 * "분당 10회" 라고 적어 둔 만큼 실제로도 어느 60초를 잘라 봐도 10회여야 한다.
 */
type Attempts = number[];

interface BucketsGlobal {
  [BUCKETS_KEY]?: Map<string, Attempts>;
}

function buckets(): Map<string, Attempts> {
  const slot = globalThis as unknown as BucketsGlobal;
  slot[BUCKETS_KEY] ??= new Map();
  return slot[BUCKETS_KEY];
}

export interface RateLimitDecision {
  allowed: boolean;
  /** 남은 시도 횟수 (거절된 경우 0) */
  remaining: number;
  /** 다시 시도할 수 있을 때까지 남은 초 (허용된 경우 0) */
  retryAfterSec: number;
}

/**
 * 요청지를 식별하는 키. Next 의 Request 에는 원격 주소가 없어서 프록시 헤더에 의존한다.
 *
 * `x-forwarded-for` 는 위조할 수 있다 — 프록시 없이 직접 노출할 때는 헤더가 아예 없으므로
 * 모두가 'direct' 한 통을 나눠 쓴다(전체 합산 제한이 되어, 대입은 여전히 막힌다).
 * 프록시 뒤에 둘 거라면 프록시가 이 헤더를 **덮어쓰도록** 설정해야 의미가 있다.
 */
export function clientKey(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0].trim();
    if (first !== '') return first;
  }
  return 'direct';
}

function within(attempts: Attempts, now: number): Attempts {
  return attempts.filter((at) => now - at < WINDOW_MS);
}

/** 시도를 한 번 기록하고 허용 여부를 판정한다. 거절된 시도는 기록하지 않는다(창을 연장하지 않는다). */
export function recordLoginAttempt(key: string, now: number): RateLimitDecision {
  const map = buckets();

  // 창 밖으로 완전히 나간 통은 그때그때 버린다 — 따로 청소 타이머를 두지 않기 위해서다.
  for (const [existingKey, attempts] of map) {
    if (within(attempts, now).length === 0) map.delete(existingKey);
  }

  const recent = within(map.get(key) ?? [], now);

  if (recent.length >= MAX_ATTEMPTS) {
    map.set(key, recent);
    // 가장 오래된 시도가 창 밖으로 나가면 한 번 더 쓸 수 있다.
    const freeAt = recent[0] + WINDOW_MS;
    return { allowed: false, remaining: 0, retryAfterSec: Math.max(1, Math.ceil((freeAt - now) / 1000)) };
  }

  recent.push(now);
  map.set(key, recent);
  return { allowed: true, remaining: MAX_ATTEMPTS - recent.length, retryAfterSec: 0 };
}

/** 로그인에 성공하면 그 키의 카운터를 비운다 — 정상 사용자가 다음에 막히지 않게. */
export function clearLoginAttempts(key: string): void {
  buckets().delete(key);
}

/** 테스트용: 모든 카운터를 비운다. */
export function resetLoginAttempts(): void {
  buckets().clear();
}
