import type { ContentGeneratorApi, NaverPublisherApi } from '../types';

// D11: 구현체 주입 지점. t2/t4의 구현체를 여기서 import하지 않는다 — 타입만 lib/types.ts에서
// 가져오고, 실제 인스턴스는 t5의 부트스트랩이 setServices()로 넘겨준다.
export interface Services {
  generator: ContentGeneratorApi;
  publisher: NaverPublisherApi;
}

let injected: Services | null = null;

export function setServices(services: Services): void {
  injected = services;
}

export function getServices(): Services {
  if (!injected) {
    throw new Error(
      'lib/job/services: no Services injected — call setServices({ generator, publisher }) during app bootstrap before running a job',
    );
  }
  return injected;
}

// 테스트용: 주입 상태를 초기화한다
export function resetServices(): void {
  injected = null;
}
