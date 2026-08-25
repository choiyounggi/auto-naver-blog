#!/usr/bin/env node
// 네이버 로그인 부트스트랩 CLI.
// 사람이 Aside 브라우저에서 직접 로그인하도록 페이지를 열어주고, 로그인 완료를 감지하면
// 쿠키를 저장한다. ID/PW 를 자동으로 입력하지 않으며, 자격증명을 인자·환경변수로도 받지 않는다.

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

const { loadConfig } = await import('../lib/config.ts');
const { AsideRepl } = await import('../lib/aside/repl.ts');
const { NaverSession } = await import('../lib/aside/naver-session.ts');

const LOGIN_URL = 'https://nid.naver.com/nidlogin.login';
const POLL_INTERVAL_MS = 3000;
const LOGIN_WAIT_TIMEOUT_MS = 5 * 60 * 1000;

const OPEN_LOGIN_JS = `
(async () => {
  await openTab(${JSON.stringify(LOGIN_URL)});
  console.log(JSON.stringify({ opened: true }));
})();
`;

// 탭을 새로 열지도, 다른 페이지로 이동시키지도 않는다 — 현재 URL만 읽어 로그인 완료 여부를
// 추정한다. 사용자가 로그인 폼을 채우는 도중 탭을 이동시키면 안 되기 때문이다.
const READ_CURRENT_URL_JS = `
(async () => {
  console.log(JSON.stringify({ url: page.url() }));
})();
`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForLogin(repl) {
  const deadline = Date.now() + LOGIN_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await repl.evaluate(READ_CURRENT_URL_JS);
    if (result.ok) {
      try {
        const { url } = JSON.parse(result.stdout);
        if (typeof url === 'string' && !url.includes('nid.naver.com')) {
          return true;
        }
      } catch {
        // 파싱 실패는 무시하고 다음 폴링을 기다린다
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return false;
}

async function main() {
  const config = loadConfig();
  const repl = new AsideRepl(config);
  const session = new NaverSession(repl, config);

  try {
    await repl.start();

    const opened = await repl.evaluate(OPEN_LOGIN_JS);
    if (!opened.ok) {
      console.error(`로그인 페이지를 여는 데 실패했습니다: ${opened.error ?? 'unknown error'}`);
      process.exitCode = 1;
      return;
    }

    console.log(
      "Aside 브라우저에 네이버 로그인 페이지를 열었습니다. 직접 로그인해 주세요. " +
        "'로그인 상태 유지'를 체크하면 세션이 오래 갑니다. 완료되면 이 창은 자동으로 감지합니다.",
    );

    const loggedIn = await waitForLogin(repl);
    if (!loggedIn) {
      console.error('로그인 대기 시간이 초과되었습니다 (5분). 다시 시도해 주세요.');
      process.exitCode = 1;
      return;
    }

    const savedCount = await session.exportCookies();
    console.log(savedCount);
  } finally {
    await repl.dispose();
  }
}

main().catch((err) => {
  console.error(`naver-login 실행 중 오류: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
