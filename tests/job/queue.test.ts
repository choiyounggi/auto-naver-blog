import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  DEFAULT_HOLD_TIMEOUT_MS,
  DEFAULT_WAIT_TIMEOUT_MS,
  EditorWaitTimeoutError,
  getEditorQueue,
  resetEditorQueue,
} from '@/lib/job/queue';

// 실제 타이머를 쓰되 아주 짧은 값을 넘긴다 — 큐에 시계를 주입하지 않기 위해서다.
const TINY = 30;

function tick(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(() => {
  resetEditorQueue();
});

afterEach(() => {
  resetEditorQueue();
});

describe('에디터 큐 — 정상', () => {
  test('아무도 안 쓰면 즉시 잡는다', async () => {
    const queue = getEditorQueue();
    await queue.acquire('job-a');
    expect(queue.isHeldBy('job-a')).toBe(true);
    expect(queue.position('job-a')).toBe(0);
    expect(queue.snapshot()).toEqual({ holder: 'job-a', waiting: [] });
  });

  test('앞 잡이 반납할 때까지 뒤 잡은 시작하지 않는다 (완료 기준 4)', async () => {
    const queue = getEditorQueue();
    await queue.acquire('job-a');

    const order: string[] = [];
    const second = queue.acquire('job-b').then(() => order.push('b-started'));

    await tick(TINY);
    expect(order).toEqual([]);
    expect(queue.isHeldBy('job-a')).toBe(true);
    expect(queue.position('job-b')).toBe(1);

    order.push('a-released');
    queue.release('job-a');
    await second;

    expect(order).toEqual(['a-released', 'b-started']);
    expect(queue.isHeldBy('job-b')).toBe(true);
  });

  test('여러 잡이 기다리면 들어온 순서대로 들어간다', async () => {
    const queue = getEditorQueue();
    await queue.acquire('job-a');

    const started: string[] = [];
    const b = queue.acquire('job-b').then(() => started.push('job-b'));
    const c = queue.acquire('job-c').then(() => started.push('job-c'));
    await tick(TINY);
    expect(queue.snapshot().waiting).toEqual(['job-b', 'job-c']);

    queue.release('job-a');
    await b;
    expect(started).toEqual(['job-b']);
    queue.release('job-b');
    await c;
    expect(started).toEqual(['job-b', 'job-c']);
  });

  test('대기하는 동안 앞에 몇 건 남았는지 알려 준다', async () => {
    const queue = getEditorQueue();
    await queue.acquire('job-a');

    const seen: number[] = [];
    const c = queue.acquire('job-c', { onWait: (ahead) => seen.push(ahead) });
    await tick(TINY);
    // job-c 앞에는 job-a(사용 중) 하나뿐이다
    expect(seen).toEqual([1]);

    queue.release('job-a');
    await c;
    expect(seen).toEqual([1]);
  });

  test('앞 잡이 빠지면 남은 대기자의 순번이 앞당겨진다', async () => {
    const queue = getEditorQueue();
    await queue.acquire('job-a');

    const seen: number[] = [];
    // afterEach 의 초기화가 대기자를 거절하므로, 기다리기만 하는 잡은 거절을 삼켜 둔다.
    const ignore = () => {};
    queue.acquire('job-b').catch(ignore);
    queue.acquire('job-c', { onWait: (ahead) => seen.push(ahead) }).catch(ignore);
    await tick(TINY);
    expect(seen).toEqual([2]);

    queue.release('job-a'); // job-b 가 들어가고 job-c 는 한 칸 앞당겨진다
    await tick(TINY);
    expect(seen).toEqual([2, 1]);
  });

  test('같은 잡이 두 번 잡아도 리스가 겹치지 않는다', async () => {
    const queue = getEditorQueue();
    await queue.acquire('job-a');
    await queue.acquire('job-a');
    expect(queue.snapshot()).toEqual({ holder: 'job-a', waiting: [] });
  });
});

describe('에디터 큐 — 에러/경계값', () => {
  test('대기가 너무 길어지면 거절하고 사유를 남긴다', async () => {
    const queue = getEditorQueue();
    await queue.acquire('job-a');

    await expect(queue.acquire('job-b', { waitTimeoutMs: TINY })).rejects.toBeInstanceOf(EditorWaitTimeoutError);
    // 거절된 잡은 큐에서 빠지고, 쥐고 있던 잡은 그대로다 — 에디터를 빼앗지 않는다.
    expect(queue.position('job-b')).toBe(-1);
    expect(queue.isHeldBy('job-a')).toBe(true);
  });

  test('한 잡이 거절돼도 뒤의 잡은 차례를 지킨다', async () => {
    const queue = getEditorQueue();
    await queue.acquire('job-a');

    const rejected = queue.acquire('job-b', { waitTimeoutMs: TINY });
    const waiting = queue.acquire('job-c', { waitTimeoutMs: 10_000 });

    await expect(rejected).rejects.toBeInstanceOf(EditorWaitTimeoutError);
    queue.release('job-a');
    await waiting;
    expect(queue.isHeldBy('job-c')).toBe(true);
  });

  test('점유가 너무 길어지면 강제로 반납하고, 정리가 끝난 뒤 다음 잡을 들여보낸다', async () => {
    const queue = getEditorQueue();
    const events: string[] = [];

    await queue.acquire('job-a', {
      holdTimeoutMs: TINY,
      onHoldExpired: async () => {
        events.push('cleanup-start');
        await tick(TINY);
        events.push('cleanup-done');
      },
    });
    const next = queue.acquire('job-b').then(() => events.push('b-started'));

    await next;
    // 정리가 끝나기 전에 다음 잡이 시작하면 버려진 탭을 닫다가 새 에디터를 닫게 된다.
    expect(events).toEqual(['cleanup-start', 'cleanup-done', 'b-started']);
    expect(queue.isHeldBy('job-b')).toBe(true);
  });

  // 리뷰에서 잡힌 경합: 정리 중에는 holder 가 null 이라, holder 만 보고 판단하면 그때 도착한
  // 잡이 줄을 건너뛰어 들어가고 — 정리가 끝나면 promoteNext 가 대기자에게도 리스를 줘서
  // **둘이 동시에** 에디터를 만지게 된다. 이 큐가 막으려던 바로 그 상황이다.
  test('경계값: 점유 만료 정리 중에 도착한 잡은 새치기하지 못하고, 리스는 끝까지 하나다', async () => {
    const queue = getEditorQueue();
    const entered: string[] = [];

    await queue.acquire('job-abandoned', {
      holdTimeoutMs: TINY,
      onHoldExpired: async () => {
        await tick(TINY * 3);
      },
    });
    const b = queue.acquire('job-b').then(() => entered.push('job-b'));

    // 점유가 만료돼 정리가 도는 한가운데를 노린다.
    await tick(TINY + 5);
    expect(queue.snapshot().holder).toBeNull();

    const c = queue.acquire('job-c').then(() => entered.push('job-c'));
    await tick(1);
    // 정리가 끝나기 전에는 아무도 들어가지 않는다.
    expect(entered).toEqual([]);

    await b;
    // 먼저 기다리던 job-b 가 들어가고, job-c 는 여전히 줄에 있다 — 리스는 하나뿐이다.
    expect(entered).toEqual(['job-b']);
    expect(queue.snapshot()).toEqual({ holder: 'job-b', waiting: ['job-c'] });
    expect(queue.isHeldBy('job-c')).toBe(false);

    queue.release('job-b');
    await c;
    expect(entered).toEqual(['job-b', 'job-c']);
    expect(queue.snapshot()).toEqual({ holder: 'job-c', waiting: [] });
  });

  test('경계값: 기다리는 잡이 있으면 새로 온 잡이 먼저 들어가지 않는다', async () => {
    const queue = getEditorQueue();
    const entered: string[] = [];
    await queue.acquire('job-a');
    const b = queue.acquire('job-b').then(() => entered.push('job-b'));
    const c = queue.acquire('job-c').then(() => entered.push('job-c'));

    queue.release('job-a');
    await b;
    expect(entered).toEqual(['job-b']);
    queue.release('job-b');
    await c;
    expect(entered).toEqual(['job-b', 'job-c']);
  });

  test('정리 콜백이 던져도 다음 잡은 들어간다', async () => {
    const queue = getEditorQueue();
    await queue.acquire('job-a', {
      holdTimeoutMs: TINY,
      onHoldExpired: () => {
        throw new Error('탭 정리 실패');
      },
    });
    await queue.acquire('job-b');
    expect(queue.isHeldBy('job-b')).toBe(true);
  });

  test('이미 기다리는 잡이 또 기다리려 하면 거절한다', async () => {
    const queue = getEditorQueue();
    await queue.acquire('job-a');
    queue.acquire('job-b').catch(() => {});
    await expect(queue.acquire('job-b')).rejects.toThrow(/이미 에디터를 기다리고/);
  });

  test('쥐고 있지 않은 잡의 반납은 아무 일도 하지 않는다 (멱등)', async () => {
    const queue = getEditorQueue();
    await queue.acquire('job-a');
    queue.release('job-b');
    queue.release('job-a');
    queue.release('job-a');
    expect(queue.snapshot()).toEqual({ holder: null, waiting: [] });
  });

  test('큐가 비어 있을 때의 조회는 빈 값이다 (경계값)', () => {
    const queue = getEditorQueue();
    expect(queue.isHeldBy('없는-잡')).toBe(false);
    expect(queue.position('없는-잡')).toBe(-1);
    expect(queue.snapshot()).toEqual({ holder: null, waiting: [] });
  });

  test('기본 대기·점유 제한은 10분·30분이다', () => {
    expect(DEFAULT_WAIT_TIMEOUT_MS).toBe(10 * 60_000);
    expect(DEFAULT_HOLD_TIMEOUT_MS).toBe(30 * 60_000);
  });
});
