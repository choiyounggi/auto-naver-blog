import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { GET as getSetup } from '@/app/api/setup/route';
import { POST as postRelogin } from '@/app/api/setup/relogin/route';
import { POST as postLoginFlow } from '@/app/api/setup/login/route';
import { POST as postJobs } from '@/app/api/jobs/route';
import { GET as getJob } from '@/app/api/jobs/[id]/route';
import { PUT as putDraft } from '@/app/api/jobs/[id]/draft/route';
import { POST as postPublish } from '@/app/api/jobs/[id]/publish/route';
import { GET as getEvents } from '@/app/api/jobs/[id]/events/route';
import { POST as postImages } from '@/app/api/jobs/[id]/images/route';
import { GET as getImage } from '@/app/api/jobs/[id]/images/[imageId]/route';
import { GET as getPreview, POST as postPreview } from '@/app/api/jobs/[id]/preview/route';
import { SESSION_COOKIE_NAME, createSession, signSession, type SessionRole } from '@/lib/auth/session';
import { resetEditorQueue } from '@/lib/job/queue';
import { getJobStore, resetJobStore } from '@/lib/job/store-instance';
import type { PostInput } from '@/lib/types';

const SECRET = 'a1'.repeat(32);
const AUTH_ENV_KEYS = ['ANB_ACCESS_PASSWORD', 'ANB_ADMIN_PASSWORD', 'ANB_SESSION_SECRET', 'ANB_HOST'] as const;
const saved = new Map<string, string | undefined>();

let dataDir: string;
let originalDataDir: string | undefined;

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
        path: path.join(dataDir, 'jobs', jobId, 'images', 'img-0.jpg'),
        mimeType: 'image/jpeg',
        bytes: 12,
        width: null,
        height: null,
        order: 0,
      },
    ],
    createdAt: new Date().toISOString(),
  };
}

function sessionCookie(role: SessionRole, sid: string): string {
  const token = signSession({ ...createSession(role, Date.now()), sid }, SECRET);
  return `${SESSION_COOKIE_NAME}=${token}`;
}

function request(url: string, options: { method?: string; cookie?: string; body?: BodyInit } = {}): Request {
  const headers: Record<string, string> = {};
  if (options.cookie) headers.cookie = options.cookie;
  if (typeof options.body === 'string') headers['content-type'] = 'application/json';
  return new Request(`http://127.0.0.1${url}`, { method: options.method ?? 'GET', headers, body: options.body });
}

beforeEach(async () => {
  for (const key of AUTH_ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.ANB_ACCESS_PASSWORD = 'shared-secret';
  process.env.ANB_ADMIN_PASSWORD = 'admin-secret';
  process.env.ANB_SESSION_SECRET = SECRET;

  // 보안 정책: /tmp·$TMPDIR 금지 — 프로젝트 안에만 만든다
  dataDir = path.join(process.cwd(), '.vitest-tmp', `route-guards-${randomUUID()}`);
  await mkdir(dataDir, { recursive: true });
  originalDataDir = process.env.ANB_DATA_DIR;
  process.env.ANB_DATA_DIR = dataDir;
  resetJobStore();
  resetEditorQueue();
});

afterEach(async () => {
  for (const key of AUTH_ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (originalDataDir === undefined) delete process.env.ANB_DATA_DIR;
  else process.env.ANB_DATA_DIR = originalDataDir;
  resetJobStore();
  resetEditorQueue();
  await rm(dataDir, { recursive: true, force: true });
});

// 완료 기준 1: 비밀번호 없이 쓰기 경로를 부르면 401
describe('인증 없이 부르면 401 (완료 기준 1)', () => {
  test('잡 생성·초안 저장·발행 모두 401 이다', async () => {
    const params = { params: Promise.resolve({ id: 'job-x' }) };
    expect((await postJobs(request('/api/jobs', { method: 'POST' }))).status).toBe(401);
    expect((await putDraft(request('/api/jobs/job-x/draft', { method: 'PUT', body: '{}' }), params)).status).toBe(401);
    expect((await postPublish(request('/api/jobs/job-x/publish', { method: 'POST' }), params)).status).toBe(401);
  });

  test('읽기 경로도 401 이다 (남의 글이 새지 않는다)', async () => {
    const params = { params: Promise.resolve({ id: 'job-x' }) };
    expect((await getJob(request('/api/jobs/job-x'), params)).status).toBe(401);
    expect((await getEvents(request('/api/jobs/job-x/events'), params)).status).toBe(401);
    expect((await getPreview(request('/api/jobs/job-x/preview'), params)).status).toBe(401);
    expect((await getSetup(request('/api/setup'))).status).toBe(401);
    expect(
      (await getImage(request('/api/jobs/job-x/images/img-0'), {
        params: Promise.resolve({ id: 'job-x', imageId: 'img-0' }),
      })).status,
    ).toBe(401);
  });

  test('위조한 쿠키도 401 이다 (경계값)', async () => {
    const forged = `${SESSION_COOKIE_NAME}=${signSession(createSession('admin', Date.now()), 'b'.repeat(64))}`;
    expect((await postJobs(request('/api/jobs', { method: 'POST', cookie: forged }))).status).toBe(401);
  });
});

// 완료 기준 2: 일반 세션은 관리자 경로를 쓸 수 없다
describe('관리자 전용 경로 (완료 기준 2)', () => {
  test('일반 세션으로 재로그인·로그인을 부르면 403 이다', async () => {
    const cookie = sessionCookie('user', 'sid-a');
    const relogin = await postRelogin(request('/api/setup/relogin', { method: 'POST', cookie }));
    expect(relogin.status).toBe(403);
    const login = await postLoginFlow(request('/api/setup/login', { method: 'POST', cookie }));
    expect(login.status).toBe(403);
  });

  test('로그인하지 않았으면 401 이다 (경계값)', async () => {
    expect((await postRelogin(request('/api/setup/relogin', { method: 'POST' }))).status).toBe(401);
  });

  test('일반 세션의 /api/setup 은 읽기 전용 요약이다 — 계정 정보가 없다', async () => {
    const response = await getSetup(request('/api/setup?verify=1', { cookie: sessionCookie('user', 'sid-a') }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.admin).toBe(false);
    expect(Object.keys(body).sort()).toEqual(['admin', 'categories', 'ready']);
    expect(body).not.toHaveProperty('blogId');
    expect(body).not.toHaveProperty('persistence');
  });

  test('관리자의 /api/setup 은 전체 상태를 준다', async () => {
    const response = await getSetup(request('/api/setup', { cookie: sessionCookie('admin', 'sid-admin') }));
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.admin).toBe(true);
    expect(body).toHaveProperty('blogId');
    expect(body).toHaveProperty('persistence');
  });
});

// 완료 기준 3: 남의 잡은 만질 수 없다
describe('잡 소유자 (완료 기준 3)', () => {
  const jobId = 'job-owned';

  async function createOwnedJob(owner: string | null): Promise<void> {
    const store = getJobStore();
    await store.create(makeInput(jobId), owner);
  }

  test('자기 잡은 읽을 수 있다', async () => {
    await createOwnedJob('sid-a');
    const response = await getJob(request(`/api/jobs/${jobId}`, { cookie: sessionCookie('user', 'sid-a') }), {
      params: Promise.resolve({ id: jobId }),
    });
    expect(response.status).toBe(200);
  });

  test('남의 잡은 읽기·고치기·발행 모두 403 이다', async () => {
    await createOwnedJob('sid-a');
    const cookie = sessionCookie('user', 'sid-b');
    const params = { params: Promise.resolve({ id: jobId }) };

    expect((await getJob(request(`/api/jobs/${jobId}`, { cookie }), params)).status).toBe(403);
    expect(
      (await putDraft(request(`/api/jobs/${jobId}/draft`, { method: 'PUT', cookie, body: '{}' }), params)).status,
    ).toBe(403);
    expect((await postPublish(request(`/api/jobs/${jobId}/publish`, { method: 'POST', cookie }), params)).status).toBe(
      403,
    );
    expect((await getEvents(request(`/api/jobs/${jobId}/events`, { cookie }), params)).status).toBe(403);
    expect((await postImages(request(`/api/jobs/${jobId}/images`, { method: 'POST', cookie }), params)).status).toBe(
      403,
    );
    expect((await getPreview(request(`/api/jobs/${jobId}/preview`, { cookie }), params)).status).toBe(403);
    expect((await postPreview(request(`/api/jobs/${jobId}/preview`, { method: 'POST', cookie }), params)).status).toBe(
      403,
    );
    expect(
      (await getImage(request(`/api/jobs/${jobId}/images/img-0`, { cookie }), {
        params: Promise.resolve({ id: jobId, imageId: 'img-0' }),
      })).status,
    ).toBe(403);
  });

  test('관리자라도 남의 잡은 만질 수 없다', async () => {
    await createOwnedJob('sid-a');
    const response = await getJob(request(`/api/jobs/${jobId}`, { cookie: sessionCookie('admin', 'sid-admin') }), {
      params: Promise.resolve({ id: jobId }),
    });
    expect(response.status).toBe(403);
  });

  test('소유자가 없는 옛 잡은 관리자에게만 열린다 (경계값)', async () => {
    await createOwnedJob(null);
    const params = { params: Promise.resolve({ id: jobId }) };
    expect((await getJob(request(`/api/jobs/${jobId}`, { cookie: sessionCookie('admin', 'x') }), params)).status).toBe(
      200,
    );
    expect((await getJob(request(`/api/jobs/${jobId}`, { cookie: sessionCookie('user', 'x') }), params)).status).toBe(
      403,
    );
  });

  test('없는 잡은 소유자를 따지기 전에 404 다 (경계값)', async () => {
    const response = await getJob(request('/api/jobs/없는잡', { cookie: sessionCookie('user', 'sid-a') }), {
      params: Promise.resolve({ id: '없는잡' }),
    });
    expect(response.status).toBe(404);
  });
});
