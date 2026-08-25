import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { parseLastJson } from './protocol';
import type { AsideReplApi } from '../types';

export interface BlogMeta {
  blogId: string;
  categories: string[];
}

export interface EnvWriteResult {
  /** .env 에 실제로 기록된 카테고리 이름들 */
  written: string[];
  /** 구분자와 충돌해 기록에서 제외된 이름들 (조용히 버리지 않고 호출자에게 알린다) */
  skipped: string[];
}

// 사람이 직접 로그인한 뒤 "내 블로그"로 가는 진입점. 로그인돼 있으면
// `https://blog.naver.com/<blogId>` 로 리다이렉트되고, 아니면 로그인 페이지로 튕긴다 —
// 그래서 이 URL 하나로 로그인 여부 판정과 blogId 추출을 동시에 한다.
export const MY_BLOG_URL = 'https://blog.naver.com/MyBlog.naver';

// `blog.naver.com` 바로 아래 첫 세그먼트만 blogId 후보다.
// - `section.blog.naver.com/BlogHome.naver` (블로그 홈 피드) 는 호스트가 다르므로 제외된다.
// - `blog.naver.com/PostList.naver`, `MyBlog.naver` 같은 서비스 경로는 `.naver` 로 끝나므로 제외된다.
// 이 두 구분이 없으면 홈 피드 URL 에서 `BlogHome.naver` 를 blogId 로 잘못 읽는다.
export function parseBlogIdFromUrl(url: unknown): string | null {
  if (typeof url !== 'string' || url === '') return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.hostname !== 'blog.naver.com') return null;

  const segment = parsed.pathname.split('/').filter((part) => part !== '')[0];
  if (segment === undefined) return null;
  if (segment.endsWith('.naver')) return null;
  // 네이버 아이디 문자셋 — 영문/숫자/밑줄/하이픈만 허용한다.
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return null;

  return segment;
}

// 블로그 첫 화면의 링크 목록에서 카테고리 이름만 순서대로 뽑는다.
// `categoryNo=0` 은 "전체보기" 라 실제 카테고리가 아니고, 같은 카테고리가 여러 번 링크되므로
// 중복을 제거한다.
export function parseCategoryNames(links: unknown): string[] {
  if (!Array.isArray(links)) return [];

  const names: string[] = [];
  for (const link of links) {
    if (typeof link !== 'object' || link === null) continue;
    const { text, href } = link as Record<string, unknown>;
    if (typeof text !== 'string' || typeof href !== 'string') continue;

    // 같은 카테고리가 일반 공백(U+0020)과 줄바꿈없는공백(U+00A0)으로 다르게 마크업되는
    // 경우가 있다(실측) — 공백을 정규화해야 중복 제거가 실제로 동작한다.
    const name = text.replace(/\s+/g, ' ').trim();
    if (name === '') continue;

    const match = href.match(/[?&]categoryNo=([0-9]+)/);
    if (match === null) continue;
    if (match[1] === '0') continue;
    if (names.includes(name)) continue;

    names.push(name);
  }
  return names;
}

// dotenv 가 값을 그대로 읽을 수 있는 형태로 만든다. 공백·`#` 등이 섞이면 큰따옴표로 감싼다.
function formatEnvValue(value: string): string {
  return /^[A-Za-z0-9_.:/-]*$/.test(value) ? value : `"${value}"`;
}

// 기존 .env 내용을 보존하면서 주어진 키만 갱신한다 — 없는 키는 끝에 덧붙인다.
// 주석과 다른 키는 그대로 둔다.
export function upsertEnv(content: string, values: Record<string, string>): string {
  const remaining = new Map(Object.entries(values));

  const lines = content === '' ? [] : content.split('\n');
  const out = lines.map((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (match === null) return line;

    const key = match[1];
    const value = remaining.get(key);
    if (value === undefined) return line;

    remaining.delete(key);
    return `${key}=${formatEnvValue(value)}`;
  });

  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  for (const [key, value] of remaining) {
    out.push(`${key}=${formatEnvValue(value)}`);
  }

  return out.length === 0 ? '' : `${out.join('\n')}\n`;
}

// D-nav: 네이버 블로그에서 옵션 없는 page.goto 는 Aside 의 "interactive page" 대기가
// 30초 타임아웃으로 실패한다(실측). domcontentloaded 로 낮추면 5초 안에 끝난다.
const RESOLVE_BLOG_ID_JS = `
await (async () => {
  await page.goto(${JSON.stringify(MY_BLOG_URL)}, { waitUntil: 'domcontentloaded' });
  console.log(JSON.stringify({ url: page.url() }));
})();
`;

function buildCategoriesJs(blogId: string): string {
  // 블로그 본문은 `iframe#mainFrame` 안에 렌더링된다 — 프레임이 없으면 문서 자체에서 찾는다.
  // domcontentloaded 시점에는 mainFrame 안이 아직 비어 있을 수 있으므로, 카테고리 링크가
  // 나타날 때까지 짧게 다시 읽는다(최대 10초). 그래도 없으면 빈 목록으로 끝낸다.
  return `
await (async () => {
  await page.goto('https://blog.naver.com/' + ${JSON.stringify(blogId)}, { waitUntil: 'domcontentloaded' });
  const read = () => page.evaluate(() => {
    const frame = document.querySelector('iframe#mainFrame');
    const doc = frame && frame.contentDocument ? frame.contentDocument : document;
    return Array.from(doc.querySelectorAll('a')).map((a) => ({ text: (a.textContent || '').trim(), href: a.getAttribute('href') || '' }));
  });
  let links = await read();
  for (let attempt = 0; attempt < 20 && !links.some((l) => l.href.includes('categoryNo=')); attempt++) {
    await sleep(500);
    links = await read();
  }
  console.log(JSON.stringify({ links }));
})();
`;
}

function parseStdout<T>(stdout: string, what: string): T {
  const parsed = parseLastJson<T>(stdout);
  if (parsed === null) {
    throw new Error(`${what} 응답을 JSON으로 파싱하지 못했습니다.`);
  }
  return parsed;
}

/** 로그인된 세션에서 blogId 와 카테고리 이름 목록을 읽어온다. */
export async function discoverBlogMeta(repl: AsideReplApi): Promise<BlogMeta> {
  const idResult = await repl.evaluate(RESOLVE_BLOG_ID_JS);
  if (!idResult.ok) {
    throw new Error(`블로그 아이디를 확인하지 못했습니다: ${idResult.error ?? 'unknown error'}`);
  }
  const { url } = parseStdout<{ url?: unknown }>(idResult.stdout, '블로그 아이디');

  const blogId = parseBlogIdFromUrl(url);
  if (blogId === null) {
    throw new Error(
      `블로그 아이디를 URL에서 읽어내지 못했습니다 (url=${String(url)}) — 로그인 상태를 확인하세요.`,
    );
  }

  const categoriesResult = await repl.evaluate(buildCategoriesJs(blogId));
  if (!categoriesResult.ok) {
    throw new Error(`카테고리를 가져오지 못했습니다: ${categoriesResult.error ?? 'unknown error'}`);
  }
  const { links } = parseStdout<{ links?: unknown }>(categoriesResult.stdout, '카테고리');

  return { blogId, categories: parseCategoryNames(links) };
}

/** blogId 와 카테고리를 .env 에 기록한다. 기존 키·주석은 보존한다. */
export async function writeBlogMetaEnv(envPath: string, meta: BlogMeta): Promise<EnvWriteResult> {
  // 쉼표로 이어 붙이므로 쉼표를 품은 이름은 되읽을 수 없다. 큰따옴표·줄바꿈도 같은 이유로
  // 제외하고, 무엇이 빠졌는지 호출자에게 돌려준다 — 조용히 버리지 않는다.
  const written: string[] = [];
  const skipped: string[] = [];
  for (const name of meta.categories) {
    if (/[,"\r\n]/.test(name)) skipped.push(name);
    else written.push(name);
  }

  const existing = existsSync(envPath) ? await readFile(envPath, 'utf8') : '';
  const next = upsertEnv(existing, {
    NAVER_BLOG_ID: meta.blogId,
    NAVER_BLOG_CATEGORIES: written.join(','),
  });
  await writeFile(envPath, next, 'utf8');

  return { written, skipped };
}

export interface SetupState {
  /** 업로드 화면을 열어도 되는 상태인가 (쿠키가 있고 블로그 아이디를 안다) */
  ready: boolean;
  hasCookies: boolean;
  blogId: string | null;
  categories: string[];
}

// dotenv 와 같은 최소 규칙만 다룬다: `KEY=VALUE`, `#` 로 시작하는 줄은 주석,
// 값 양끝의 큰따옴표는 벗긴다. upsertEnv 가 쓴 형식을 되읽는 짝이다.
export function parseEnvFile(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match === null) continue;

    const value = match[2].trim();
    values[match[1]] =
      value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
  }
  return values;
}

/**
 * 온보딩 화면이 쓰는 상태를 파일에서 직접 읽는다 — 서버 부팅 이후에 로그인해도 반영된다.
 * envOverrides 가 값을 주면 그것이 우선한다(process.env 로 명시한 설정이 파일보다 우선).
 */
export async function readSetupState(options: {
  envPath: string;
  cookieFile: string;
  envOverrides?: { blogId?: string | null; categories?: string | null };
}): Promise<SetupState> {
  const { envPath, cookieFile, envOverrides } = options;

  const fileValues = existsSync(envPath) ? parseEnvFile(await readFile(envPath, 'utf8')) : {};

  const blogIdRaw = envOverrides?.blogId ?? fileValues.NAVER_BLOG_ID ?? '';
  const blogId = blogIdRaw.trim() === '' ? null : blogIdRaw.trim();

  const categoriesRaw = envOverrides?.categories ?? fileValues.NAVER_BLOG_CATEGORIES ?? '';
  const categories = categoriesRaw
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');

  const hasCookies = existsSync(cookieFile);

  return { ready: hasCookies && blogId !== null, hasCookies, blogId, categories };
}
