import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { GET as getJob } from '@/app/api/jobs/[id]/route';
import { GET as getImage } from '@/app/api/jobs/[id]/images/[imageId]/route';
import { POST as postJobs } from '@/app/api/jobs/route';
import { resetJobStore } from '@/lib/job/store-instance';
import { JobStateSchema } from '@/lib/types';

function pngBytes(totalSize: number): Uint8Array {
  const header = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const buf = new Uint8Array(Math.max(totalSize, header.length));
  buf.set(header, 0);
  return buf;
}

function makePngFile(name: string, sizeBytes = 32): File {
  return new File([pngBytes(sizeBytes).buffer as ArrayBuffer], name, { type: 'image/png' });
}

function makeTextFile(name: string): File {
  return new File([new TextEncoder().encode('not an image').buffer as ArrayBuffer], name, { type: 'image/png' });
}

function makeUploadFormData(fields: {
  category?: string;
  highlights?: string;
  /** 생략하면 place 필드를 아예 보내지 않는다 (선택 입력이라는 계약을 그대로 검사하기 위함) */
  place?: string;
  images: File[];
}): FormData {
  const fd = new FormData();
  fd.set('category', fields.category ?? '일상');
  fd.set('highlights', fields.highlights ?? '오늘 다녀온 카페');
  if (fields.place !== undefined) fd.set('place', fields.place);
  for (const image of fields.images) {
    fd.append('images', image);
  }
  return fd;
}

let dataDir: string;
let originalDataDir: string | undefined;

beforeEach(async () => {
  // 보안 정책: /tmp·$TMPDIR 금지 — 워크트리 내부 경로만 사용한다
  dataDir = path.join(process.cwd(), '.dev-loop', 'test-tmp', `jobs-route-${randomUUID()}`);
  await mkdir(dataDir, { recursive: true });
  originalDataDir = process.env.ANB_DATA_DIR;
  process.env.ANB_DATA_DIR = dataDir;
  // 라우트들이 공유하는 JobStore 싱글턴을 리셋한다 — 그래야 다음 getJobStore() 호출이
  // 이번 테스트의 dataDir로 새로 만들어진다 (프로세스 전역 싱글턴이 이전 테스트의
  // dataDir를 그대로 들고 있으면 이번 테스트가 남의 디렉토리를 보게 된다)
  resetJobStore();
});

// POST /api/jobs 는 runJob() 을 기다리지 않고 201 을 돌려준다(설계). 그 백그라운드 잡이
// 테스트가 끝난 뒤에도 잡 상태 파일을 쓰기 때문에, 곧바로 지우면 rm 과 경합해 ENOTEMPTY 가
// 난다 — 쓰기가 멎을 때까지 짧게 재시도한다.
async function rmAfterBackgroundWrites(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw err;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  await rm(dir, { recursive: true, force: true });
}

afterEach(async () => {
  resetJobStore();
  if (originalDataDir === undefined) {
    delete process.env.ANB_DATA_DIR;
  } else {
    process.env.ANB_DATA_DIR = originalDataDir;
  }
  await rmAfterBackgroundWrites(dataDir);
});

describe('POST /api/jobs', () => {
  test('정상: 유효한 이미지들로 요청하면 JobState를 만들고 order 0이 첫 장을 가리킨다', async () => {
    const fd = makeUploadFormData({ images: [makePngFile('first.png'), makePngFile('second.png')] });
    const request = new Request('http://127.0.0.1/api/jobs', { method: 'POST', body: fd });
    const response = await postJobs(request);
    expect(response.status).toBe(201);
    const body = await response.json();
    const parsed = JobStateSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    expect(body.phase).toBe('created');
    expect(body.input.images).toHaveLength(2);
    expect(body.input.images[0].order).toBe(0);
    expect(body.input.images[0].originalName).toBe('first.png');
    expect(body.input.images[1].order).toBe(1);
    // 서버 생성 이름: originalName과 저장 파일명이 달라야 한다 (D2)
    expect(path.basename(body.input.images[0].path)).not.toContain('first.png');
  });

  test('에러: 확장자는 .png인데 내용이 텍스트인 이미지가 섞이면 전체 요청을 거부한다', async () => {
    const fd = makeUploadFormData({ images: [makePngFile('ok.png'), makeTextFile('fake.png')] });
    const request = new Request('http://127.0.0.1/api/jobs', { method: 'POST', body: fd });
    const response = await postJobs(request);
    expect(response.status).toBe(400);
  });

  test('경계값: 이미지가 21장이면 400으로 거부한다 (상한 20)', async () => {
    const files = Array.from({ length: 21 }, (_, i) => makePngFile(`img-${i}.png`));
    const fd = makeUploadFormData({ images: files });
    const request = new Request('http://127.0.0.1/api/jobs', { method: 'POST', body: fd });
    const response = await postJobs(request);
    expect(response.status).toBe(400);
  });

  test('경계값: 이미지 한 장이 10MB를 초과하면 400으로 거부한다', async () => {
    const fd = makeUploadFormData({ images: [makePngFile('huge.png', 10 * 1024 * 1024 + 1)] });
    const request = new Request('http://127.0.0.1/api/jobs', { method: 'POST', body: fd });
    const response = await postJobs(request);
    expect(response.status).toBe(400);
  });

  test('에러: 이미지가 없으면 400으로 거부한다', async () => {
    const fd = makeUploadFormData({ images: [] });
    const request = new Request('http://127.0.0.1/api/jobs', { method: 'POST', body: fd });
    const response = await postJobs(request);
    expect(response.status).toBe(400);
  });
});

describe('POST /api/jobs — 장소(선택 입력)', () => {
  test('정상: place 를 보내면 잡 입력에 담긴다', async () => {
    const fd = makeUploadFormData({ place: '서울 성수동 파스타집', images: [makePngFile('a.png')] });
    const response = await postJobs(new Request('http://127.0.0.1/api/jobs', { method: 'POST', body: fd }));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.input.place).toBe('서울 성수동 파스타집');
  });

  test('경계값: place 를 아예 안 보내도 성공하고 빈 문자열이 된다', async () => {
    const fd = makeUploadFormData({ images: [makePngFile('a.png')] });
    const response = await postJobs(new Request('http://127.0.0.1/api/jobs', { method: 'POST', body: fd }));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.input.place).toBe('');
  });

  test('경계값: 앞뒤 공백은 다듬어 저장한다', async () => {
    const fd = makeUploadFormData({ place: '  성수동  ', images: [makePngFile('a.png')] });
    const response = await postJobs(new Request('http://127.0.0.1/api/jobs', { method: 'POST', body: fd }));
    const body = await response.json();
    expect(body.input.place).toBe('성수동');
  });

  test('에러: place 로 텍스트가 아닌 값(파일)이 오면 400 으로 거부한다', async () => {
    const fd = makeUploadFormData({ images: [makePngFile('a.png')] });
    fd.set('place', makePngFile('not-a-place.png'));
    const response = await postJobs(new Request('http://127.0.0.1/api/jobs', { method: 'POST', body: fd }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('place');
  });
});

describe('GET /api/jobs/[id] 및 이미지 서빙', () => {
  test('정상: 생성된 잡을 조회하고, 이미지도 올바른 Content-Type으로 서빙된다', async () => {
    const fd = makeUploadFormData({ images: [makePngFile('photo.png')] });
    const createRequest = new Request('http://127.0.0.1/api/jobs', { method: 'POST', body: fd });
    const createResponse = await postJobs(createRequest);
    const created = await createResponse.json();

    const getResponse = await getJob(new Request(`http://127.0.0.1/api/jobs/${created.id}`), {
      params: Promise.resolve({ id: created.id }),
    });
    expect(getResponse.status).toBe(200);
    const fetched = await getResponse.json();
    expect(fetched.id).toBe(created.id);

    const imageId = created.input.images[0].id;
    const imageResponse = await getImage(new Request(`http://127.0.0.1/api/jobs/${created.id}/images/${imageId}`), {
      params: Promise.resolve({ id: created.id, imageId }),
    });
    expect(imageResponse.status).toBe(200);
    expect(imageResponse.headers.get('content-type')).toBe('image/png');
    const bytes = new Uint8Array(await imageResponse.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(0);
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  test('에러: 존재하지 않는 잡 id는 404', async () => {
    const response = await getJob(new Request('http://127.0.0.1/api/jobs/no-such-job'), {
      params: Promise.resolve({ id: 'no-such-job' }),
    });
    expect(response.status).toBe(404);
  });

  test('에러: 존재하지 않는 imageId는 404', async () => {
    const fd = makeUploadFormData({ images: [makePngFile('photo.png')] });
    const createRequest = new Request('http://127.0.0.1/api/jobs', { method: 'POST', body: fd });
    const createResponse = await postJobs(createRequest);
    const created = await createResponse.json();

    const response = await getImage(
      new Request(`http://127.0.0.1/api/jobs/${created.id}/images/does-not-exist`),
      { params: Promise.resolve({ id: created.id, imageId: 'does-not-exist' }) },
    );
    expect(response.status).toBe(404);
  });
});
