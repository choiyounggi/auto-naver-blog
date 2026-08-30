import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/guard';
import { loadConfig } from '@/lib/config';
import { getJobStore } from '@/lib/job/store-instance';
import { runJob } from '@/lib/job/runner';
import {
  MAX_IMAGES_PER_JOB,
  MAX_IMAGE_BYTES,
  extensionFor,
  mimeTypeFor,
  resolveImagePathWithin,
  sniffImageType,
  type SniffedImageType,
} from '@/lib/job/upload';
import { PostInputSchema, type UploadedImage } from '@/lib/types';

export async function POST(request: Request): Promise<Response> {
  // 로그인한 사람만 잡을 만들 수 있다 — 이 잡의 소유자가 곧 그 세션이다.
  const guard = requireUser(request);
  if (!guard.ok) return guard.response;

  const config = loadConfig();
  const store = getJobStore();

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: 'invalid multipart form data' }, { status: 400 });
  }

  const categoryRaw = formData.get('category');
  const highlightsRaw = formData.get('highlights');
  if (typeof categoryRaw !== 'string' || typeof highlightsRaw !== 'string') {
    return NextResponse.json({ error: 'category and highlights are required text fields' }, { status: 400 });
  }

  // place 는 선택 입력이다 — 아예 없으면 빈 문자열로 본다. 값이 왔는데 텍스트가 아니면
  // (예: 파일이 실려 오면) 조용히 무시하지 않고 거부한다.
  const placeRaw = formData.get('place');
  if (placeRaw !== null && typeof placeRaw !== 'string') {
    return NextResponse.json({ error: 'place must be a text field' }, { status: 400 });
  }
  const place = (placeRaw ?? '').trim();

  const files = formData.getAll('images').filter((entry): entry is File => entry instanceof File);
  if (files.length === 0) {
    return NextResponse.json({ error: 'at least one image is required' }, { status: 400 });
  }
  // D3: 20장 상한 — 개수부터 먼저 거부한다 (파일 바이트를 읽기 전)
  if (files.length > MAX_IMAGES_PER_JOB) {
    return NextResponse.json({ error: `too many images (max ${MAX_IMAGES_PER_JOB})` }, { status: 400 });
  }
  // D3: 장당 10MB 상한 — File.size 메타데이터로, 바이트를 읽기(버퍼링하기) 전에 판정한다
  for (const file of files) {
    if (file.size > MAX_IMAGE_BYTES) {
      return NextResponse.json({ error: `image '${file.name}' exceeds ${MAX_IMAGE_BYTES} bytes` }, { status: 400 });
    }
  }

  // D1: 매직바이트로 실제 타입을 판정한다 — 여기서 처음으로 파일 바이트를 읽는다
  const prepared: { file: File; type: SniffedImageType; bytes: Uint8Array }[] = [];
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const type = sniffImageType(bytes);
    if (!type) {
      return NextResponse.json({ error: `image '${file.name}' is not a recognized image type` }, { status: 400 });
    }
    prepared.push({ file, type, bytes });
  }

  const jobId = randomUUID();
  const images: UploadedImage[] = [];
  for (let order = 0; order < prepared.length; order++) {
    const { file, type, bytes } = prepared[order];
    const imageId = randomUUID();
    const filename = `${imageId}.${extensionFor(type)}`;
    // D2: 서버가 생성한 이름으로, 판정된 실제 타입의 확장자로 저장한다
    const destPath = resolveImagePathWithin(config.dataDir, jobId, filename);
    await mkdir(path.dirname(destPath), { recursive: true });
    await writeFile(destPath, bytes);
    images.push({
      id: imageId,
      originalName: file.name,
      path: destPath,
      mimeType: mimeTypeFor(type),
      bytes: bytes.byteLength,
      width: null,
      height: null,
      order,
    });
  }

  // D5: 경계에서 zod로 한 번 검증한 뒤에만 내부로 넘긴다
  const parsed = PostInputSchema.safeParse({
    jobId,
    category: categoryRaw,
    highlights: highlightsRaw,
    place,
    images,
    createdAt: new Date().toISOString(),
  });
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid input', issues: parsed.error.issues }, { status: 400 });
  }

  // 소유자를 기록한다 — 다른 사람이 이 잡을 고치거나 발행할 수 없게 하는 근거다.
  const jobState = await store.create(parsed.data, guard.ctx.session.sid);

  // 잡 파이프라인을 백그라운드로 시작한다. awaiting_approval에서 반드시 멈추고
  // publisher.publish()는 절대 호출하지 않는다 (안전 계약, lib/job/runner.ts).
  runJob(store, jobId).catch((err: unknown) => {
    console.error(`POST /api/jobs: runJob failed unexpectedly for job '${jobId}':`, err);
  });

  return NextResponse.json(jobState, { status: 201 });
}
