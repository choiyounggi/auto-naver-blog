/**
 * 에디터 사용권(리스) 큐.
 *
 * 이 앱은 Aside REPL 하나를 공유한다(lib/pipeline.ts 의 LazyNaverPublisher). 두 잡이 동시에
 * fillEditor/publish 를 부르면 **같은 브라우저 탭**을 서로 조작해, 한쪽이 다른 쪽의 글을
 * 발행하는 일이 생긴다. 그래서 "에디터를 쓰는 구간" 전체를 한 번에 한 잡만 갖게 한다.
 *
 * 리스는 요청 하나보다 오래 산다 — fillEditor 로 잡았다가 사람이 승인(발행)할 때까지 쥐고
 * 있어야 한다. 그렇지 않으면 A 가 승인 화면을 보는 동안 B 가 에디터를 덮어써서, A 가 승인한
 * 순간 B 의 글이 올라간다. 그래서 `runExclusive(fn)` 이 아니라 acquire/release 형태다.
 *
 * 상태를 globalThis 에 두는 이유는 lib/job/services 와 같다 — dev 서버에서 모듈 인스턴스가
 * 갈려도 같은 큐를 봐야 한다.
 */
const QUEUE_KEY = Symbol.for('auto-naver-blog.editorQueue');

/** 앞선 잡이 끝나기를 기다리는 최대 시간. 넘으면 조용히 매달려 있지 않고 거절한다. */
export const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60_000;

/**
 * 한 잡이 에디터를 쥐고 있을 수 있는 최대 시간. 사람이 승인 화면을 열어 둔 채 사라지면
 * 뒤의 모두가 영영 막히므로, 이 시간이 지나면 강제로 반납한다.
 */
export const DEFAULT_HOLD_TIMEOUT_MS = 30 * 60_000;

export class EditorWaitTimeoutError extends Error {
  constructor(jobId: string, waitedMs: number) {
    super(
      `에디터를 ${Math.round(waitedMs / 60_000)}분 기다렸지만 차례가 오지 않았습니다 ` +
        `(job '${jobId}') — 앞의 발행이 끝난 뒤 다시 시도해 주세요.`,
    );
    this.name = 'EditorWaitTimeoutError';
  }
}

/** 리스를 쥐지 않은 잡이 에디터를 쓰려고 할 때. 라우트는 이걸 409 로 바꾼다. */
export class EditorNotHeldError extends Error {
  constructor(jobId: string) {
    super(
      `job '${jobId}' 가 에디터를 쥐고 있지 않습니다 — 대기 시간이 지나 반납됐거나 서버가 다시 시작됐습니다. ` +
        '처음부터 다시 시작해 주세요.',
    );
    this.name = 'EditorNotHeldError';
  }
}

export interface AcquireOptions {
  waitTimeoutMs?: number;
  holdTimeoutMs?: number;
  /** 대기가 시작될 때와 순번이 앞당겨질 때마다, 앞에 남은 건수를 알린다. */
  onWait?: (ahead: number) => void;
  /**
   * 점유 제한 시간을 넘겨 강제로 반납될 때 불린다. 다음 잡을 들여보내기 **전에** 끝까지
   * 기다린다 — 버려진 에디터 탭을 정리할 시간을 주기 위해서다.
   */
  onHoldExpired?: () => void | Promise<void>;
}

interface Waiter {
  jobId: string;
  enqueuedAt: number;
  timer: ReturnType<typeof setTimeout>;
  options: AcquireOptions;
  resolve: () => void;
  reject: (err: Error) => void;
}

interface Holder {
  jobId: string;
  timer: ReturnType<typeof setTimeout>;
  onHoldExpired?: () => void | Promise<void>;
}

export interface QueueSnapshot {
  holder: string | null;
  waiting: string[];
}

class EditorQueue {
  private holder: Holder | null = null;
  private readonly waiters: Waiter[] = [];
  /**
   * 점유 만료 뒷정리(버려진 탭 닫기)가 도는 중인가.
   *
   * 그 사이에는 쥔 잡이 없지만(holder=null) 아무도 들여보내면 안 된다 — 정리가 탭을 닫는
   * 동안 다른 잡이 에디터를 열면 그 새 탭이 닫힌다. holder 만 보고 판단하면 마침 그때 도착한
   * 잡이 줄을 건너뛰고 바로 들어가, 정리가 끝난 뒤 promoteNext 가 넘겨준 잡과 **둘이 동시에**
   * 에디터를 만지게 된다(이 큐가 막으려던 바로 그 상황이다).
   */
  private draining = false;

  /**
   * 이 잡이 에디터를 쓸 차례가 될 때까지 기다린다. 이미 쥐고 있으면 즉시 돌아온다
   * (같은 잡이 두 번 잡아도 리스가 겹치지 않는다).
   */
  acquire(jobId: string, options: AcquireOptions = {}): Promise<void> {
    if (this.holder?.jobId === jobId) return Promise.resolve();
    if (this.waiters.some((waiter) => waiter.jobId === jobId)) {
      return Promise.reject(new Error(`job '${jobId}' 가 이미 에디터를 기다리고 있습니다.`));
    }

    // 비어 있고, 정리 중도 아니고, 먼저 기다리던 잡도 없을 때만 바로 들어간다.
    // (먼저 온 잡을 제치지 않는다 — 선착순이 아니면 대기 순번 안내도 거짓말이 된다.)
    if (this.holder === null && !this.draining && this.waiters.length === 0) {
      this.takeHold(jobId, options);
      return Promise.resolve();
    }

    const waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        jobId,
        enqueuedAt: Date.now(),
        options,
        resolve,
        reject,
        timer: this.armTimer(waitTimeoutMs, () => this.timeOutWaiter(jobId, waitTimeoutMs)),
      };
      this.waiters.push(waiter);
      // 대기가 시작된 사실을 바로 알린다 — 화면에 "앞에 N건" 이 보여야 한다.
      options.onWait?.(this.aheadOf(waiter));
    });
  }

  /**
   * 리스를 반납한다. 쥐고 있지 않은 잡이 불러도 아무 일도 하지 않는다(멱등) —
   * 실패 경로마다 안심하고 부를 수 있어야 한다.
   */
  release(jobId: string): void {
    if (this.holder?.jobId !== jobId) return;
    clearTimeout(this.holder.timer);
    this.holder = null;
    this.promoteNext();
  }

  isHeldBy(jobId: string): boolean {
    return this.holder?.jobId === jobId;
  }

  /** 0 = 지금 쓰는 중, 1 이상 = 대기 순번, -1 = 큐에 없음. */
  position(jobId: string): number {
    if (this.holder?.jobId === jobId) return 0;
    const index = this.waiters.findIndex((waiter) => waiter.jobId === jobId);
    return index === -1 ? -1 : index + 1;
  }

  snapshot(): QueueSnapshot {
    return { holder: this.holder?.jobId ?? null, waiting: this.waiters.map((waiter) => waiter.jobId) };
  }

  /** 테스트용: 대기 중인 잡을 모두 깨워 거절하고 상태를 비운다. */
  reset(): void {
    if (this.holder) clearTimeout(this.holder.timer);
    this.holder = null;
    this.draining = false;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift() as Waiter;
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`job '${waiter.jobId}' 의 에디터 대기가 초기화됐습니다.`));
    }
  }

  private aheadOf(waiter: Waiter): number {
    // 앞에 있는 건수 = 지금 에디터를 붙잡고 있는 잡(쥔 잡이거나 정리 중인 잡) + 앞선 대기자 수
    const inFront = this.holder !== null || this.draining ? 1 : 0;
    return inFront + this.waiters.indexOf(waiter);
  }

  private armTimer(delayMs: number, onFire: () => void): ReturnType<typeof setTimeout> {
    const timer = setTimeout(onFire, delayMs);
    // 대기·점유 타이머가 프로세스 종료를 붙잡지 않게 한다.
    timer.unref?.();
    return timer;
  }

  private takeHold(jobId: string, options: AcquireOptions): void {
    const holdTimeoutMs = options.holdTimeoutMs ?? DEFAULT_HOLD_TIMEOUT_MS;
    this.holder = {
      jobId,
      onHoldExpired: options.onHoldExpired,
      timer: this.armTimer(holdTimeoutMs, () => {
        void this.expireHold(jobId);
      }),
    };
  }

  private timeOutWaiter(jobId: string, waitTimeoutMs: number): void {
    const index = this.waiters.findIndex((waiter) => waiter.jobId === jobId);
    if (index === -1) return;
    const [waiter] = this.waiters.splice(index, 1);
    clearTimeout(waiter.timer);
    waiter.reject(new EditorWaitTimeoutError(jobId, waitTimeoutMs));
    this.notifyWaiting();
  }

  private async expireHold(jobId: string): Promise<void> {
    if (this.holder?.jobId !== jobId) return;
    const { onHoldExpired } = this.holder;
    clearTimeout(this.holder.timer);
    this.holder = null;

    // 다음 잡을 들여보내기 전에 정리를 끝낸다 — 안 그러면 정리(탭 닫기)가 다음 잡이 막 연
    // 에디터를 닫아 버린다. 이 구간에 도착한 잡도 바로 들어오지 못하고 줄을 선다.
    this.draining = true;
    try {
      if (onHoldExpired) {
        await onHoldExpired();
      }
    } catch (err) {
      console.error(`[editor-queue] job '${jobId}' 의 점유 만료 정리에 실패했습니다:`, err);
    } finally {
      this.draining = false;
    }
    this.promoteNext();
  }

  private promoteNext(): void {
    // 불변식: 쥔 잡이 있는데 또 넘기면 리스가 둘이 된다. 어떤 경로로 불려도 여기서 막는다.
    if (this.holder !== null) return;
    const next = this.waiters.shift();
    if (!next) return;
    clearTimeout(next.timer);
    this.takeHold(next.jobId, next.options);
    next.resolve();
    this.notifyWaiting();
  }

  private notifyWaiting(): void {
    for (const waiter of this.waiters) {
      waiter.options.onWait?.(this.aheadOf(waiter));
    }
  }
}

interface QueueGlobal {
  [QUEUE_KEY]?: EditorQueue;
}

export function getEditorQueue(): EditorQueue {
  const slot = globalThis as unknown as QueueGlobal;
  slot[QUEUE_KEY] ??= new EditorQueue();
  return slot[QUEUE_KEY];
}

/** 테스트용: 큐를 비운다. */
export function resetEditorQueue(): void {
  getEditorQueue().reset();
}

export type { EditorQueue };
