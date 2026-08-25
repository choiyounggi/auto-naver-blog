#!/usr/bin/env node
// 네이버 로그인 부트스트랩 CLI.
// 사람이 Aside 브라우저에서 직접 로그인하도록 페이지를 열어주고, 로그인 완료를 감지하면
// 쿠키를 저장한 뒤 블로그 아이디와 카테고리 목록을 뽑아 .env 에 기록한다.
// ID/PW 를 자동으로 입력하지 않으며, 자격증명을 인자·환경변수로도 받지 않는다.
//
// 실제 절차는 lib/aside/login-flow.ts 에 있다 — 웹 온보딩 화면도 같은 코드를 쓴다.

import { registerHooks } from 'node:module';

// lib/aside/*.ts 는 tsc(bundler moduleResolution)에 맞춰 확장자 없이 상대경로를 import 한다.
// Node 의 네이티브 TypeScript 실행기는 확장자가 정확히 일치하는 파일만 찾으므로, 이 스크립트
// 안에서만 상대경로 뒤에 .ts 를 붙여 재시도하는 resolve 훅을 등록해 그 간극을 메운다.
// 공유 tsconfig.json 은 건드리지 않는다.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[a-zA-Z0-9]+$/.test(specifier)) {
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch {
        // 폴백: 기본 동작으로 넘긴다
      }
    }
    return nextResolve(specifier, context);
  },
});

const { loadConfig, ENV_FILE_PATH } = await import('../lib/config.ts');
const { AsideRepl } = await import('../lib/aside/repl.ts');
const { NaverSession } = await import('../lib/aside/naver-session.ts');
const { runNaverLoginFlow } = await import('../lib/aside/login-flow.ts');

async function main() {
  const config = loadConfig();
  const repl = new AsideRepl(config);
  const session = new NaverSession(repl, config);

  try {
    await repl.start();

    const result = await runNaverLoginFlow(repl, session, {
      envPath: ENV_FILE_PATH,
      onMessage: (message) => console.log(message),
    });

    console.log(`쿠키 파일: ${config.cookieFile}`);
    console.log(`블로그 아이디: ${result.blogId}`);
    console.log(`카테고리 ${result.categories.length}개: ${result.categories.join(', ') || '(없음)'}`);
    if (result.skippedCategories.length > 0) {
      console.log(
        `※ 쉼표·큰따옴표가 들어 있어 .env 에 기록하지 못한 카테고리: ${result.skippedCategories.join(' / ')}`,
      );
    }
    console.log(`.env 에 기록했습니다: ${ENV_FILE_PATH}`);
  } finally {
    await repl.dispose();
  }
}

main().catch((err) => {
  console.error(`naver-login 실행 중 오류: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
