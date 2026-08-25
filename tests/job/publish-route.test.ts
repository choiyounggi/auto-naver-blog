import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { POST as postPublish } from '@/app/api/jobs/[id]/publish/route';
import { resetServices, setServices } from '@/lib/job/services';
import { getJobStore, resetJobStore } from '@/lib/job/store-instance';
import { PublishResultSchema } from '@/lib/types';
import type {
  ContentGeneratorApi,
  EditorPreview,
  NaverPublisherApi,
  PostDraft,
  PostInput,
  ProgressFn,
  PublishResult,
} from '@/lib/types';

function makeInput(jobId: string): PostInput {
  return {
    jobId,
    category: '일상',
    highlights: '오늘 다녀온 카페',
    place: '',
    images: [
      {
        id: 'img-0',
        originalName: 'a.jpg',
        path: `/data/jobs/${jobId}/images/img-0.jpg`,
        mimeType: 'image/jpeg',
        bytes: 123,
        width: 10,
        height: 10,
        order: 0,
      },
    ],
    createdAt: new Date().toISOString(),
  };
}

function makeDraft(): PostDraft {
  return {
    title: '제목',
    intro: '인트로',
    blocks: [],
    outro: '아웃트로',
    tags: ['일상'],
    topic: '일상',
    thumbnailImageId: 'img-0',
    generatedAt: new Date().toISOString(),
    model: 'claude',
  };
}

class FakeGenerator implements ContentGeneratorApi {
  async generate(_input: PostInput, onProgress?: ProgressFn): Promise<PostDraft> {
    onProgress?.('분석 중');
    return makeDraft();
  }
}

class FakePublisher implements NaverPublisherApi {
  publishCallCount = 0;
  shouldThrow = false;
  publishResult: PublishResult = {
    ok: true,
    postUrl: 'https://blog.naver.com/x/1',
    publishedAt: new Date().toISOString(),
    message: '발행 완료',
  };

  async fillEditor(_draft: PostDraft, _input: PostInput, onProgress?: ProgressFn): Promise<EditorPreview> {
    onProgress?.('에디터 채우는 중');
    return { screenshotPath: '/data/jobs/x/preview.png', editorUrl: 'https://blog.naver.com/PostWriteForm.naver' };
  }

  async publish(): Promise<PublishResult> {
    this.publishCallCount++;
    if (this.shouldThrow) throw new Error('naver network boom');
    return this.publishResult;
  }

  async abort(): Promise<void> {}
}

let dataDir: string;
let originalDataDir: string | undefined;
let publisher: FakePublisher;

async function makeRequest(jobId: string): Promise<Response> {
  return postPublish(new Request(`http://127.0.0.1/api/jobs/${jobId}/publish`, { method: 'POST' }), {
    params: Promise.resolve({ id: jobId }),
  });
}

beforeEach(async () => {
  // 보안 정책: /tmp·$TMPDIR 금지 — 워크트리 내부 경로만 사용한다
  dataDir = path.join(process.cwd(), '.dev-loop', 'test-tmp', `publish-route-${randomUUID()}`);
  await mkdir(dataDir, { recursive: true });
  originalDataDir = process.env.ANB_DATA_DIR;
  process.env.ANB_DATA_DIR = dataDir;
  resetJobStore();

  publisher = new FakePublisher();
  setServices({ generator: new FakeGenerator(), publisher });
});

afterEach(async () => {
  resetServices();
  resetJobStore();
  if (originalDataDir === undefined) {
    delete process.env.ANB_DATA_DIR;
  } else {
    process.env.ANB_DATA_DIR = originalDataDir;
  }
  await rm(dataDir, { recursive: true, force: true });
});

describe('POST /api/jobs/[id]/publish', () => {
  test('정상: awaiting_approval 상태면 200, publish 호출 1회, 응답이 PublishResultSchema를 만족한다', async () => {
    const jobId = 'job-1';
    const store = getJobStore();
    await store.create(makeInput(jobId));
    await store.transition(jobId, 'analyzing', 'x');
    await store.transition(jobId, 'drafting', 'x');
    await store.transition(jobId, 'draft_ready', 'x');
    await store.transition(jobId, 'filling_editor', 'x');
    await store.transition(jobId, 'awaiting_approval', 'x');

    const response = await makeRequest(jobId);
    expect(response.status).toBe(200);
    expect(publisher.publishCallCount).toBe(1);
    const body = await response.json();
    expect(PublishResultSchema.safeParse(body).success).toBe(true);

    const finalState = await store.get(jobId);
    expect(finalState?.phase).toBe('published');
  });

  test('안전 계약(핵심): phase가 draft_ready면 409, publish 호출 0회', async () => {
    const jobId = 'job-2';
    const store = getJobStore();
    await store.create(makeInput(jobId));
    await store.transition(jobId, 'analyzing', 'x');
    await store.transition(jobId, 'drafting', 'x');
    await store.transition(jobId, 'draft_ready', 'x');

    const response = await makeRequest(jobId);
    expect(response.status).toBe(409);
    expect(publisher.publishCallCount).toBe(0);
  });

  test('안전 계약: phase가 created면 409, publish 호출 0회', async () => {
    const jobId = 'job-3';
    const store = getJobStore();
    await store.create(makeInput(jobId));

    const response = await makeRequest(jobId);
    expect(response.status).toBe(409);
    expect(publisher.publishCallCount).toBe(0);
  });

  test('안전 계약: phase가 이미 published면 409, publish 호출 0회', async () => {
    const jobId = 'job-4';
    const store = getJobStore();
    await store.create(makeInput(jobId));
    await store.transition(jobId, 'analyzing', 'x');
    await store.transition(jobId, 'drafting', 'x');
    await store.transition(jobId, 'draft_ready', 'x');
    await store.transition(jobId, 'filling_editor', 'x');
    await store.transition(jobId, 'awaiting_approval', 'x');
    await store.transition(jobId, 'publishing', 'x');
    await store.transition(jobId, 'published', 'x');

    const response = await makeRequest(jobId);
    expect(response.status).toBe(409);
    expect(publisher.publishCallCount).toBe(0);
  });

  test('에러: 존재하지 않는 jobId는 404, publish 호출 0회', async () => {
    const response = await makeRequest('no-such-job');
    expect(response.status).toBe(404);
    expect(publisher.publishCallCount).toBe(0);
  });

  test('에러: approveAndPublish가 throw하면 500이고 응답에 스택 트레이스가 없다', async () => {
    const jobId = 'job-5';
    const store = getJobStore();
    await store.create(makeInput(jobId));
    await store.transition(jobId, 'analyzing', 'x');
    await store.transition(jobId, 'drafting', 'x');
    await store.transition(jobId, 'draft_ready', 'x');
    await store.transition(jobId, 'filling_editor', 'x');
    await store.transition(jobId, 'awaiting_approval', 'x');
    publisher.shouldThrow = true;

    const response = await makeRequest(jobId);
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain('naver network boom');
    expect(text.toLowerCase()).not.toContain('at object.');
    expect(text.toLowerCase()).not.toContain('.ts:');
  });

  test('경계값: 같은 잡에 연속 두 번 POST하면 첫 번째만 200, 두 번째는 409, publish 총 호출 1회', async () => {
    const jobId = 'job-6';
    const store = getJobStore();
    await store.create(makeInput(jobId));
    await store.transition(jobId, 'analyzing', 'x');
    await store.transition(jobId, 'drafting', 'x');
    await store.transition(jobId, 'draft_ready', 'x');
    await store.transition(jobId, 'filling_editor', 'x');
    await store.transition(jobId, 'awaiting_approval', 'x');

    const first = await makeRequest(jobId);
    const second = await makeRequest(jobId);
    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(publisher.publishCallCount).toBe(1);
  });

  test('경계값: 빈 문자열 id는 400', async () => {
    const response = await postPublish(new Request('http://127.0.0.1/api/jobs//publish', { method: 'POST' }), {
      params: Promise.resolve({ id: '' }),
    });
    expect(response.status).toBe(400);
    expect(publisher.publishCallCount).toBe(0);
  });
});
