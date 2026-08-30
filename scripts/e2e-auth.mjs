#!/usr/bin/env node
// 인증·권한·바인딩을 **실제로 띄운 서버에 HTTP 로** 확인하는 하네스.
//
//   npm run build && npm run e2e:auth
//
// 비용이 들지 않고 네이버를 건드리지 않는다 — claude 를 부르지 않고, 잡 상태 파일을 직접
// 만들어 두고 상태 코드만 본다. Aside 브라우저가 뜨는 경로(`?verify=1`, 로그인·재로그인)는
// 관리자 권한 확인까지만 하고 실제로 부르지 않는다.
//
// 확인하는 것 (docs/next-session-multiuser-prompt.md 의 완료 기준):
//   1) 비밀번호 없이 쓰기/읽기 경로 → 401
//   2) 일반 세션으로 관리자 경로 → 403, 일반 세션의 setup 응답에 계정 정보가 없다
//   3) 남의 잡을 읽거나 고치거나 발행 → 403
//   5) 루프백 밖 + 인증 없음 → 부팅 거부(exit 1)와 이유 출력
//
// 완료 기준 4(동시 발행 직렬화)는 브라우저를 실제로 두 번 몰아야 해서 여기서 다루지 않는다 —
// tests/job/queue.test.ts 와 tests/job/runner.test.ts 의 직렬화 테스트가 그 자리를 맡는다.

import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.E2E_AUTH_PORT ?? 3998);
const BASE = `http://127.0.0.1:${PORT}`;

const ACCESS_PASSWORD = 'e2e-shared-secret';
const ADMIN_PASSWORD = 'e2e-admin-secret';
// 서명 키는 이 실행 안에서만 산다 — 저장소에도 .env 에도 남기지 않는다.
const SESSION_SECRET = 'e2e'.padEnd(64, '0');

// 보안 정책: /tmp·$TMPDIR 금지 — 프로젝트 안(gitignore 된 .vitest-tmp)에만 만든다.
const dataDir = path.join(repoRoot, '.vitest-tmp', `e2e-auth-${process.pid}`);

let failures = 0;
let checks = 0;

function check(label, actual, expected) {
  checks += 1;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label} — ${JSON.stringify(actual)}${ok ? '' : ` (기대: ${JSON.stringify(expected)})`}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 세션 쿠키에서 sid 를 읽는다. 서명 확인은 서버 몫이고, 여기서는 페이로드만 들여다본다. */
function sidOf(cookie) {
  const token = cookie.slice(cookie.indexOf('=') + 1);
  const payload = token.slice(0, token.indexOf('.'));
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).sid;
}

/** Set-Cookie 헤더에서 쿠키 값만 뽑는다(속성은 버린다). */
function cookieFrom(response) {
  const header = response.headers.get('set-cookie');
  if (!header) return null;
  return header.split(';')[0];
}

async function status(pathname, options = {}) {
  const response = await fetch(`${BASE}${pathname}`, options);
  return response.status;
}

async function withCookie(cookie, pathname, options = {}) {
  return fetch(`${BASE}${pathname}`, { ...options, headers: { ...options.headers, cookie } });
}

async function login(password, ip = '203.0.113.10') {
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ password }),
  });
  return { status: response.status, cookie: cookieFrom(response), body: await response.json().catch(() => null) };
}

/** 잡 하나를 승인 대기 상태로 디스크에 만들어 둔다 — 소유자 검사를 실제 파일로 확인하기 위해서다. */
async function seedJob(jobId, owner) {
  const now = new Date().toISOString();
  const image = {
    id: 'img-0',
    originalName: 'a.png',
    path: path.join(dataDir, 'jobs', jobId, 'images', 'img-0.png'),
    mimeType: 'image/png',
    bytes: 10,
    width: null,
    height: null,
    order: 0,
  };
  const state = {
    id: jobId,
    owner,
    phase: 'awaiting_approval',
    input: { jobId, category: '일상', highlights: 'e2e', place: '', images: [image], createdAt: now },
    draft: null,
    editorDraft: null,
    preview: null,
    result: null,
    error: null,
    log: [],
    updatedAt: now,
  };
  const dir = path.join(dataDir, 'jobs', jobId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'state.json'), JSON.stringify(state, null, 2), 'utf8');
}

function startServer(env) {
  const child = spawn('node', [path.join(repoRoot, 'scripts', 'serve.mjs'), 'start'], {
    cwd: repoRoot,
    env: { ...process.env, PORT: String(PORT), ANB_DATA_DIR: dataDir, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = [];
  child.stdout.on('data', (chunk) => output.push(String(chunk)));
  child.stderr.on('data', (chunk) => output.push(String(chunk)));
  return { child, output };
}

async function waitForServer(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/api/auth/session`);
      if (response.status === 200) return true;
    } catch {
      // 아직 안 떴다
    }
    await sleep(200);
  }
  return false;
}

async function stopServer(server) {
  if (server.child.exitCode !== null) return;
  server.child.kill('SIGTERM');
  const deadline = Date.now() + 5000;
  while (server.child.exitCode === null && Date.now() < deadline) await sleep(100);
  if (server.child.exitCode === null) server.child.kill('SIGKILL');
}

// ─────────────────────────────────────────────────────────────
// 1부: 인증을 켠 서버
// ─────────────────────────────────────────────────────────────
async function runLockedServerChecks() {
  console.log('\n[1부] 인증을 켜고 0.0.0.0 에 띄운다');
  const server = startServer({
    ANB_HOST: '0.0.0.0',
    ANB_ACCESS_PASSWORD: ACCESS_PASSWORD,
    ANB_ADMIN_PASSWORD: ADMIN_PASSWORD,
    ANB_SESSION_SECRET: SESSION_SECRET,
  });

  try {
    if (!(await waitForServer())) {
      console.error('서버가 뜨지 않았습니다:\n' + server.output.join(''));
      failures += 1;
      return;
    }

    // 인증을 붙이기 전에 만들어진 잡 두 가지. 둘 다 "누구 것인지 모른다" 는 뜻이라
    // 관리자에게만 열려야 한다 — 'local' 은 무인증 모드에서 쓰던 고정 식별자다.
    await seedJob('job-legacy', null);
    await seedJob('job-openmode', 'local');

    console.log('\n 완료 기준 1 — 인증 없이 부르면 401');
    check('POST /api/jobs', await status('/api/jobs', { method: 'POST' }), 401);
    check(
      'PUT /api/jobs/job-a/draft',
      await status('/api/jobs/job-a/draft', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
      401,
    );
    check('POST /api/jobs/job-a/publish', await status('/api/jobs/job-a/publish', { method: 'POST' }), 401);
    check('GET /api/jobs/job-a', await status('/api/jobs/job-a'), 401);
    check('GET /api/jobs/job-a/events', await status('/api/jobs/job-a/events'), 401);
    check('GET /api/jobs/job-a/preview', await status('/api/jobs/job-a/preview'), 401);
    check('GET /api/setup', await status('/api/setup'), 401);
    check('POST /api/setup/relogin', await status('/api/setup/relogin', { method: 'POST' }), 401);

    console.log('\n 로그인');
    const session = await (await fetch(`${BASE}/api/auth/session`)).json();
    check('GET /api/auth/session', session, {
      authRequired: true,
      authenticated: false,
      role: null,
      adminAvailable: true,
    });
    check('틀린 비밀번호', (await login('틀린값', '198.51.100.1')).status, 401);

    const user = await login(ACCESS_PASSWORD);
    check('일반 비밀번호 → user 세션', [user.status, user.body?.role], [200, 'user']);
    const admin = await login(ADMIN_PASSWORD, '203.0.113.11');
    check('관리자 비밀번호 → admin 세션', [admin.status, admin.body?.role], [200, 'admin']);

    // 방금 로그인한 세션이 소유한 잡을 만든다 — 소유자 검사가 실제 세션 식별자로 걸리는지 본다.
    await seedJob('job-a', sidOf(user.cookie));

    console.log('\n 대입 방어 — 같은 IP 로 연달아 틀리면 막힌다');
    const codes = [];
    for (let attempt = 0; attempt < 11; attempt++) {
      codes.push((await login('틀린값', '198.51.100.2')).status);
    }
    check('11번째 시도', codes[10], 429);
    check('앞 10번은 그냥 401', new Set(codes.slice(0, 10)).size === 1 && codes[0] === 401, true);
    check('다른 IP 는 막히지 않는다', (await login(ACCESS_PASSWORD, '198.51.100.3')).status, 200);

    console.log('\n 완료 기준 2 — 관리자 전용 경로');
    check(
      'POST /api/setup/relogin (일반)',
      (await withCookie(user.cookie, '/api/setup/relogin', { method: 'POST' })).status,
      403,
    );
    check(
      'POST /api/setup/login (일반)',
      (await withCookie(user.cookie, '/api/setup/login', { method: 'POST' })).status,
      403,
    );

    // `?verify=1` 을 줘도 일반 사용자에게는 브라우저를 띄우지 않고 요약만 준다.
    const userSetup = await (await withCookie(user.cookie, '/api/setup?verify=1')).json();
    check('일반 사용자의 /api/setup 키 목록', Object.keys(userSetup).sort(), ['admin', 'categories', 'ready']);
    check('일반 사용자에게 blogId 를 주지 않는다', 'blogId' in userSetup, false);
    check('일반 사용자에게 쿠키 만료 시각을 주지 않는다', 'persistence' in userSetup, false);

    // 관리자 조회는 `verify=1` 없이 한다 — 라이브 확인은 Aside 브라우저를 띄우므로 e2e 에서 부르지 않는다.
    const adminSetup = await (await withCookie(admin.cookie, '/api/setup')).json();
    check('관리자에게는 전체 상태를 준다', [adminSetup.admin, 'blogId' in adminSetup, 'persistence' in adminSetup], [
      true,
      true,
      true,
    ]);

    console.log('\n 완료 기준 3 — 남의 잡은 만질 수 없다');
    const other = await login(ACCESS_PASSWORD, '198.51.100.4');
    check('자기 잡 읽기', (await withCookie(user.cookie, '/api/jobs/job-a')).status, 200);
    check('남의 잡 읽기 (다른 일반 세션)', (await withCookie(other.cookie, '/api/jobs/job-a')).status, 403);
    check(
      '남의 잡 고치기',
      (
        await withCookie(other.cookie, '/api/jobs/job-a/draft', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
      403,
    );
    check(
      '남의 잡 발행',
      (await withCookie(other.cookie, '/api/jobs/job-a/publish', { method: 'POST' })).status,
      403,
    );
    check('남의 잡 진행 로그', (await withCookie(other.cookie, '/api/jobs/job-a/events')).status, 403);
    check('남의 잡 미리보기', (await withCookie(other.cookie, '/api/jobs/job-a/preview')).status, 403);
    check(
      '남의 잡 미리보기 재촬영',
      (await withCookie(other.cookie, '/api/jobs/job-a/preview', { method: 'POST' })).status,
      403,
    );
    check(
      '남의 잡 사진 추가',
      (await withCookie(other.cookie, '/api/jobs/job-a/images', { method: 'POST' })).status,
      403,
    );
    check('관리자도 남의 잡은 못 읽는다', (await withCookie(admin.cookie, '/api/jobs/job-a')).status, 403);
    check(
      '소유자 없는 옛 잡은 관리자에게만',
      [
        (await withCookie(admin.cookie, '/api/jobs/job-legacy')).status,
        (await withCookie(user.cookie, '/api/jobs/job-legacy')).status,
      ],
      [200, 403],
    );
    check(
      '혼자 쓰던 시절의 잡도 관리자에게만 (모두에게 잠기지 않는다)',
      [
        (await withCookie(admin.cookie, '/api/jobs/job-openmode')).status,
        (await withCookie(user.cookie, '/api/jobs/job-openmode')).status,
      ],
      [200, 403],
    );

    console.log('\n 에디터를 쥐지 않은 잡의 발행은 500 이 아니라 409');
    check(
      'POST /api/jobs/job-legacy/publish (관리자, 리스 없음)',
      (await withCookie(admin.cookie, '/api/jobs/job-legacy/publish', { method: 'POST' })).status,
      409,
    );

    console.log('\n 로그아웃하면 다시 잠긴다');
    const loggedOut = await withCookie(user.cookie, '/api/auth/logout', { method: 'POST' });
    check('POST /api/auth/logout', loggedOut.status, 200);
    check('지우는 쿠키는 Max-Age=0', (loggedOut.headers.get('set-cookie') ?? '').includes('Max-Age=0'), true);
    check('빈 쿠키로는 통과하지 못한다', await status('/api/jobs/job-a', { headers: { cookie: 'anb_session=' } }), 401);
  } finally {
    await stopServer(server);
  }
}

// ─────────────────────────────────────────────────────────────
// 2부: 인증 없이 외부 바인딩 → 부팅 거부
// ─────────────────────────────────────────────────────────────
async function runBootRefusalCheck() {
  console.log('\n[2부] 완료 기준 5 — 인증 없이 0.0.0.0 으로 띄우면 부팅을 거부한다');
  const server = startServer({
    ANB_HOST: '0.0.0.0',
    ANB_ACCESS_PASSWORD: '',
    ANB_ADMIN_PASSWORD: '',
    ANB_SESSION_SECRET: '',
  });

  const exitCode = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('시간 초과'), 30_000);
    server.child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  await stopServer(server);

  const log = server.output.join('');
  check('종료 코드', exitCode, 1);
  check('이유를 출력한다', log.includes('부팅을 거부합니다') && log.includes('ANB_ACCESS_PASSWORD'), true);
}

async function main() {
  await mkdir(dataDir, { recursive: true });
  try {
    await runLockedServerChecks();
    await runBootRefusalCheck();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }

  console.log(`\n검사 ${checks}건 중 실패 ${failures}건`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
