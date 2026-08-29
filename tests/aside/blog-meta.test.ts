import { readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  discoverBlogMeta,
  parseBlogIdFromUrl,
  parseCategoryNames,
  upsertEnv,
  writeBlogMetaEnv,
} from '@/lib/aside/blog-meta';
import type { AsideEvalResult, AsideReplApi } from '@/lib/types';

const testDir = path.dirname(fileURLToPath(import.meta.url));
// 보안 정책: /tmp·$TMPDIR 대신 프로젝트 내부(gitignore 된 .vitest-tmp)에만 파일을 만든다
const scratchDir = path.join(testDir, '..', '..', '.vitest-tmp', 'blog-meta-tests');

function ok(stdout: string): AsideEvalResult {
  return { ok: true, stdout, durationMs: 1, error: null };
}

function fail(error: string): AsideEvalResult {
  return { ok: false, stdout: '', durationMs: 1, error };
}

function fakeRepl(responses: { blogId?: AsideEvalResult; categories?: AsideEvalResult }): AsideReplApi {
  return {
    async start() {},
    async dispose() {},
    async evaluate(js: string): Promise<AsideEvalResult> {
      if (js.includes('MyBlog.naver')) return responses.blogId ?? ok('{"url":null}');
      if (js.includes('querySelectorAll')) return responses.categories ?? ok('{"links":[]}');
      throw new Error(`예상치 못한 js: ${js}`);
    },
  };
}

describe('parseBlogIdFromUrl — 정상', () => {
  test('블로그 URL 에서 아이디를 뽑아낸다', () => {
    expect(parseBlogIdFromUrl('https://blog.naver.com/dev_king')).toBe('dev_king');
  });

  test('경로 뒤에 글번호가 붙어도 첫 세그먼트만 돌려준다', () => {
    expect(parseBlogIdFromUrl('https://blog.naver.com/dev_king/224388525239')).toBe('dev_king');
  });

  test('쿼리스트링이 붙어도 아이디만 돌려준다', () => {
    expect(parseBlogIdFromUrl('https://blog.naver.com/dev_king?Redirect=Write')).toBe('dev_king');
  });
});

describe('parseBlogIdFromUrl — 오추출 방지(회귀)', () => {
  // 실제로 겪은 오추출: 홈 피드 URL 에서 'BlogHome.naver' 가 blogId 로 읽혔다.
  test('section.blog.naver.com 홈 피드에서는 아이디를 뽑지 않는다', () => {
    expect(parseBlogIdFromUrl('https://section.blog.naver.com/BlogHome.naver?directoryNo=0')).toBeNull();
  });

  test('MyBlog.naver 같은 서비스 경로는 아이디가 아니다', () => {
    expect(parseBlogIdFromUrl('https://blog.naver.com/MyBlog.naver')).toBeNull();
  });

  test('PostList.naver 도 아이디가 아니다', () => {
    expect(parseBlogIdFromUrl('https://blog.naver.com/PostList.naver?blogId=dev_king')).toBeNull();
  });

  test('네이버 로그인 페이지에서는 아이디를 뽑지 않는다', () => {
    expect(parseBlogIdFromUrl('https://nid.naver.com/nidlogin.login')).toBeNull();
  });
});

describe('parseBlogIdFromUrl — 경계값/에러', () => {
  test('빈 문자열은 null 이다', () => {
    expect(parseBlogIdFromUrl('')).toBeNull();
  });

  test('문자열이 아닌 값은 null 이다', () => {
    expect(parseBlogIdFromUrl(null)).toBeNull();
    expect(parseBlogIdFromUrl(undefined)).toBeNull();
    expect(parseBlogIdFromUrl(42)).toBeNull();
  });

  test('URL 로 파싱되지 않는 문자열은 null 이다', () => {
    expect(parseBlogIdFromUrl('blog.naver.com/dev_king')).toBeNull();
  });

  test('경로가 비어 있으면 null 이다', () => {
    expect(parseBlogIdFromUrl('https://blog.naver.com/')).toBeNull();
  });

  test('아이디 문자셋을 벗어나면 null 이다', () => {
    expect(parseBlogIdFromUrl('https://blog.naver.com/한글아이디')).toBeNull();
  });
});

describe('parseCategoryNames — 정상', () => {
  test('카테고리 이름을 순서대로 중복 없이 뽑는다', () => {
    const links = [
      { text: '전체보기', href: '/PostList.naver?blogId=dev_king&categoryNo=0&from=postList' },
      { text: '테슬라', href: '/PostList.naver?blogId=dev_king&from=postList&categoryNo=6' },
      { text: '맛집 뿌시기', href: '/PostList.naver?blogId=dev_king&from=postList&categoryNo=7' },
      { text: '맛집 뿌시기', href: '/PostList.naver?blogId=dev_king&categoryNo=7&parentCategoryNo=7' },
    ];
    expect(parseCategoryNames(links)).toEqual(['테슬라', '맛집 뿌시기']);
  });

  test('categoryNo 가 없는 링크는 무시한다', () => {
    const links = [
      { text: '이웃블로그', href: '/blogpeople' },
      { text: '테슬라', href: '/PostList.naver?categoryNo=6' },
    ];
    expect(parseCategoryNames(links)).toEqual(['테슬라']);
  });

  test('이름 앞뒤 공백을 제거한다', () => {
    expect(parseCategoryNames([{ text: '  테슬라\n', href: '?categoryNo=6' }])).toEqual(['테슬라']);
  });

  // 실측 회귀: 같은 카테고리가 사이드바에서는 U+00A0(NBSP), 목록에서는 U+0020 으로 마크업되어
  // 중복 제거를 통과해 두 번 기록됐다.
  test('NBSP 와 일반 공백만 다른 같은 이름을 중복으로 본다', () => {
    const links = [
      { text: '맛집 뿌시기', href: '?categoryNo=7' },
      { text: '맛집\u00A0뿌시기', href: '?categoryNo=7' },
    ];
    expect(parseCategoryNames(links)).toEqual(['맛집 뿌시기']);
  });

  test('이름 가운데 공백이 여러 칸이어도 한 칸으로 정규화한다', () => {
    expect(parseCategoryNames([{ text: '맛집   뿌시기', href: '?categoryNo=7' }])).toEqual(['맛집 뿌시기']);
  });
});

describe('parseCategoryNames — 경계값/에러', () => {
  test('빈 배열은 빈 배열이다', () => {
    expect(parseCategoryNames([])).toEqual([]);
  });

  test('배열이 아니면 빈 배열이다', () => {
    expect(parseCategoryNames(null)).toEqual([]);
    expect(parseCategoryNames(undefined)).toEqual([]);
    expect(parseCategoryNames('테슬라')).toEqual([]);
  });

  test('형태가 어긋난 원소는 건너뛰고 나머지는 살린다', () => {
    const links = [null, 'x', { text: 1, href: '?categoryNo=6' }, { text: '테슬라', href: '?categoryNo=6' }];
    expect(parseCategoryNames(links)).toEqual(['테슬라']);
  });

  test('이름이 공백뿐이면 제외한다', () => {
    expect(parseCategoryNames([{ text: '   ', href: '?categoryNo=6' }])).toEqual([]);
  });
});

describe('upsertEnv — 정상', () => {
  test('빈 내용에 키를 추가한다', () => {
    expect(upsertEnv('', { NAVER_BLOG_ID: 'dev_king' })).toBe('NAVER_BLOG_ID=dev_king\n');
  });

  test('기존 키는 제자리에서 값만 바꾼다', () => {
    const before = 'ANB_CLAUDE_BIN=claude\nNAVER_BLOG_ID=old\nANB_ASIDE_BIN=aside\n';
    expect(upsertEnv(before, { NAVER_BLOG_ID: 'dev_king' })).toBe(
      'ANB_CLAUDE_BIN=claude\nNAVER_BLOG_ID=dev_king\nANB_ASIDE_BIN=aside\n',
    );
  });

  test('주석과 다른 키를 보존하고 새 키만 덧붙인다', () => {
    const before = '# 기본값: claude\nANB_CLAUDE_BIN=claude\n';
    expect(upsertEnv(before, { NAVER_BLOG_ID: 'dev_king' })).toBe(
      '# 기본값: claude\nANB_CLAUDE_BIN=claude\nNAVER_BLOG_ID=dev_king\n',
    );
  });

  test('공백이 든 값은 큰따옴표로 감싼다', () => {
    expect(upsertEnv('', { NAVER_BLOG_CATEGORIES: '테슬라,맛집 뿌시기' })).toBe(
      'NAVER_BLOG_CATEGORIES="테슬라,맛집 뿌시기"\n',
    );
  });
});

describe('upsertEnv — 경계값', () => {
  test('빈 값도 키를 남긴다', () => {
    expect(upsertEnv('', { NAVER_BLOG_CATEGORIES: '' })).toBe('NAVER_BLOG_CATEGORIES=\n');
  });

  test('값이 없으면(빈 객체) 내용을 바꾸지 않는다', () => {
    expect(upsertEnv('A=1\n', {})).toBe('A=1\n');
  });

  test('끝에 개행이 없던 파일도 개행 하나로 끝난다', () => {
    expect(upsertEnv('A=1', { B: '2' })).toBe('A=1\nB=2\n');
  });

  test('빈 줄이 여러 개여도 키가 중복되지 않는다', () => {
    expect(upsertEnv('A=1\n\n\n', { A: '2' })).toBe('A=2\n');
  });
});

// 실측 회귀(2026-08-29): 카테고리 링크가 하나라도 보이면 즉시 읽던 시절, 사이드바가
// 아직 그려지는 중이라 2개 중 1개만 .env 에 기록된 적이 있다. 이제는 개수가 연속 두 번
// 같아질 때까지 기다린 뒤 읽는다.
// 실측 회귀(2026-08-29): 카테고리 링크가 하나라도 보이면 즉시 읽던 시절, 사이드바가 아직
// 그려지는 중이라 2개 중 1개만 .env 에 기록됐다. 이제는 링크 개수가 연속 두 번 같아질
// 때까지(=렌더링이 멎을 때까지) 기다린 뒤 읽는다.
//
// 안정화 루프 자체는 브라우저 안에서 도는 코드라 가짜 REPL 로 재현할 수 없다 — 여기서는
// 그 루프가 페이로드에 실제로 들어 있는지만 고정하고, 동작은 라이브에서 확인했다
// (카테고리 2개가 모두 .env 에 기록되는 것을 재실행으로 확인).
describe('discoverBlogMeta — 점진 렌더링 대비', () => {
  test('카테고리 조회 페이로드에 안정화 조건이 들어 있다(첫 링크에서 멈추지 않는다)', async () => {
    const calls: string[] = [];
    const repl: AsideReplApi = {
      async start() {},
      async dispose() {},
      async evaluate(js: string): Promise<AsideEvalResult> {
        calls.push(js);
        if (js.includes('MyBlog.naver')) return ok('{"url":"https://blog.naver.com/dev_king"}');
        return ok(JSON.stringify({ links: [{ text: '테슬라', href: '?categoryNo=6' }] }));
      },
    };

    await discoverBlogMeta(repl);

    const categoryJs = calls.find((js) => js.includes('querySelectorAll'));
    expect(categoryJs).toContain('current === previous');
    expect(categoryJs).toContain('countCategories');
  });

  test('마지막으로 읽은 목록 전체가 결과에 반영된다', async () => {
    const repl: AsideReplApi = {
      async start() {},
      async dispose() {},
      async evaluate(js: string): Promise<AsideEvalResult> {
        if (js.includes('MyBlog.naver')) return ok('{"url":"https://blog.naver.com/dev_king"}');
        return ok(
          JSON.stringify({
            links: [
              { text: '맛집 뿌시기', href: '?categoryNo=7' },
              { text: '테슬라', href: '?categoryNo=6' },
            ],
          }),
        );
      },
    };

    expect((await discoverBlogMeta(repl)).categories).toEqual(['맛집 뿌시기', '테슬라']);
  });
});

describe('discoverBlogMeta — 정상', () => {
  test('blogId 와 카테고리를 함께 돌려준다', async () => {
    const repl = fakeRepl({
      blogId: ok('{"url":"https://blog.naver.com/dev_king"}'),
      categories: ok('{"links":[{"text":"테슬라","href":"?categoryNo=6"}]}'),
    });
    expect(await discoverBlogMeta(repl)).toEqual({ blogId: 'dev_king', categories: ['테슬라'] });
  });

  test('카테고리가 하나도 없으면 빈 배열이다', async () => {
    const repl = fakeRepl({
      blogId: ok('{"url":"https://blog.naver.com/dev_king"}'),
      categories: ok('{"links":[]}'),
    });
    expect(await discoverBlogMeta(repl)).toEqual({ blogId: 'dev_king', categories: [] });
  });
});

describe('discoverBlogMeta — 에러', () => {
  test('blogId 조회 evaluate 가 실패하면 사유를 담아 던진다', async () => {
    const repl = fakeRepl({ blogId: fail('repl 죽음') });
    await expect(discoverBlogMeta(repl)).rejects.toThrow('repl 죽음');
  });

  test('로그인되지 않아 blogId 를 못 읽으면 던진다', async () => {
    const repl = fakeRepl({ blogId: ok('{"url":"https://nid.naver.com/nidlogin.login"}') });
    await expect(discoverBlogMeta(repl)).rejects.toThrow('로그인 상태를 확인하세요');
  });

  test('stdout 이 JSON 이 아니면 던진다', async () => {
    const repl = fakeRepl({ blogId: ok('not json') });
    await expect(discoverBlogMeta(repl)).rejects.toThrow('JSON으로 파싱하지 못했습니다');
  });

  test('카테고리 조회가 실패하면 던진다', async () => {
    const repl = fakeRepl({
      blogId: ok('{"url":"https://blog.naver.com/dev_king"}'),
      categories: fail('타임아웃'),
    });
    await expect(discoverBlogMeta(repl)).rejects.toThrow('타임아웃');
  });
});

describe('writeBlogMetaEnv', () => {
  let envPath: string;

  beforeEach(async () => {
    await mkdir(scratchDir, { recursive: true });
    envPath = path.join(scratchDir, '.env');
  });

  afterEach(async () => {
    await rm(scratchDir, { recursive: true, force: true });
  });

  test('정상: .env 가 없으면 새로 만들어 두 키를 쓴다', async () => {
    const result = await writeBlogMetaEnv(envPath, { blogId: 'dev_king', categories: ['테슬라', '맛집 뿌시기'] });
    expect(result).toEqual({ written: ['테슬라', '맛집 뿌시기'], skipped: [] });
    expect(await readFile(envPath, 'utf8')).toBe(
      'NAVER_BLOG_ID=dev_king\nNAVER_BLOG_CATEGORIES="테슬라,맛집 뿌시기"\n',
    );
  });

  test('정상: 기존 .env 의 다른 키를 보존한다', async () => {
    await writeFile(envPath, 'ANB_CLAUDE_BIN=claude\n', 'utf8');
    await writeBlogMetaEnv(envPath, { blogId: 'dev_king', categories: [] });
    const content = await readFile(envPath, 'utf8');
    expect(content).toContain('ANB_CLAUDE_BIN=claude');
    expect(content).toContain('NAVER_BLOG_ID=dev_king');
  });

  test('경계값: 카테고리가 없으면 빈 값으로 기록한다', async () => {
    const result = await writeBlogMetaEnv(envPath, { blogId: 'dev_king', categories: [] });
    expect(result.written).toEqual([]);
    expect(await readFile(envPath, 'utf8')).toContain('NAVER_BLOG_CATEGORIES=\n');
  });

  test('에러 방지: 쉼표·큰따옴표가 든 이름은 기록하지 않고 skipped 로 알린다', async () => {
    const result = await writeBlogMetaEnv(envPath, {
      blogId: 'dev_king',
      categories: ['테슬라', '맛집, 카페', '그가 말한 "맛집"'],
    });
    expect(result.written).toEqual(['테슬라']);
    expect(result.skipped).toEqual(['맛집, 카페', '그가 말한 "맛집"']);
    expect(await readFile(envPath, 'utf8')).toContain('NAVER_BLOG_CATEGORIES="테슬라"\n');
  });
});
