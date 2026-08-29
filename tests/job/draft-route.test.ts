import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { PUT as putDraft } from '@/app/api/jobs/[id]/draft/route';
import { getJobStore, resetJobStore } from '@/lib/job/store-instance';
import type { PostDraft, PostInput } from '@/lib/types';

let dataDir: string;
let originalDataDir: string | undefined;

function makeInput(jobId: string, imageCount = 2): PostInput {
  return {
    jobId,
    category: '맛집 뿌시기',
    highlights: '하이라이트',
    place: '',
    images: Array.from({ length: imageCount }, (_, i) => ({
      id: `img-${i + 1}`,
      originalName: `p${i + 1}.jpg`,
      path: `/uploads/p${i + 1}.jpg`,
      mimeType: 'image/jpeg',
      bytes: 10,
      width: null,
      height: null,
      order: i,
    })),
    createdAt: '2026-08-29T00:00:00.000Z',
  };
}

function makeDraft(): PostDraft {
  return {
    title: '제목',
    intro: '인트로',
    blocks: [
      { imageId: 'img-1', heading: '', caption: '캡션1', altText: '대체1' },
      { imageId: 'img-2', heading: '', caption: '캡션2', altText: '대체2' },
    ],
    outro: '아웃트로',
    tags: ['태그'],
    topic: '맛집',
    thumbnailImageId: 'img-1',
    generatedAt: '2026-08-29T00:00:00.000Z',
    model: 'claude-test',
  };
}

async function seedAwaitingApproval(): Promise<string> {
  const jobId = randomUUID();
  const store = getJobStore();
  await store.create(makeInput(jobId));
  await store.patch(jobId, { draft: makeDraft(), editorDraft: makeDraft() });
  await store.transition(jobId, 'analyzing', 'x');
  await store.transition(jobId, 'drafting', 'x');
  await store.transition(jobId, 'draft_ready', 'x');
  await store.transition(jobId, 'filling_editor', 'x');
  await store.transition(jobId, 'awaiting_approval', 'x');
  return jobId;
}

function put(jobId: string, draft: unknown): Promise<Response> {
  return putDraft(
    new Request(`http://127.0.0.1/api/jobs/${jobId}/draft`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ draft }),
    }),
    { params: Promise.resolve({ id: jobId }) },
  );
}

beforeEach(async () => {
  // 보안 정책: /tmp·$TMPDIR 대신 프로젝트 내부 경로만 쓴다
  dataDir = path.join(process.cwd(), '.dev-loop', 'test-tmp', `draft-route-${randomUUID()}`);
  await mkdir(dataDir, { recursive: true });
  originalDataDir = process.env.ANB_DATA_DIR;
  process.env.ANB_DATA_DIR = dataDir;
  resetJobStore();
});

afterEach(async () => {
  resetJobStore();
  if (originalDataDir === undefined) delete process.env.ANB_DATA_DIR;
  else process.env.ANB_DATA_DIR = originalDataDir;
  await rm(dataDir, { recursive: true, force: true });
});

describe('PUT /api/jobs/[id]/draft — 정상', () => {
  test('고친 글을 저장한다', async () => {
    const jobId = await seedAwaitingApproval();
    const edited = { ...makeDraft(), title: '사람이 고친 제목' };

    const response = await put(jobId, edited);
    expect(response.status).toBe(200);
    expect((await response.json()).draft.title).toBe('사람이 고친 제목');
  });

  test('blocks 순서가 사진 순서를 정한다 — 입력의 order 도 다시 매긴다', async () => {
    const jobId = await seedAwaitingApproval();
    const edited = makeDraft();
    edited.blocks = [edited.blocks[1], edited.blocks[0]];
    edited.thumbnailImageId = 'img-2';

    const body = await (await put(jobId, edited)).json();
    expect(body.input.images.map((i: { id: string }) => i.id)).toEqual(['img-2', 'img-1']);
    expect(body.input.images.map((i: { order: number }) => i.order)).toEqual([0, 1]);
  });

  test('blocks 에서 뺀 사진은 입력에서도 빠진다', async () => {
    const jobId = await seedAwaitingApproval();
    const edited = makeDraft();
    edited.blocks = [edited.blocks[0]];

    const body = await (await put(jobId, edited)).json();
    expect(body.input.images.map((i: { id: string }) => i.id)).toEqual(['img-1']);
  });
});

describe('PUT /api/jobs/[id]/draft — 에러/경계값', () => {
  test('에러: 없는 잡이면 404', async () => {
    expect((await put('no-such-job', makeDraft())).status).toBe(404);
  });

  test('에러: 승인 대기 단계가 아니면 409', async () => {
    const jobId = randomUUID();
    await getJobStore().create(makeInput(jobId));
    expect((await put(jobId, makeDraft())).status).toBe(409);
  });

  test('에러: 초안 형식이 어긋나면 400', async () => {
    const jobId = await seedAwaitingApproval();
    expect((await put(jobId, { title: 1 })).status).toBe(400);
  });

  test('경계값: 사진을 전부 빼면 400', async () => {
    const jobId = await seedAwaitingApproval();
    const edited = makeDraft();
    edited.blocks = [];
    expect((await put(jobId, edited)).status).toBe(400);
  });

  test('에러: 없는 사진을 가리키면 400', async () => {
    const jobId = await seedAwaitingApproval();
    const edited = makeDraft();
    edited.blocks[0].imageId = 'img-없음';
    expect((await put(jobId, edited)).status).toBe(400);
  });

  test('에러: 같은 사진을 두 번 쓰면 400', async () => {
    const jobId = await seedAwaitingApproval();
    const edited = makeDraft();
    edited.blocks[1].imageId = 'img-1';
    expect((await put(jobId, edited)).status).toBe(400);
  });

  test('에러: 대표 이미지가 첫 사진이 아니면 400', async () => {
    const jobId = await seedAwaitingApproval();
    const edited = { ...makeDraft(), thumbnailImageId: 'img-2' };
    expect((await put(jobId, edited)).status).toBe(400);
  });
});
