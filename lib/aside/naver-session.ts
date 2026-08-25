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

// F2(r1): 로그인 여부를 "로그인 페이지로 튕기지 않았다"는 부재(absence)로 판정하지 않는다 —
// 네트워크 오류·점검 페이지 등 로그인과 무관한 이유로도 nid.naver.com 을 거치지 않을 수 있고,
// 그 경우 전부 loggedIn:true 로 잘못 판정된다. 대신 로그인 상태에서만 존재하는 신호(presence)
// 로 판정한다: blog.naver.com 이동 후 자기 블로그(`blog.naver.com/<blogId>`)로 리다이렉트되어
// blogId 를 추출할 수 있는지가 그 신호다(D13이 이미 이 값을 "로그인의 blogId" 로 정의해 둠).
// blogId 추출에 실패하면 로그인되지 않은 것으로 본다 — status() 가 사유(expired/unknown)를 정한다.
const STATUS_CHECK_JS = `
(async () => {
  await page.goto('https://blog.naver.com');
  const url = page.url();
  const match = url.match(/blog\\.naver\\.com\\/([^/?#]+)/);
  const blogId = match ? match[1] : null;
  console.log(JSON.stringify({ blogId }));
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

    let parsed: { blogId?: unknown };
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      return { loggedIn: false, reason: 'unknown', checkedAt };
    }

    // F2(r1): 페이지에서 blogId 를 뽑아내지 못하면(양성 신호 없음) 로그인되지 않은 것으로
    // 본다. 이 시점까지 evaluate() 자체는 성공했으므로(판정을 시도할 수 있었으므로) 사유는
    // 'unknown' 이 아니라 'expired' 다 — 판정 자체를 못 한 경우(evaluate 실패·JSON 파싱
    // 실패)는 이미 위에서 'unknown' 으로 갈렸다.
    const pageBlogId = typeof parsed.blogId === 'string' && parsed.blogId.length > 0 ? parsed.blogId : null;
    if (!pageBlogId) {
      return { loggedIn: false, reason: 'expired', checkedAt };
    }

    // D13: 로그인은 이미 페이지 신호로 확인됐다 — blogId 값 자체는 config.naverBlogId 가
    // 있으면 그걸 우선하고, 없으면 페이지에서 읽어낸 값을 쓴다.
    const blogId = this.config.naverBlogId ?? pageBlogId;
    return { loggedIn: true, blogId, checkedAt };
  }
}
