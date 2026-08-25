import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { AppConfig } from '@/lib/config';
import { JobStore } from '@/lib/job/store';
import type { PostDraft, PostInput } from '@/lib/types';

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
    tags: [],
    topic: '일상',
    thumbnailImageId: 'img-0',
    generatedAt: new Date().toISOString(),
    model: 'claude',
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let dataDir: string;
let store: JobStore;

beforeEach(async () => {
  // 보안 정책: /tmp·$TMPDIR 금지 — 워크트리 내부 경로만 사용한다
  dataDir = path.join(process.cwd(), '.dev-loop', 'test-tmp', `store-${randomUUID()}`);
  await mkdir(dataDir, { recursive: true });
  store = new JobStore(makeConfig(dataDir));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('JobStore.create / get', () => {
  test('정상: create 후 get이 같은 잡을 돌려주고 phase가 created', async () => {
    await store.create(makeInput('job-a'));
    // 캐시가 아니라 디스크 영속화를 실제로 검증하기 위해 새 인스턴스로 읽는다
    const store2 = new JobStore(makeConfig(dataDir));
    const fetched = await store2.get('job-a');
    expect(fetched).not.toBeNull();
    expect(fetched?.id).toBe('job-a');
    expect(fetched?.phase).toBe('created');
    expect(fetched?.log).toEqual([]);
  });

  test('경계값: 존재하지 않는 id로 get하면 null을 반환한다', async () => {
    const result = await store.get('does-not-exist');
    expect(result).toBeNull();
  });

  test('에러: state.json이 깨진 JSON이면 get이 에러를 던진다 (null이 아님)', async () => {
    const jobId = 'job-corrupt';
    const jobDir = path.join(dataDir, 'jobs', jobId);
    await mkdir(jobDir, { recursive: true });
    await writeFile(path.join(jobDir, 'state.json'), '{not valid json', 'utf8');
    await expect(store.get(jobId)).rejects.toThrow();
  });

  test('에러: state.json이 JobStateSchema를 만족하지 않으면 get이 에러를 던진다', async () => {
    const jobId = 'job-schema-invalid';
    const jobDir = path.join(dataDir, 'jobs', jobId);
    await mkdir(jobDir, { recursive: true });
    await writeFile(path.join(jobDir, 'state.json'), JSON.stringify({ id: jobId }), 'utf8');
    await expect(store.get(jobId)).rejects.toThrow();
  });
});

describe('JobStore.transition', () => {
  test('정상: created→analyzing 전이 후 log 길이가 1 증가하고 updatedAt이 변한다', async () => {
    const created = await store.create(makeInput('job-b'));
    expect(created.log.length).toBe(0);
    const before = created.updatedAt;
    await sleep(5);
    const after = await store.transition('job-b', 'analyzing', '분석 시작');
    expect(after.phase).toBe('analyzing');
    expect(after.log.length).toBe(1);
    expect(after.log[0].message).toBe('분석 시작');
    expect(after.log[0].phase).toBe('analyzing');
    expect(after.updatedAt).not.toBe(before);
  });

  test('에러: 불법 전이(created→published)가 throw 한다', async () => {
    await store.create(makeInput('job-c'));
    await expect(store.transition('job-c', 'published', 'x')).rejects.toThrow();
  });

  test('에러: 존재하지 않는 id로 transition하면 throw 한다', async () => {
    await expect(store.transition('no-such-job', 'analyzing', 'x')).rejects.toThrow();
  });

  test('경계값: created 상태에서도 failed로 전이 가능하다', async () => {
    await store.create(makeInput('job-d1'));
    const after = await store.transition('job-d1', 'failed', 'boom');
    expect(after.phase).toBe('failed');
  });

  test('경계값: draft_ready 상태에서도 failed로 전이 가능하다', async () => {
    const jobId = 'job-d2';
    await store.create(makeInput(jobId));
    await store.transition(jobId, 'analyzing', 'x');
    await store.transition(jobId, 'drafting', 'x');
    await store.transition(jobId, 'draft_ready', 'x');
    const after = await store.transition(jobId, 'failed', 'boom');
    expect(after.phase).toBe('failed');
  });

  test('경계값: published 같은 터미널 상태에서 다시 전이하면 throw 한다', async () => {
    const jobId = 'job-e';
    await store.create(makeInput(jobId));
    await store.transition(jobId, 'analyzing', 'x');
    await store.transition(jobId, 'drafting', 'x');
    await store.transition(jobId, 'draft_ready', 'x');
    await store.transition(jobId, 'filling_editor', 'x');
    await store.transition(jobId, 'awaiting_approval', 'x');
    await store.transition(jobId, 'publishing', 'x');
    await store.transition(jobId, 'published', 'x');
    await expect(store.transition(jobId, 'failed', 'x')).rejects.toThrow();
  });

  test('경계값: 이미 failed인 잡을 다시 failed로 전이해도 throw 한다', async () => {
    const jobId = 'job-f';
    await store.create(makeInput(jobId));
    await store.transition(jobId, 'failed', 'first');
    await expect(store.transition(jobId, 'failed', 'second')).rejects.toThrow();
  });
});

describe('JobStore.patch / appendLog', () => {
  test('정상: patch가 draft 필드를 갱신한다', async () => {
    const jobId = 'job-patch';
    await store.create(makeInput(jobId));
    const draft = makeDraft();
    const after = await store.patch(jobId, { draft });
    expect(after.draft?.title).toBe('제목');
    expect(after.draft?.thumbnailImageId).toBe('img-0');
  });

  test('에러: 존재하지 않는 id로 patch하면 throw 한다', async () => {
    await expect(store.patch('nope', { draft: null })).rejects.toThrow();
  });

  test('정상: appendLog가 phase 변경 없이 로그만 추가한다', async () => {
    const jobId = 'job-log';
    const created = await store.create(makeInput(jobId));
    const after = await store.appendLog(jobId, '진행중...');
    expect(after.phase).toBe(created.phase);
    expect(after.log.length).toBe(1);
    expect(after.log[0].message).toBe('진행중...');
  });
});
