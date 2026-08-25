import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { loadConfig } from '@/lib/config';
import { getJobStore } from '@/lib/job/store-instance';
import { resolveImagePathWithin } from '@/lib/job/upload';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; imageId: string }> },
): Promise<Response> {
  const { id, imageId } = await params;
  const config = loadConfig();
  const store = getJobStore();

  let job;
  try {
    job = await store.get(id);
  } catch (err) {
    console.error(`GET /api/jobs/${id}/images/${imageId}: failed to read job state`, err);
    return NextResponse.json({ error: 'failed to read job state' }, { status: 500 });
  }
  if (!job) {
    return NextResponse.json({ error: `job '${id}' not found` }, { status: 404 });
  }

  const image = job.input.images.find((candidate) => candidate.id === imageId);
  if (!image) {
    return NextResponse.json({ error: `image '${imageId}' not found` }, { status: 404 });
  }

  // D4: 정규화 후 접두사 검증 — 저장된 경로의 파일명만 재사용해 재검증한다
  const filename = path.basename(image.path);
  let resolvedPath: string;
  try {
    resolvedPath = resolveImagePathWithin(config.dataDir, id, filename);
  } catch (err) {
    console.error(`GET /api/jobs/${id}/images/${imageId}: path resolution rejected`, err);
    return NextResponse.json({ error: 'invalid image path' }, { status: 400 });
  }

  let fileBytes: Buffer;
  try {
    fileBytes = await readFile(resolvedPath);
  } catch {
    return NextResponse.json({ error: 'image file not found on disk' }, { status: 404 });
  }

  return new Response(new Uint8Array(fileBytes), {
    headers: {
      'Content-Type': image.mimeType,
      'Content-Length': String(fileBytes.byteLength),
      'Cache-Control': 'private, max-age=3600',
    },
  });
}
