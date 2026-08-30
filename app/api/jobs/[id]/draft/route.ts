import { NextResponse } from 'next/server';
import { forbiddenIfNotOwner, requireUser } from '@/lib/auth/guard';
import { getJobStore } from '@/lib/job/store-instance';
import { PostDraftSchema, type UploadedImage } from '@/lib/types';

/**
 * 승인 화면에서 고친 초안을 저장한다.
 *
 * `blocks` 가 사진의 순서와 포함 여부를 정한다 — blocks 에 없는 사진은 글에서 빠진 것으로
 * 보고 입력에서도 제외한다. 그래야 화면에서 본 구조와 발행될 구조가 어긋나지 않는다.
 * 실제 반영은 발행할 때 일어난다(에디터를 이 내용대로 다시 채운다).
 */
export async function PUT(
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
  // 승인 대기 중일 때만 고칠 수 있다 — 발행이 시작된 뒤에 바꾸면 화면과 결과가 어긋난다.
  if (job.phase !== 'awaiting_approval') {
    return NextResponse.json(
      { error: `지금은 초안을 고칠 수 있는 단계가 아닙니다 (현재: ${job.phase})` },
      { status: 409 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const parsed = PostDraftSchema.safeParse((body as { draft?: unknown })?.draft);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid draft', issues: parsed.error.issues }, { status: 400 });
  }
  const draft = parsed.data;

  if (draft.blocks.length === 0) {
    return NextResponse.json({ error: '사진이 최소 한 장은 있어야 합니다.' }, { status: 400 });
  }

  // 존재하지 않는 사진을 가리키거나 같은 사진을 두 번 쓰는 것은 거부한다.
  const byId = new Map(job.input.images.map((image) => [image.id, image]));
  const seen = new Set<string>();
  const orderedImages: UploadedImage[] = [];
  for (const block of draft.blocks) {
    const image = byId.get(block.imageId);
    if (!image) {
      return NextResponse.json({ error: `사진 '${block.imageId}' 를 찾을 수 없습니다.` }, { status: 400 });
    }
    if (seen.has(block.imageId)) {
      return NextResponse.json({ error: `사진 '${block.imageId}' 가 두 번 쓰였습니다.` }, { status: 400 });
    }
    seen.add(block.imageId);
    orderedImages.push(image);
  }

  // 첫 사진이 대표라는 계약을 여기서도 지킨다.
  if (draft.thumbnailImageId !== draft.blocks[0].imageId) {
    return NextResponse.json(
      { error: '대표 이미지는 첫 번째 사진이어야 합니다.' },
      { status: 400 },
    );
  }

  const reindexed = orderedImages.map((image, order) => ({ ...image, order }));
  const updated = await store.patch(id, {
    draft,
    input: { ...job.input, images: reindexed },
  });
  return NextResponse.json(updated);
}
