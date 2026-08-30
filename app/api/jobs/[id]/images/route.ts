import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { forbiddenIfNotOwner, requireUser } from '@/lib/auth/guard';
import { loadConfig } from '@/lib/config';
import { getJobStore } from '@/lib/job/store-instance';
import {
  MAX_IMAGES_PER_JOB,
  MAX_IMAGE_BYTES,
  extensionFor,
  mimeTypeFor,
  resolveImagePathWithin,
  sniffImageType,
} from '@/lib/job/upload';
import type { UploadedImage } from '@/lib/types';

/**
 * 승인 화면에서 사진을 더 넣는다. 검증 규칙은 잡을 만들 때와 같다 — 개수·용량을 먼저 보고,
 * 매직바이트로 실제 이미지인지 확인한 뒤, 서버가 만든 이름으로 저장한다.
 *
 * 여기서는 사진만 추가한다. 글의 어느 자리에 들어갈지는 초안의 blocks 가 정하므로,
 * 화면이 이 응답으로 받은 id 로 블록을 만들어 `PUT /api/jobs/[id]/draft` 로 저장한다.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guard = requireUser(request);
  if (!guard.ok) return guard.response;

  const { id } = await params;
  const config = loadConfig();
  const store = getJobStore();

  const job = await store.get(id);
  if (!job) {
    return NextResponse.json({ error: 'job not found' }, { status: 404 });
  }
  const forbidden = forbiddenIfNotOwner(guard.ctx, job);
  if (forbidden) return forbidden;
  if (job.phase !== 'awaiting_approval') {
    return NextResponse.json(
      { error: `지금은 사진을 추가할 수 있는 단계가 아닙니다 (현재: ${job.phase})` },
      { status: 409 },
    );
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: 'invalid multipart form data' }, { status: 400 });
  }

  const files = formData.getAll('images').filter((entry): entry is File => entry instanceof File);
  if (files.length === 0) {
    return NextResponse.json({ error: 'at least one image is required' }, { status: 400 });
  }
  if (job.input.images.length + files.length > MAX_IMAGES_PER_JOB) {
    return NextResponse.json(
      { error: `사진은 최대 ${MAX_IMAGES_PER_JOB}장까지입니다 (현재 ${job.input.images.length}장).` },
      { status: 400 },
    );
  }
  for (const file of files) {
    if (file.size > MAX_IMAGE_BYTES) {
      return NextResponse.json({ error: `image '${file.name}' exceeds ${MAX_IMAGE_BYTES} bytes` }, { status: 400 });
    }
  }

  const added: UploadedImage[] = [];
  let order = job.input.images.length;
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const type = sniffImageType(bytes);
    if (!type) {
      return NextResponse.json({ error: `image '${file.name}' is not a recognized image type` }, { status: 400 });
    }

    const imageId = randomUUID();
    const filename = `${imageId}.${extensionFor(type)}`;
    const destPath = resolveImagePathWithin(config.dataDir, id, filename);
    await mkdir(path.dirname(destPath), { recursive: true });
    await writeFile(destPath, bytes);

    added.push({
      id: imageId,
      originalName: file.name,
      path: destPath,
      mimeType: mimeTypeFor(type),
      bytes: bytes.byteLength,
      width: null,
      height: null,
      order,
    });
    order += 1;
  }

  const updated = await store.patch(id, {
    input: { ...job.input, images: [...job.input.images, ...added] },
  });
  return NextResponse.json({ job: updated, added });
}
