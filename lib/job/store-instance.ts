import { loadConfig } from '../config';
import { JobStore } from './store';

// 이 로컬 단일 사용자 앱은 하나의 Node 프로세스로 돈다 (D9). 라우트 핸들러마다 새
// JobStore를 만들면 D15의 메모리 캐시가 인스턴스마다 갈라져, SSE 폴링이 runJob()의
// 백그라운드 실행이 쓴 최신 상태를 영영 보지 못한다. 프로세스 전체에서 하나만 공유한다.
let instance: JobStore | null = null;

export function getJobStore(): JobStore {
  if (!instance) {
    instance = new JobStore(loadConfig());
  }
  return instance;
}

// 테스트용: 다음 getJobStore() 호출이 현재 환경변수로 새 인스턴스를 만들게 한다
export function resetJobStore(): void {
  instance = null;
}
