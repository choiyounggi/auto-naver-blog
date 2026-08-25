import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
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
  dataDir = path.join(process.cwd(), '.dev-loop', 'test-tmp', `store-instance-${randomUUID()}`);
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

describe('getJobStore', () => {
  test('정상: 매 호출마다 같은 인스턴스를 돌려준다', () => {
    const a = getJobStore();
    const b = getJobStore();
    expect(a).toBe(b);
  });

  test('정상: 싱글턴을 통한 쓰기는 캐시를 통해 즉시 보인다 (SSE 폴링이 의존하는 성질)', async () => {
    const store = getJobStore();
    await store.create(makeInput('job-x'));
    // 디스크의 state.json을 깨뜨려도, 같은 인스턴스의 get()은 캐시를 먼저 본다
    await writeFile(path.join(dataDir, 'jobs', 'job-x', 'state.json'), '{not valid json', 'utf8');
    const fetched = await store.get('job-x');
    expect(fetched?.id).toBe('job-x');
    expect(fetched?.phase).toBe('created');
  });

  test('경계값: resetJobStore() 후에는 새 ANB_DATA_DIR를 반영한 새 인스턴스를 만든다', async () => {
    const first = getJobStore();
    await first.create(makeInput('job-y'));

    const secondDataDir = path.join(process.cwd(), '.dev-loop', 'test-tmp', `store-instance-2nd-${randomUUID()}`);
    await mkdir(secondDataDir, { recursive: true });
    process.env.ANB_DATA_DIR = secondDataDir;
    resetJobStore();

    const second = getJobStore();
    expect(second).not.toBe(first);
    const fromSecond = await second.get('job-y');
    expect(fromSecond).toBeNull(); // 새 dataDir에는 job-y가 없다

    await rm(secondDataDir, { recursive: true, force: true });
  });

  test('에러: ANB_DATA_DIR이 절대경로가 아니면 getJobStore()가 throw한다', () => {
    process.env.ANB_DATA_DIR = 'relative/path';
    resetJobStore();
    expect(() => getJobStore()).toThrow();
  });
});
