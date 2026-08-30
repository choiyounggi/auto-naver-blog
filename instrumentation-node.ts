// t5 D1/D2: 조립은 lib/pipeline.ts 한 곳에서만 한다 — 여기서는 그 결과를 setServices() 로
// 주입하고, 프로세스 생명주기(종료 시 정리)를 배선하기만 한다.
import { checkBootConfig } from './lib/auth/config';
import { loadConfig } from './lib/config';
import { setServices } from './lib/job/services';
import { createServices, disposeServices } from './lib/pipeline';

// wiki:backend-node-runtime-graceful-shutdown Do this 3 — force-exit 타이머는 정리 시퀀스
// 전체를 감싸는 상한이다. lib/aside/repl.ts 의 FORCE_KILL_GRACE_MS(3000ms, 자식 프로세스
// 강제 종료)보다 여유 있게 잡아 REPL 자신의 정리가 먼저 끝날 시간을 준다.
const FORCE_EXIT_GRACE_MS = 5000;

let handlersRegistered = false;
let shuttingDown = false;

async function shutdown(exitCode: number): Promise<void> {
  // wiki:backend-node-runtime-graceful-shutdown 엣지 케이스 "Multiple SIGTERMs arrive":
  // 첫 신호만 시퀀스를 시작하고, 이후 신호는 무시한다.
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  // wiki:backend-node-runtime-graceful-shutdown Do this 3 — .unref() 해서 타이머 자체가
  // 프로세스를 붙잡지 않게 한다. 정리가 먼저 끝나면 clearTimeout 으로 취소된다.
  const forceExitTimer = setTimeout(() => {
    process.exit(exitCode);
  }, FORCE_EXIT_GRACE_MS);
  forceExitTimer.unref();

  try {
    await disposeServices();
  } catch (err) {
    console.error('[instrumentation] disposeServices() 중 오류:', err);
  } finally {
    clearTimeout(forceExitTimer);
    process.exit(exitCode);
  }
}

function registerShutdownHandlers(): void {
  // t5 D4: register() 가 여러 번 불려도 핸들러는 한 번만 등록한다.
  if (handlersRegistered) {
    return;
  }
  handlersRegistered = true;

  // wiki:backend-node-runtime-graceful-shutdown 시그널 표 — SIGINT 는 SIGTERM 과 같은
  // 핸들러를 쓴다(로컬 dev 의 Ctrl-C 가 같은 경로를 타야 하므로).
  process.on('SIGTERM', () => {
    void shutdown(0);
  });
  process.on('SIGINT', () => {
    void shutdown(0);
  });
  // wiki:backend-node-runtime-graceful-shutdown Do this 4 — 로그를 남기고 같은 타이머로
  // best-effort 정리한 뒤 비영점 종료한다. 프로세스 상태가 불명이므로 계속 도는 것보다
  // 재시작이 낫다.
  process.on('uncaughtException', (err) => {
    console.error('[instrumentation] uncaughtException:', err);
    void shutdown(1);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[instrumentation] unhandledRejection:', reason);
    void shutdown(1);
  });
}

// t5 D1: instrumentation.ts 의 register() 가 NEXT_RUNTIME==='nodejs' 일 때만 이 모듈을
// 동적 import 해서 부른다. setServices() 호출은 매번 다시 수행한다 — 실서비스에서는
// Next 가 register() 를 프로세스당 한 번만 부르므로(context7 확인) 사실상 한 번뿐이고,
// 테스트에서 resetServices() 뒤 재호출해도 항상 다시 주입되어야 하기 때문이다. 핸들러
// 등록만 별도로 멱등 처리한다(위 registerShutdownHandlers).
/**
 * 인증 설정을 부팅 시 한 번 확인한다.
 *
 * 조용히 무인증으로 도는 상태를 만들지 않는 것이 핵심이다 — 루프백 밖에 바인딩하면서
 * 비밀번호가 없으면, 이유를 출력하고 프로세스를 끝낸다. register() 는 서버가 요청을 받기
 * 전에 끝나므로(Next 문서: "must complete before the server is ready to handle requests"),
 * 여기서 죽으면 단 한 번의 무인증 요청도 처리되지 않는다.
 */
function assertBootConfigOrExit(): void {
  const result = checkBootConfig();
  if (!result.ok) {
    console.error(`\n[instrumentation] 부팅을 거부합니다 — ${result.message}\n`);
    process.exit(1);
  }
  if (result.message !== null) {
    console.warn(`[instrumentation] ${result.message}`);
  }
}

export async function registerNode(): Promise<void> {
  assertBootConfigOrExit();
  setServices(createServices(loadConfig()));
  registerShutdownHandlers();
  // 이 훅이 실제로 돌았는지가 "잡이 영영 created 에 머문다" 류 증상의 첫 갈림길이다 —
  // 로그 한 줄로 부팅 시점에 확인할 수 있게 남긴다.
  console.log('[instrumentation] services injected (pid=' + process.pid + ')');
}
