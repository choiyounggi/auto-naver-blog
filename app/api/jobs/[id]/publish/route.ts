import { NextResponse } from 'next/server';
import { forbiddenIfNotOwner, requireUser } from '@/lib/auth/guard';
import { EditorNotHeldError } from '@/lib/job/queue';
import { approveAndPublish } from '@/lib/job/runner';
import { getJobStore } from '@/lib/job/store-instance';

// D14/안전 계약: 발행을 시작할 수 있는 유일한 HTTP 표면. 다른 어떤 라우트도
// approveAndPublish나 publisher.publish를 부르지 않는다.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guard = requireUser(request);
  if (!guard.ok) return guard.response;

  const { id } = await params;
  if (id.length === 0) {
    return NextResponse.json({ error: 'invalid job id' }, { status: 400 });
  }

  const store = getJobStore();

  let job;
  try {
    job = await store.get(id);
  } catch (err) {
    console.error(`POST /api/jobs/${id}/publish: failed to read job state`, err);
    return NextResponse.json({ error: 'failed to read job state' }, { status: 500 });
  }

  if (!job) {
    return NextResponse.json({ error: `job '${id}' not found` }, { status: 404 });
  }

  // 남의 잡은 발행할 수 없다 — 발행은 되돌릴 수 없으므로 소유자 검사를 단계 검사보다 먼저 한다.
  const forbidden = forbiddenIfNotOwner(guard.ctx, job);
  if (forbidden) return forbidden;

  // D13/D14: awaiting_approval이 아니면 여기서 거부한다 — approveAndPublish는 호출하지 않는다.
  if (job.phase !== 'awaiting_approval') {
    return NextResponse.json(
      { error: `job '${id}' is not awaiting approval`, phase: job.phase },
      { status: 409 },
    );
  }

  try {
    const result = await approveAndPublish(store, id);
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    // 에디터를 쥐고 있지 않은 상태는 사용자가 이해하고 다시 시도할 수 있는 상황이다 —
    // 서버 오류(500)가 아니라 상태 충돌(409)로 알린다.
    if (err instanceof EditorNotHeldError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    // 스택 트레이스를 응답에 노출하지 않는다 — 서버 로그에만 남긴다
    console.error(`POST /api/jobs/${id}/publish: approveAndPublish failed`, err);
    return NextResponse.json({ error: 'failed to publish' }, { status: 500 });
  }
}
