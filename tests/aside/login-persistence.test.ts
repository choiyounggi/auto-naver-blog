import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { describeLoginPersistence, readLoginPersistence } from '@/lib/aside/login-persistence';

const testDir = path.dirname(fileURLToPath(import.meta.url));
// 보안 정책: /tmp·$TMPDIR 대신 프로젝트 내부(gitignore 된 .vitest-tmp)에만 파일을 만든다
const scratchDir = path.join(testDir, '..', '..', '.vitest-tmp', 'login-persistence-tests');

const FUTURE = Math.floor(Date.parse('2027-09-29T13:00:00.000Z') / 1000);

function authCookie(expires?: number) {
  return { name: 'NID_AUT', domain: '.naver.com', ...(expires === undefined ? {} : { expires }) };
}

describe('describeLoginPersistence — 정상', () => {
  test('만료일이 있는 인증 쿠키는 로그인이 유지되는 것으로 본다', () => {
    expect(describeLoginPersistence([authCookie(FUTURE)])).toEqual({
      keepLoggedIn: true,
      expiresAt: '2027-09-29T13:00:00.000Z',
    });
  });

  test('다른 쿠키가 섞여 있어도 NID_AUT 로 판정한다', () => {
    const cookies = [{ name: 'NNB', expires: FUTURE }, authCookie(FUTURE), { name: 'NAC' }];
    expect(describeLoginPersistence(cookies).keepLoggedIn).toBe(true);
  });
});

// 실측 회귀(2026-08-25): '로그인 상태 유지' 를 켜지 않으면 NID_AUT 가 만료일 없는 세션
// 쿠키로 내려오고, 이틀 만에 로그인이 풀렸다.
describe('describeLoginPersistence — 세션 쿠키(유지 안 됨)', () => {
  test('만료일이 없으면 유지되지 않는 것으로 본다', () => {
    expect(describeLoginPersistence([authCookie()])).toEqual({ keepLoggedIn: false, expiresAt: null });
  });

  test('expires 가 -1 이면 세션 쿠키다', () => {
    expect(describeLoginPersistence([authCookie(-1)]).keepLoggedIn).toBe(false);
  });

  test('expires 가 0 이면 세션 쿠키다', () => {
    expect(describeLoginPersistence([authCookie(0)]).keepLoggedIn).toBe(false);
  });
});

describe('describeLoginPersistence — 경계값/에러', () => {
  test('빈 배열이면 유지되지 않는다', () => {
    expect(describeLoginPersistence([])).toEqual({ keepLoggedIn: false, expiresAt: null });
  });

  test('배열이 아니면 유지되지 않는다', () => {
    expect(describeLoginPersistence(null).keepLoggedIn).toBe(false);
    expect(describeLoginPersistence('nope').keepLoggedIn).toBe(false);
  });

  test('NID_AUT 가 없으면 유지되지 않는다', () => {
    expect(describeLoginPersistence([{ name: 'NID_SES', expires: FUTURE }]).keepLoggedIn).toBe(false);
  });

  test('expires 가 숫자가 아니면 세션 쿠키로 본다', () => {
    expect(describeLoginPersistence([{ name: 'NID_AUT', expires: '2027' }]).keepLoggedIn).toBe(false);
  });
});

describe('readLoginPersistence', () => {
  let cookieFile: string;

  beforeEach(async () => {
    await mkdir(scratchDir, { recursive: true });
    cookieFile = path.join(scratchDir, 'naver-cookies.json');
  });

  afterEach(async () => {
    await rm(scratchDir, { recursive: true, force: true });
  });

  test('정상: 파일에서 읽어 판정한다', async () => {
    await writeFile(cookieFile, JSON.stringify([authCookie(FUTURE)]), 'utf8');
    expect((await readLoginPersistence(cookieFile)).keepLoggedIn).toBe(true);
  });

  test('경계값: 파일이 없으면 유지되지 않는다', async () => {
    expect(await readLoginPersistence(cookieFile)).toEqual({ keepLoggedIn: false, expiresAt: null });
  });

  test('에러: 파일이 JSON 이 아니면 유지되지 않는다(던지지 않는다)', async () => {
    await writeFile(cookieFile, 'not json', 'utf8');
    expect((await readLoginPersistence(cookieFile)).keepLoggedIn).toBe(false);
  });
});
