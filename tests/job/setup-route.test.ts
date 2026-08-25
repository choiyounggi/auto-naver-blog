import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { parseEnvFile, readSetupState } from '@/lib/aside/blog-meta';

const testDir = path.dirname(fileURLToPath(import.meta.url));
// 보안 정책: /tmp·$TMPDIR 대신 프로젝트 내부(gitignore 된 .vitest-tmp)에만 파일을 만든다
const scratchDir = path.join(testDir, '..', '..', '.vitest-tmp', 'setup-state-tests');

let envPath: string;
let cookieFile: string;

beforeEach(async () => {
  await mkdir(scratchDir, { recursive: true });
  envPath = path.join(scratchDir, '.env');
  cookieFile = path.join(scratchDir, 'naver-cookies.json');
});

afterEach(async () => {
  await rm(scratchDir, { recursive: true, force: true });
});

describe('parseEnvFile — 정상', () => {
  test('KEY=VALUE 를 읽는다', () => {
    expect(parseEnvFile('NAVER_BLOG_ID=dev_king\n')).toEqual({ NAVER_BLOG_ID: 'dev_king' });
  });

  test('큰따옴표로 감싼 값은 따옴표를 벗긴다', () => {
    expect(parseEnvFile('A="맛집 뿌시기,테슬라"')).toEqual({ A: '맛집 뿌시기,테슬라' });
  });

  test('주석과 빈 줄을 건너뛴다', () => {
    expect(parseEnvFile('# 설명\n\nA=1\n')).toEqual({ A: '1' });
  });

  test('값에 `=` 가 들어 있어도 첫 `=` 만 구분자로 쓴다', () => {
    expect(parseEnvFile('A=b=c')).toEqual({ A: 'b=c' });
  });
});

describe('parseEnvFile — 경계값/에러', () => {
  test('빈 내용은 빈 객체다', () => {
    expect(parseEnvFile('')).toEqual({});
  });

  test('`=` 가 없는 줄은 무시한다', () => {
    expect(parseEnvFile('그냥 텍스트\nA=1')).toEqual({ A: '1' });
  });

  test('빈 값은 빈 문자열로 읽는다', () => {
    expect(parseEnvFile('A=')).toEqual({ A: '' });
  });
});

describe('readSetupState — 정상', () => {
  test('쿠키와 blogId 가 모두 있으면 ready 다', async () => {
    await writeFile(envPath, 'NAVER_BLOG_ID=dev_king\nNAVER_BLOG_CATEGORIES="맛집 뿌시기,테슬라"\n', 'utf8');
    await writeFile(cookieFile, '[]', 'utf8');

    expect(await readSetupState({ envPath, cookieFile })).toEqual({
      ready: true,
      hasCookies: true,
      blogId: 'dev_king',
      categories: ['맛집 뿌시기', '테슬라'],
    });
  });

  test('process.env 로 준 값이 .env 파일보다 우선한다', async () => {
    await writeFile(envPath, 'NAVER_BLOG_ID=from_file\n', 'utf8');
    await writeFile(cookieFile, '[]', 'utf8');

    const state = await readSetupState({ envPath, cookieFile, envOverrides: { blogId: 'from_env' } });
    expect(state.blogId).toBe('from_env');
  });
});

describe('readSetupState — 경계값/에러', () => {
  test('.env 도 쿠키도 없으면 ready 가 아니다', async () => {
    expect(await readSetupState({ envPath, cookieFile })).toEqual({
      ready: false,
      hasCookies: false,
      blogId: null,
      categories: [],
    });
  });

  test('쿠키는 있는데 blogId 를 모르면 ready 가 아니다', async () => {
    await writeFile(cookieFile, '[]', 'utf8');
    const state = await readSetupState({ envPath, cookieFile });
    expect(state.hasCookies).toBe(true);
    expect(state.ready).toBe(false);
  });

  test('blogId 는 아는데 쿠키가 없으면 ready 가 아니다', async () => {
    await writeFile(envPath, 'NAVER_BLOG_ID=dev_king\n', 'utf8');
    const state = await readSetupState({ envPath, cookieFile });
    expect(state.blogId).toBe('dev_king');
    expect(state.ready).toBe(false);
  });

  test('빈 카테고리 값은 빈 배열이 된다 (빈 문자열이 원소로 남지 않는다)', async () => {
    await writeFile(envPath, 'NAVER_BLOG_ID=dev_king\nNAVER_BLOG_CATEGORIES=\n', 'utf8');
    await writeFile(cookieFile, '[]', 'utf8');

    const state = await readSetupState({ envPath, cookieFile });
    expect(state.categories).toEqual([]);
    expect(state.ready).toBe(true);
  });

  test('공백뿐인 blogId 는 없는 것으로 본다', async () => {
    await writeFile(envPath, 'NAVER_BLOG_ID="   "\n', 'utf8');
    await writeFile(cookieFile, '[]', 'utf8');

    const state = await readSetupState({ envPath, cookieFile });
    expect(state.blogId).toBeNull();
    expect(state.ready).toBe(false);
  });
});
