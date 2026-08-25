import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { AppConfig } from '@/lib/config';
import { JobStore } from '@/lib/job/store';
import { getServices, resetServices, setServices } from '@/lib/job/services';
import { approveAndPublish, runJob } from '@/lib/job/runner';
import type {
  ContentGeneratorApi,
  EditorPreview,
  NaverPublisherApi,
  PostDraft,
  PostInput,
  ProgressFn,
  PublishResult,
} from '@/lib/types';

function makeConfig(dataDir: string): AppConfig {
  return {
    dataDir,
    claudeBin: 'claude',
    asideBin: 'aside',
    naverBlogId: null,
    cookieFile: path.join(dataDir, 'naver-cookies.json'),
    claudeTimeoutMs: 600000,
    asideStepTimeoutMs: 60000,
  };
}

function makeInput(jobId: string): PostInput {
  return {
    jobId,
    category: '일상',
    highlights: '오늘 다녀온 카페',
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
  callCount = 0;
  shouldThrow = false;

  async generate(_input: PostInput, onProgress?: ProgressFn): Promise<PostDraft> {
    this.callCount++;
    onProgress?.('이미지 분석 중');
    if (this.shouldThrow) throw new Error('generate boom');
    return makeDraft();
  }
}

class FakePublisher implements NaverPublisherApi {
  fillEditorCallCount = 0;
  publishCallCount = 0;
  shouldThrowOnFill = false;
  publishResult: PublishResult = {
    ok: true,
    postUrl: 'https://blog.naver.com/x/1',
    publishedAt: new Date().toISOString(),
    message: '발행 완료',
  };

  async fillEditor(_draft: PostDraft, _input: PostInput, onProgress?: ProgressFn): Promise<EditorPreview> {
    this.fillEditorCallCount++;
    onProgress?.('에디터에 채우는 중');
    if (this.shouldThrowOnFill) throw new Error('fillEditor boom');
    return { screenshotPath: '/data/jobs/x/preview.png', editorUrl: 'https://blog.naver.com/PostWriteForm.naver' };
  }

  async publish(): Promise<PublishResult> {
    this.publishCallCount++;
    return this.publishResult;
  }

  async abort(): Promise<void> {}
}

let dataDir: string;
let store: JobStore;
let generator: FakeGenerator;
let publisher: FakePublisher;

beforeEach(async () => {
  // 보안 정책: /tmp·$TMPDIR 금지 — 워크트리 내부 경로만 사용한다
  dataDir = path.join(process.cwd(), '.dev-loop', 'test-tmp', `runner-${randomUUID()}`);
  await mkdir(dataDir, { recursive: true });
  store = new JobStore(makeConfig(dataDir));
  generator = new FakeGenerator();
  publisher = new FakePublisher();
  setServices({ generator, publisher });
});

afterEach(async () => {
  resetServices();
  await rm(dataDir, { recursive: true, force: true });
});

describe('runJob — 안전 계약', () => {
  test('안전 계약 1: runJob 완료 후 phase가 awaiting_approval이고 publish 호출 횟수가 0이다', async () => {
    const jobId = 'job-1';
    await store.create(makeInput(jobId));
    await runJob(store, jobId);
    const state = await store.get(jobId);
    expect(state?.phase).toBe('awaiting_approval');
    expect(publisher.publishCallCount).toBe(0);
    expect(publisher.fillEditorCallCount).toBe(1);
    expect(generator.callCount).toBe(1);
  });
});

describe('approveAndPublish — 안전 계약', () => {
  test('안전 계약 2: awaiting_approval이 아닌 상태에서 approveAndPublish가 throw하고 publish 호출 횟수가 0이다', async () => {
    const jobId = 'job-2';
    await store.create(makeInput(jobId));
    await store.transition(jobId, 'analyzing', 'x');
    await store.transition(jobId, 'drafting', 'x');
    await store.transition(jobId, 'draft_ready', 'x');
    await expect(approveAndPublish(store, jobId)).rejects.toThrow();
    expect(publisher.publishCallCount).toBe(0);
  });

  test('안전 계약 3: awaiting_approval에서 approveAndPublish를 부르면 publish가 정확히 1회 불리고 phase가 published가 된다', async () => {
    const jobId = 'job-3';
    await store.create(makeInput(jobId));
    await runJob(store, jobId);
    const result = await approveAndPublish(store, jobId);
    expect(publisher.publishCallCount).toBe(1);
    expect(result.ok).toBe(true);
    const state = await store.get(jobId);
    expect(state?.phase).toBe('published');
  });

  test('경계값: approveAndPublish를 연속 두 번 부르면 두 번째는 throw하고 publish 총 호출 횟수가 1로 유지된다', async () => {
    const jobId = 'job-4';
    await store.create(makeInput(jobId));
    await runJob(store, jobId);
    await approveAndPublish(store, jobId);
    await expect(approveAndPublish(store, jobId)).rejects.toThrow();
    expect(publisher.publishCallCount).toBe(1);
  });

  test('경계값: publisher.publish가 ok:false를 돌려주면 phase가 failed가 된다', async () => {
    const jobId = 'job-5';
    await store.create(makeInput(jobId));
    await runJob(store, jobId);
    publisher.publishResult = { ok: false, postUrl: null, publishedAt: null, message: '네이버 오류' };
    const result = await approveAndPublish(store, jobId);
    expect(result.ok).toBe(false);
    const state = await store.get(jobId);
    expect(state?.phase).toBe('failed');
    expect(state?.error?.step).toBe('publish');
  });

  test('에러: publisher.publish가 throw하면 phase가 failed이고 에러가 다시 던져진다', async () => {
    const jobId = 'job-8';
    await store.create(makeInput(jobId));
    await runJob(store, jobId);
    publisher.publish = async () => {
      publisher.publishCallCount++;
      throw new Error('publish network boom');
    };
    await expect(approveAndPublish(store, jobId)).rejects.toThrow('publish network boom');
    expect(publisher.publishCallCount).toBe(1);
    const state = await store.get(jobId);
    expect(state?.phase).toBe('failed');
    expect(state?.error?.step).toBe('publish');
  });
});

describe('runJob — 에러 처리', () => {
  test('에러: generator.generate가 throw하면 phase가 failed이고 error.step이 생성 단계를 가리킨다', async () => {
    const jobId = 'job-6';
    await store.create(makeInput(jobId));
    generator.shouldThrow = true;
    await runJob(store, jobId);
    const state = await store.get(jobId);
    expect(state?.phase).toBe('failed');
    expect(state?.error?.step).toBe('generate');
    expect(publisher.fillEditorCallCount).toBe(0);
    expect(publisher.publishCallCount).toBe(0);
  });

  test('에러: publisher.fillEditor가 throw하면 phase가 failed이고 error.step이 에디터 단계를 가리킨다', async () => {
    const jobId = 'job-7';
    await store.create(makeInput(jobId));
    publisher.shouldThrowOnFill = true;
    await runJob(store, jobId);
    const state = await store.get(jobId);
    expect(state?.phase).toBe('failed');
    expect(state?.error?.step).toBe('fillEditor');
    expect(publisher.publishCallCount).toBe(0);
  });
});

describe('getServices', () => {
  test('에러: getServices()가 미주입 상태에서 명확한 메시지로 throw한다', () => {
    resetServices();
    expect(() => getServices()).toThrow(/setServices/i);
  });
});
