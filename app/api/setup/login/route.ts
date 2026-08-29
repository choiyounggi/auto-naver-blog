import { NextResponse } from 'next/server';
import { AsideRepl } from '@/lib/aside/repl';
import { LoginTimeoutError, runNaverLoginFlow } from '@/lib/aside/login-flow';
import { NaverSession } from '@/lib/aside/naver-session';
import { readSetupState } from '@/lib/aside/blog-meta';
import { clearVerifyCache, writeVerifyCache } from '@/lib/aside/login-verify-cache';
import { ENV_FILE_PATH, loadConfig } from '@/lib/config';

// 사람이 로그인을 마칠 때까지 최대 5분 기다린다 — Next 기본 응답 제한을 넘기지 않도록
// 라우트 단위로 늘려 둔다.
export const maxDuration = 360;

// 동시에 두 개의 로그인 창을 띄우지 않는다. 로컬 단일 사용자용이므로 이 정도로 충분하다.
let inFlight: Promise<Response> | null = null;

// 온보딩 화면의 "네이버 로그인 시작" 버튼. CLI(`npm run naver:login`)와 같은 플로우를 쓴다 —
// 자격증명은 받지도, 입력하지도 않는다. 사람이 Aside 브라우저에서 직접 로그인한다.
export async function POST(): Promise<Response> {
  if (inFlight) {
    return NextResponse.json(
      { error: '이미 로그인 창이 열려 있습니다 — Aside 브라우저에서 로그인을 마쳐 주세요.' },
      { status: 409 },
    );
  }

  const run = (async (): Promise<Response> => {
    const config = loadConfig();
    const repl = new AsideRepl(config);
    const session = new NaverSession(repl, config);

    try {
      await repl.start();
      clearVerifyCache();
      const result = await runNaverLoginFlow(repl, session, {
        envPath: ENV_FILE_PATH,
        cookieFile: config.cookieFile,
      });
      const state = await readSetupState({
        envPath: ENV_FILE_PATH,
        cookieFile: config.cookieFile,
        envOverrides: { blogId: config.naverBlogId },
      });
      // 방금 로그인을 확인하고 온 길이므로 캐시도 그 결과로 갱신한다.
      writeVerifyCache({ loggedIn: true, reason: null }, Date.now());
      return NextResponse.json({
        ...state,
        loggedIn: true,
        reason: null,
        skippedCategories: result.skippedCategories,
        persistence: result.persistence,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 시간 초과는 사용자가 다시 시도하면 되는 상황이므로 500 이 아니라 408 로 구분한다.
      const status = err instanceof LoginTimeoutError ? 408 : 500;
      return NextResponse.json({ error: message }, { status });
    } finally {
      await repl.dispose();
    }
  })();

  inFlight = run;
  try {
    return await run;
  } finally {
    inFlight = null;
  }
}
