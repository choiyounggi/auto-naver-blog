import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from '../config';
import type { AsideReplApi, NaverSessionApi, NaverSessionStatus } from '../types';

const COOKIE_FILE_MODE = 0o600;

// D11: 네이버 도메인 쿠키만 저장/복원한다. 다른 사이트 세션이 이 파일에 섞이면 안 된다.
function isNaverDomain(domain: unknown): boolean {
  return typeof domain === 'string' && (domain === 'naver.com' || domain.endsWith('.naver.com'));
}

// D5: 관찰된 응답 경로(`{ cookies: [...] }`)만 신뢰한다. 다른 필드는 추측하지 않는다.
const EXPORT_COOKIES_JS = `
(async () => {
  const result = await page.cdp.send('Storage.getCookies');
  console.log(JSON.stringify(result));
})();
`;

function buildImportCookiesJs(cookies: unknown[]): string {
  // danger_zone: 쿠키 저장소를 비우는 CDP 호출은 이 모듈 어디에도 있어서는 안 된다. setCookies 는 추가만 한다.
  return `
(async () => {
  await page.cdp.send('Storage.setCookies', { cookies: ${JSON.stringify(cookies)} });
  console.log(JSON.stringify({ restored: ${cookies.length} }));
})();
`;
}

// D10: blog.naver.com 이동 후 로그인 페이지로 리다이렉트됐는지로 로그인 여부를 판정한다.
const STATUS_CHECK_JS = `
(async () => {
  await page.goto('https://blog.naver.com');
  const url = page.url();
  const loggedIn = !url.includes('nid.naver.com');
  const match = url.match(/blog\\.naver\\.com\\/([^/?#]+)/);
  const blogId = match ? match[1] : null;
  console.log(JSON.stringify({ loggedIn, blogId }));
})();
`;

export class NaverSession implements NaverSessionApi {
  private readonly repl: AsideReplApi;
  private readonly config: AppConfig;

  constructor(repl: AsideReplApi, config: AppConfig) {
    this.repl = repl;
    this.config = config;
  }

  async exportCookies(): Promise<number> {
    const result = await this.repl.evaluate(EXPORT_COOKIES_JS);
    if (!result.ok) {
      throw new Error(`쿠키를 가져오지 못함: ${result.error ?? 'unknown error'}`);
    }

    let parsed: { cookies?: unknown[] };
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new Error('쿠키 응답을 JSON으로 파싱하지 못함');
    }

    const allCookies = Array.isArray(parsed.cookies) ? parsed.cookies : [];
    const naverCookies = allCookies.filter(
      (cookie) => typeof cookie === 'object' && cookie !== null && isNaverDomain((cookie as Record<string, unknown>).domain),
    );

    await mkdir(path.dirname(this.config.cookieFile), { recursive: true });
    await writeFile(this.config.cookieFile, JSON.stringify(naverCookies), 'utf8');
    await chmod(this.config.cookieFile, COOKIE_FILE_MODE);

    return naverCookies.length;
  }

  async importCookies(): Promise<number> {
    if (!existsSync(this.config.cookieFile)) {
      return 0;
    }

    const raw = await readFile(this.config.cookieFile, 'utf8');
    let cookies: unknown[];
    try {
      const parsed = JSON.parse(raw);
      cookies = Array.isArray(parsed) ? parsed : [];
    } catch {
      throw new Error('저장된 쿠키 파일을 JSON으로 파싱하지 못함');
    }

    if (cookies.length === 0) {
      return 0;
    }

    const result = await this.repl.evaluate(buildImportCookiesJs(cookies));
    if (!result.ok) {
      throw new Error(`쿠키를 복원하지 못함: ${result.error ?? 'unknown error'}`);
    }

    return cookies.length;
  }

  async status(): Promise<NaverSessionStatus> {
    const checkedAt = new Date().toISOString();

    if (!existsSync(this.config.cookieFile)) {
      return { loggedIn: false, reason: 'no-cookies', checkedAt };
    }

    try {
      await this.importCookies();
    } catch {
      return { loggedIn: false, reason: 'unknown', checkedAt };
    }

    const result = await this.repl.evaluate(STATUS_CHECK_JS);
    if (!result.ok) {
      return { loggedIn: false, reason: 'unknown', checkedAt };
    }

    let parsed: { loggedIn?: unknown; blogId?: unknown };
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      return { loggedIn: false, reason: 'unknown', checkedAt };
    }

    if (typeof parsed.loggedIn !== 'boolean') {
      return { loggedIn: false, reason: 'unknown', checkedAt };
    }

    if (!parsed.loggedIn) {
      return { loggedIn: false, reason: 'expired', checkedAt };
    }

    // D13: config.naverBlogId 가 우선, 없으면 페이지에서 읽어낸 값을 쓴다. 둘 다 없으면 unknown.
    const pageBlogId = typeof parsed.blogId === 'string' ? parsed.blogId : null;
    const blogId = this.config.naverBlogId ?? pageBlogId;
    if (!blogId) {
      return { loggedIn: false, reason: 'unknown', checkedAt };
    }

    return { loggedIn: true, blogId, checkedAt };
  }
}
