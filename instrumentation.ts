// Next.js 서버 부팅 훅 (프로젝트 루트 instrumentation.ts). t5 D1: 실측 —
// INSTRUMENTATION_HOOK_FILENAME = 'instrumentation' (node_modules/next/dist/lib/constants.js).
//
// register() 는 모든 런타임(Node.js·Edge)에서 불린다(context7: Next.js 16.2.9 문서,
// "Instrumentation > Examples > Importing runtime-specific code"). 이 앱은 child_process·fs
// 를 쓰는 Node 전용 코드이므로, 문서가 권장하는 패턴대로 NEXT_RUNTIME 가드 뒤에서 동적
// import 로만 불러온다 — 정적 import 를 쓰면 Edge 번들 빌드 시 Node 전용 모듈까지 함께
// 번들링을 시도하게 된다.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { registerNode } = await import('./instrumentation-node');
    await registerNode();
  }
}
