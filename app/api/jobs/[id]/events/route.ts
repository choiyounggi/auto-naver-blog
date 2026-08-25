import { getJobStore } from '@/lib/job/store-instance';
import { eventsSince, formatEvent, parseLastEventId } from '@/lib/job/sse';
import type { JobPhase } from '@/lib/types';

const RETRY_MS = 2000;
const POLL_INTERVAL_MS = 500;
const TERMINAL_PHASES: ReadonlySet<JobPhase> = new Set(['published', 'failed', 'cancelled']);

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const store = getJobStore();

  const initialJob = await store.get(id);
  if (!initialJob) {
    return new Response(JSON.stringify({ error: `job '${id}' not found` }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // D6/D7: Last-Event-ID 헤더를 읽어 그 다음 인덱스부터 이어서 보낸다
  const lastEventId = parseLastEventId(request.headers.get('last-event-id'));
  const encoder = new TextEncoder();

  let cancelled = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // D6: 스트림 시작 시 retry를 한 번 보낸다
      controller.enqueue(encoder.encode(`retry: ${RETRY_MS}\n\n`));

      let cursor = lastEventId;

      // D8: 터미널 상태(published/failed/cancelled)에 도달하면 스트림을 끝낸다
      const flushPending = async (): Promise<'terminal' | 'missing' | 'continue'> => {
        let current;
        try {
          current = await store.get(id);
        } catch {
          return 'missing';
        }
        if (!current) return 'missing';

        const pending = eventsSince(current.log, cursor);
        for (const { id: eventId, entry } of pending) {
          controller.enqueue(encoder.encode(formatEvent(eventId, entry)));
          cursor = eventId;
        }
        return TERMINAL_PHASES.has(current.phase) ? 'terminal' : 'continue';
      };

      let outcome = await flushPending();
      while (outcome === 'continue' && !cancelled) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        if (cancelled) break;
        outcome = await flushPending();
      }

      if (!cancelled) {
        controller.close();
      }
    },
    cancel() {
      // D8: 클라이언트가 끊으면 폴링 루프를 정리한다 (스트림을 계속 붙잡지 않는다)
      cancelled = true;
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    },
  });
}
