import { NextResponse } from 'next/server';
import { AsideRepl } from '@/lib/aside/repl';
import { NaverSession } from '@/lib/aside/naver-session';
import { readSetupState } from '@/lib/aside/blog-meta';
import { readLoginPersistence } from '@/lib/aside/login-persistence';
import { ENV_FILE_PATH, loadConfig } from '@/lib/config';
import type { AppConfig } from '@/lib/config';

// 라이브 확인은 Aside 브라우저를 띄워 네이버로 이동하므로 몇 초 걸린다.
export const maxDuration = 120;

// 같은 확인을 여러 번 겹쳐 돌리지 않는다 — 진행 중인 확인이 있으면 그 결과를 함께 쓴다.
let inFlightVerify: Promise<{ loggedIn: boolean; reason: string | null }> | null = null;

/**
 * 저장된 쿠키로 실제 로그인이 살아 있는지 확인한다.
 *
 * 파일만 봐서는 알 수 없다 — 브라우저에서 로그아웃해도 쿠키 파일과 .env 는 그대로라
 * "준비됨" 으로 보인다(실측: 로그아웃 후에도 온보딩이 뜨지 않았다).
 */
async function verifyLogin(config: AppConfig): Promise<{ loggedIn: boolean; reason: string | null }> {
  const repl = new AsideRepl(config);
  const session = new NaverSession(repl, config);
  try {
    await repl.start();
    const status = await session.status();
    return status.loggedIn ? { loggedIn: true, reason: null } : { loggedIn: false, reason: status.reason };
  } catch {
    // 확인 자체를 못 했으면 로그인 여부를 단정하지 않는다 — 사유를 'unknown' 으로 남긴다.
    return { loggedIn: false, reason: 'unknown' };
  } finally {
    await repl.dispose();
  }
}

/**
 * 온보딩 화면이 쓰는 상태. process.env 가 아니라 .env 파일을 읽으므로, 서버를 띄운 뒤
 * 로그인해도 재시작 없이 반영된다.
 *
 * `?verify=1` 을 주면 저장된 쿠키가 실제로 살아 있는지까지 확인한다(느리다).
 */
export async function GET(request: Request): Promise<Response> {
  const config = loadConfig();
  const state = await readSetupState({
    envPath: ENV_FILE_PATH,
    cookieFile: config.cookieFile,
    envOverrides: { blogId: config.naverBlogId },
  });

  // 쿠키 파일만 읽으면 되므로 항상 함께 준다 — 로그인이 오래 갈지 화면에서 알려주기 위함이다.
  const persistence = await readLoginPersistence(config.cookieFile);

  const verify = new URL(request.url).searchParams.get('verify') === '1';
  // 파일 기준으로도 준비가 안 됐으면 브라우저를 띄울 이유가 없다.
  if (!verify || !state.ready) {
    return NextResponse.json({ ...state, loggedIn: null, reason: null, persistence });
  }

  inFlightVerify = inFlightVerify ?? verifyLogin(config);
  let result: { loggedIn: boolean; reason: string | null };
  try {
    result = await inFlightVerify;
  } finally {
    inFlightVerify = null;
  }

  return NextResponse.json({
    ...state,
    ready: state.ready && result.loggedIn,
    loggedIn: result.loggedIn,
    reason: result.reason,
    persistence,
  });
}
