import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// t5 D7: 소스 텍스트 정규식이 아니라 도달 가능한 행동 seam 을 쓴다 — register() 를 실제로
// 실행하고 getServices() 로 결과를 관찰한다. 지연 시작(D8)은 `node:child_process.spawn` 을
// 스파이해서 확인한다 — register() 가 실제로 AsideRepl.start() 를 부르지 않는 한 spawn 은
// 절대 호출되지 않는다(AsideRepl 생성자 자체는 spawn 하지 않는다 — lib/aside/repl.ts 실측).
vi.mock('node:child_process', { spy: true });

import * as childProcess from 'node:child_process';
import { register } from '@/instrumentation';
import { getServices, resetServices } from '@/lib/job/services';
import { disposeServices } from '@/lib/pipeline';

// 보안 정책: /tmp·$TMPDIR 금지 — 워크트리 내부 경로만 사용한다. loadConfig() 의 기본
// dataDir(프로젝트 루트의 data/)를 건드리지 않도록 매번 격리된 경로로 오버라이드한다.
let dataDir: string;
let originalDataDir: string | undefined;
let originalNextRuntime: string | undefined;

beforeEach(() => {
  dataDir = path.join(process.cwd(), '.dev-loop', 'test-tmp', `wiring-${randomUUID()}`);
  originalDataDir = process.env.ANB_DATA_DIR;
  process.env.ANB_DATA_DIR = dataDir;

  // register() 는 NEXT_RUNTIME==='nodejs' 일 때만 실제 배선을 수행한다(context7 확인:
  // Next 가 이 훅을 모든 런타임에서 부르므로 Node 전용 코드는 이 값으로 가드해야 한다).
  // 이 앱은 실제로 Edge 런타임에서 돈 적이 없으므로, 실제 서버 프로세스가 갖는 값을
  // 테스트에서도 그대로 재현한다.
  originalNextRuntime = process.env.NEXT_RUNTIME;
  process.env.NEXT_RUNTIME = 'nodejs';

  resetServices();
});

afterEach(async () => {
  await disposeServices();
  resetServices();
  vi.mocked(childProcess.spawn).mockClear();

  if (originalDataDir === undefined) {
    delete process.env.ANB_DATA_DIR;
  } else {
    process.env.ANB_DATA_DIR = originalDataDir;
  }
  if (originalNextRuntime === undefined) {
    delete process.env.NEXT_RUNTIME;
  } else {
    process.env.NEXT_RUNTIME = originalNextRuntime;
  }
});

describe('register() — 정상 (핵심)', () => {
  test('register() 후 getServices() 가 throw 하지 않고, generator·publisher 가 각 인터페이스의 메서드를 갖는다', async () => {
    await register();

    const services = getServices();
    expect(typeof services.generator.generate).toBe('function');
    expect(typeof services.publisher.fillEditor).toBe('function');
    expect(typeof services.publisher.publish).toBe('function');
    expect(typeof services.publisher.abort).toBe('function');
  });
});

describe('register() — 음성 대조', () => {
  test('register() 를 부르지 않으면 getServices() 는 throw 한다 (위 정상 테스트가 주입 덕분에 통과함을 고정)', () => {
    expect(() => getServices()).toThrow(/setServices/i);
  });
});

describe('register() — 경계값', () => {
  test('register() 를 두 번 불러도 throw 하지 않고 getServices() 가 여전히 동작한다', async () => {
    await register();
    await register();

    const services = getServices();
    expect(typeof services.generator.generate).toBe('function');
    expect(typeof services.publisher.fillEditor).toBe('function');
  });
});

describe('register() — 지연 시작', () => {
  test('register() 직후에는 aside 자식 프로세스가 생기지 않는다 (spawn 이 호출되지 않는다)', async () => {
    await register();

    expect(childProcess.spawn).not.toHaveBeenCalled();
  });
});
