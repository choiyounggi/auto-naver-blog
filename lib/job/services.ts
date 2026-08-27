import type { ContentGeneratorApi, NaverPublisherApi } from '../types';

// D11: 구현체 주입 지점. t2/t4의 구현체를 여기서 import하지 않는다 — 타입만 lib/types.ts에서
// 가져오고, 실제 인스턴스는 t5의 부트스트랩이 setServices()로 넘겨준다.
export interface Services {
  generator: ContentGeneratorApi;
  publisher: NaverPublisherApi;
}

// 주입 상태를 모듈 지역 변수가 아니라 globalThis 에 보관한다.
//
// 실측(2026-08-25): dev 서버를 켜 둔 채 서버 코드를 고치면 Turbopack 이 라우트의 모듈
// 그래프를 다시 만들면서 이 모듈의 인스턴스가 하나 더 생긴다. instrumentation 의
// register() 는 부팅 때 한 번만 돌므로, 새 인스턴스의 `injected` 는 null 인 채로 남고
// runJob() 이 'no Services injected' 로 죽는다 — 화면에서는 잡이 영영 '진행 중'에 멈춘 것처럼
// 보였다. globalThis 에 두면 인스턴스가 몇 개든 같은 값을 본다.
//
// D11 은 그대로다 — 이 모듈은 여전히 구현체를 import 하지 않는다.
const SERVICES_KEY = Symbol.for('auto-naver-blog.services');

interface ServicesGlobal {
  [SERVICES_KEY]?: Services | null;
}

function slot(): ServicesGlobal {
  return globalThis as unknown as ServicesGlobal;
}

export function setServices(services: Services): void {
  slot()[SERVICES_KEY] = services;
}

export function getServices(): Services {
  const injected = slot()[SERVICES_KEY];
  if (!injected) {
    throw new Error(
      'lib/job/services: no Services injected — call setServices({ generator, publisher }) during app bootstrap before running a job',
    );
  }
  return injected;
}

// 테스트용: 주입 상태를 초기화한다
export function resetServices(): void {
  slot()[SERVICES_KEY] = null;
}
