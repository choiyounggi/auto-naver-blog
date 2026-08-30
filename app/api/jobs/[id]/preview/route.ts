import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { forbiddenIfNotOwner, requireUser } from '@/lib/auth/guard';
import { loadConfig } from '@/lib/config';
import { getJobStore } from '@/lib/job/store-instance';
import { getServices } from '@/lib/job/services';
import { assertSafeJobDir } from '@/lib/job/paths';
import { getEditorQueue } from '@/lib/job/queue';

/**
 * 미리보기 스크린샷 파일을 내려준다. 승인 화면이 <img> 로 읽는다.
 *
 * 경로는 잡 id 로만 만들고(사용자 입력을 그대로 붙이지 않는다), 데이터 디렉터리 밖으로
 * 벗어나지 않는지 검증한다 — 이미지 서빙 라우트와 같은 규칙이다.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guard = requireUser(request);
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const config = loadConfig();

  // 미리보기에는 글 전체가 찍혀 있다 — 파일을 읽기 전에 소유자를 확인한다.
  const job = await getJobStore().get(id);
  if (!job) {
    return NextResponse.json({ error: 'job not found' }, { status: 404 });
  }
  const forbidden = forbiddenIfNotOwner(guard.ctx, job);
  if (forbidden) return forbidden;

  let jobDir: string;
  try {
    jobDir = assertSafeJobDir(config.dataDir, id);
  } catch {
    return NextResponse.json({ error: 'invalid job id' }, { status: 400 });
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(path.join(jobDir, 'preview.png'));
  } catch {
    return NextResponse.json({ error: 'preview not found' }, { status: 404 });
  }

  return new Response(new Uint8Array(bytes), {
    headers: {
      'Content-Type': 'image/png',
      'Content-Length': String(bytes.byteLength),
      // 사람이 고친 뒤 다시 찍으면 즉시 바뀌어야 하므로 캐시하지 않는다.
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * 미리보기 스크린샷을 다시 찍는다.
 *
 * 승인 화면에서 쓴다 — 사람이 Aside 브라우저의 에디터에서 본문·사진을 직접 고친 뒤,
 * 무엇이 발행될지 다시 확인하기 위한 것이다. 에디터를 건드리지 않으므로 발행 여부에
 * 영향이 없고, 발행은 여전히 승인 버튼으로만 시작된다.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guard = requireUser(request);
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const store = getJobStore();

  const job = await store.get(id);
  if (!job) {
    return NextResponse.json({ error: 'job not found' }, { status: 404 });
  }
  const forbidden = forbiddenIfNotOwner(guard.ctx, job);
  if (forbidden) return forbidden;
  // 승인 대기 중일 때만 의미가 있다 — 그 밖의 단계에서는 에디터가 열려 있다고 볼 수 없다.
  if (job.phase !== 'awaiting_approval') {
    return NextResponse.json(
      { error: `미리보기를 다시 찍을 수 있는 단계가 아닙니다 (현재: ${job.phase})` },
      { status: 409 },
    );
  }
  // 이 잡이 에디터를 쥐고 있을 때만 찍는다 — 아니면 남의 화면을 찍어 이 잡에 저장하게 된다.
  if (!getEditorQueue().isHeldBy(id)) {
    return NextResponse.json(
      { error: '이 잡이 에디터를 쓰고 있지 않습니다 — 대기 시간이 지나 반납됐거나 서버가 다시 시작됐습니다.' },
      { status: 409 },
    );
  }

  try {
    const preview = await getServices().publisher.refreshPreview(job.input);
    const updated = await store.patch(id, { preview });
    return NextResponse.json(updated);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '미리보기를 다시 찍지 못했습니다.' },
      { status: 500 },
    );
  }
}
