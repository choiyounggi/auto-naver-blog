import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { GET as getEvents } from '@/app/api/jobs/[id]/events/route';
import { getJobStore, resetJobStore } from '@/lib/job/store-instance';
import type { PostInput } from '@/lib/types';

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

let dataDir: string;
let originalDataDir: string | undefined;

beforeEach(async () => {
  // 보안 정책: /tmp·$TMPDIR 금지 — 워크트리 내부 경로만 사용한다
  dataDir = path.join(process.cwd(), '.dev-loop', 'test-tmp', `events-route-${randomUUID()}`);
  await mkdir(dataDir, { recursive: true });
  originalDataDir = process.env.ANB_DATA_DIR;
  process.env.ANB_DATA_DIR = dataDir;
  resetJobStore();
});

afterEach(async () => {
  resetJobStore();
  if (originalDataDir === undefined) {
    delete process.env.ANB_DATA_DIR;
  } else {
    process.env.ANB_DATA_DIR = originalDataDir;
  }
  await rm(dataDir, { recursive: true, force: true });
});

describe('GET /api/jobs/[id]/events', () => {
  test('에러: 존재하지 않는 잡은 404', async () => {
    const response = await getEvents(new Request('http://127.0.0.1/api/jobs/no-such-job/events'), {
      params: Promise.resolve({ id: 'no-such-job' }),
    });
    expect(response.status).toBe(404);
  });

  test('정상: 터미널 상태(failed)인 잡은 retry와 로그 이벤트를 보낸 뒤 스트림을 닫는다', async () => {
    const jobId = 'job-1';
    const store = getJobStore();
    await store.create(makeInput(jobId));
    await store.transition(jobId, 'analyzing', '분석 시작');
    await store.transition(jobId, 'failed', '실패함');

    const response = await getEvents(new Request(`http://127.0.0.1/api/jobs/${jobId}/events`), {
      params: Promise.resolve({ id: jobId }),
    });
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const body = await response.text();
    expect(body).toContain('retry: 2000');
    expect(body).toContain('id: 0');
    expect(body).toContain('data: {"at"');
    expect(body).toContain('"message":"분석 시작"');
    expect(body).toContain('id: 1');
    expect(body).toContain('"message":"실패함"');
  });

  test('재개(핵심): Last-Event-ID를 보내면 그 이전 이벤트는 다시 보내지 않는다', async () => {
    const jobId = 'job-2';
    const store = getJobStore();
    await store.create(makeInput(jobId));
    await store.transition(jobId, 'analyzing', '첫 번째');
    await store.transition(jobId, 'drafting', '두 번째');
    await store.transition(jobId, 'failed', '세 번째');

    const request = new Request(`http://127.0.0.1/api/jobs/${jobId}/events`, {
      headers: { 'last-event-id': '1' },
    });
    const response = await getEvents(request, { params: Promise.resolve({ id: jobId }) });
    const body = await response.text();

    expect(body).not.toContain('id: 0');
    expect(body).not.toContain('id: 1');
    expect(body).toContain('id: 2');
    expect(body).not.toContain('첫 번째');
    expect(body).not.toContain('두 번째');
    expect(body).toContain('세 번째');
  });

  test('경계값: Last-Event-ID가 마지막 인덱스와 같으면 새 이벤트가 없다', async () => {
    const jobId = 'job-3';
    const store = getJobStore();
    await store.create(makeInput(jobId));
    await store.transition(jobId, 'failed', '유일한 로그');

    const request = new Request(`http://127.0.0.1/api/jobs/${jobId}/events`, {
      headers: { 'last-event-id': '0' },
    });
    const response = await getEvents(request, { params: Promise.resolve({ id: jobId }) });
    const body = await response.text();

    expect(body).toContain('retry: 2000');
    expect(body).not.toContain('id: 0');
  });
});
