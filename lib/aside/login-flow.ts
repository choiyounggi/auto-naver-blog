import { MY_BLOG_URL, discoverBlogMeta, parseBlogIdFromUrl, writeBlogMetaEnv } from './blog-meta';
import { parseLastJson } from './protocol';
import type { AsideReplApi, NaverSessionApi } from '../types';

export interface LoginFlowResult {
  alreadyLoggedIn: boolean;
  cookieCount: number;
  blogId: string;
  categories: string[];
  /** 쉼표·큰따옴표 때문에 .env 에 기록하지 못한 카테고리 이름 (조용히 버리지 않는다) */
  skippedCategories: string[];
}

export interface LoginFlowOptions {
  envPath: string;
  pollIntervalMs?: number;
  loginTimeoutMs?: number;
  /** 사람에게 보여줄 진행 메시지 — CLI 는 콘솔에, API 는 무시한다 */
  onMessage?: (message: string) => void;
}

export class LoginTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`로그인 대기 시간이 초과되었습니다 (${Math.round(timeoutMs / 60000)}분). 다시 시도해 주세요.`);
    this.name = 'LoginTimeoutError';
  }
}

const DEFAULT_POLL_INTERVAL_MS = 3000;
const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

// openTab 은 리다이렉트가 끝나기 전에 돌아올 수 있다 — MyBlog.naver 를 벗어날 때까지
// 잠깐 더 기다려야 "이미 로그인됨"을 오판하지 않는다(최대 5초).
const OPEN_MY_BLOG_JS = `
await (async () => {
  await openTab(${JSON.stringify(MY_BLOG_URL)});
  for (let attempt = 0; attempt < 10 && page.url().includes('MyBlog.naver'); attempt++) {
    await sleep(500);
  }
  console.log(JSON.stringify({ url: page.url() }));
})();
`;

// 탭을 이동시키지 않고 현재 URL만 읽는다 — 사람이 로그인 폼을 채우는 도중에 페이지를
// 옮겨버리면 안 되기 때문이다.
const READ_CURRENT_URL_JS = `
await (async () => {
  console.log(JSON.stringify({ url: page.url() }));
})();
`;

// 로그인은 끝났는데 블로그가 아닌 곳(예: 네이버 메인)에 머문 경우에만 다시 내 블로그로
// 보낸다. nid.naver.com 에 있는 동안에는 절대 건드리지 않는다(로그인 진행 중이므로).
const GO_TO_MY_BLOG_JS = `
await (async () => {
  await page.goto(${JSON.stringify(MY_BLOG_URL)}, { waitUntil: 'domcontentloaded' });
  console.log(JSON.stringify({ url: page.url() }));
})();
`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// openTab 은 JSON 앞에 사람이 읽는 배너를 찍는다 — stdout 전체가 아니라 마지막 JSON 줄만 읽는다.
function readUrl(result: { ok: boolean; stdout: string }): string | null {
  if (!result.ok) return null;
  const parsed = parseLastJson<{ url?: unknown }>(result.stdout);
  if (parsed === null) return null;
  return typeof parsed.url === 'string' ? parsed.url : null;
}

/**
 * 사람이 Aside 브라우저에서 직접 로그인하도록 "내 블로그"를 열고, 로그인이 확인되면
 * 쿠키를 저장한 뒤 블로그 아이디·카테고리를 .env 에 기록한다.
 *
 * 자격증명을 입력하거나 전달받는 경로는 이 함수 어디에도 없다 — 로그인은 항상 사람이 한다.
 */
export async function runNaverLoginFlow(
  repl: AsideReplApi,
  session: NaverSessionApi,
  options: LoginFlowOptions,
): Promise<LoginFlowResult> {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const loginTimeoutMs = options.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
  const notify = options.onMessage ?? (() => {});

  const opened = await repl.evaluate(OPEN_MY_BLOG_JS);
  if (!opened.ok) {
    throw new Error(`내 블로그 페이지를 여는 데 실패했습니다: ${opened.error ?? 'unknown error'}`);
  }

  const openedUrl = readUrl(opened);
  const alreadyLoggedIn = openedUrl !== null && parseBlogIdFromUrl(openedUrl) !== null;

  if (alreadyLoggedIn) {
    notify('이미 로그인되어 있습니다 — 로그인 단계를 건너뜁니다.');
  } else {
    notify(
      'Aside 브라우저에 네이버 로그인 페이지를 열었습니다. 직접 로그인해 주세요. ' +
        "'로그인 상태 유지'를 체크하면 세션이 오래 갑니다. 완료되면 자동으로 감지합니다.",
    );
    const loggedIn = await waitForLogin(repl, pollIntervalMs, loginTimeoutMs);
    if (!loggedIn) throw new LoginTimeoutError(loginTimeoutMs);
  }

  const cookieCount = await session.exportCookies();
  notify(`쿠키 ${cookieCount}개를 저장했습니다.`);

  const meta = await discoverBlogMeta(repl);
  const { written, skipped } = await writeBlogMetaEnv(options.envPath, meta);

  return {
    alreadyLoggedIn,
    cookieCount,
    blogId: meta.blogId,
    categories: written,
    skippedCategories: skipped,
  };
}

// 로그인 완료를 "로그인 페이지를 벗어났다"(부재)가 아니라 "내 블로그 아이디를 읽어냈다"
// (존재)로 판정한다 — 네트워크 오류나 점검 페이지도 로그인 페이지를 벗어나기 때문이다.
async function waitForLogin(
  repl: AsideReplApi,
  pollIntervalMs: number,
  loginTimeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + loginTimeoutMs;
  while (Date.now() < deadline) {
    await sleep(pollIntervalMs);

    const url = readUrl(await repl.evaluate(READ_CURRENT_URL_JS));
    if (url === null) continue;

    if (parseBlogIdFromUrl(url) !== null) return true;

    // 로그인 페이지를 떠났는데 블로그도 아니라면 로그인 후 다른 곳으로 보내진 것이다.
    if (!url.includes('nid.naver.com')) {
      const retried = readUrl(await repl.evaluate(GO_TO_MY_BLOG_JS));
      if (retried !== null && parseBlogIdFromUrl(retried) !== null) return true;
    }
  }
  return false;
}
