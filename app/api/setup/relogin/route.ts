import { rm } from 'node:fs/promises';
import { NextResponse } from 'next/server';
import { AsideRepl } from '@/lib/aside/repl';
import { LoginTimeoutError, runNaverLoginFlow } from '@/lib/aside/login-flow';
import { NaverSession } from '@/lib/aside/naver-session';
import { readSetupState } from '@/lib/aside/blog-meta';
import { clearVerifyCache, writeVerifyCache } from '@/lib/aside/login-verify-cache';
import { ENV_FILE_PATH, loadConfig } from '@/lib/config';

export const maxDuration = 360;

let inFlight: Promise<Response> | null = null;

/**
 * 강제 재로그인.
 *
 * 브라우저에서 로그아웃하는 것만으로는 부족하다 — 이 앱의 로그인 확인은 저장해 둔 쿠키를
 * 브라우저에 **복원**하기 때문에, 로그아웃해도 곧바로 다시 로그인된 상태가 된다(실측).
 * 그래서 저장된 쿠키 파일을 지우고, 네이버에서도 로그아웃한 뒤 로그인 화면부터 다시 시작한다.
 * 그래야 '로그인 상태 유지' 를 켤 수 있고, 그때부터 로그인이 오래 간다.
 *
 * 자격증명은 여기서도 다루지 않는다 — 사람이 직접 입력한다.
 */
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
      // 복원될 여지를 먼저 없앤다. 없는 파일을 지워도 조용히 넘어간다.
      await rm(config.cookieFile, { force: true });

      await repl.start();
      clearVerifyCache();
      const result = await runNaverLoginFlow(repl, session, {
        envPath: ENV_FILE_PATH,
        cookieFile: config.cookieFile,
        forceRelogin: true,
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
