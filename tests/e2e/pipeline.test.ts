import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { AppConfig } from '@/lib/config';
import { createServices, disposeServices } from '@/lib/pipeline';
import type { AsideEvalResult, AsideReplApi, PostDraft, PostInput } from '@/lib/types';

// 보안 정책: /tmp·$TMPDIR 금지 — 워크트리 내부 경로만 사용한다
const scratchRoot = path.join(process.cwd(), '.dev-loop', 'test-tmp');

function fixtureConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const dataDir = path.join(scratchRoot, `pipeline-${randomUUID()}`);
  return {
    dataDir,
    claudeBin: 'claude',
    asideBin: 'aside',
    naverBlogId: null,
    // 존재하지 않는 쿠키 파일 — NaverSession.status() 가 repl.evaluate() 를 부르지 않고
    // 즉시 loggedIn:false 를 반환하게 만든다. 이 테스트들은 REPL 배선(지연 시작·재사용·
    // 생명주기)만 검증하며, 실제 네이버 스텝 시퀀스 성공은 t4 소관(검증 범위 밖).
    cookieFile: path.join(dataDir, 'naver-cookies.json'),
    claudeTimeoutMs: 5000,
    asideStepTimeoutMs: 5000,
    ...overrides,
  };
}

function makeInput(): PostInput {
  return {
    jobId: 'job-pipeline-test',
    category: '일상',
    highlights: '오늘 다녀온 카페',
    place: '',
    images: [
      {
        id: 'img-0',
        originalName: 'a.jpg',
        path: '/data/jobs/job-pipeline-test/images/img-0.jpg',
        mimeType: 'image/jpeg',
        bytes: 123,
        width: 10,
        height: 10,
        order: 0,
      },
    ],
    createdAt: '2026-08-25T00:00:00.000Z',
  };
}

function makeDraft(): PostDraft {
  return {
    title: '제목',
    intro: '인트로',
    blocks: [{ imageId: 'img-0', heading: '', caption: '캡션', altText: '대체텍스트' }],
    outro: '아웃트로',
    tags: ['태그'],
    topic: '일상',
    thumbnailImageId: 'img-0',
    generatedAt: '2026-08-25T00:00:00.000Z',
    model: 'claude-test',
  };
}

/** 재사용 전 프로브(lib/pipeline.ts PROBE_JS)에 이 REPL 이 어떻게 답할지. */
type ProbeBehavior =
  /** 세션이 살아 있다 — 재사용된다 */
  | 'alive'
  /** 데몬이 세션을 회수했다 — evaluate 가 ok:false 로 돌아온다(실측한 실패 모양) */
  | 'dead'
  /** 채널 자체가 던진다(자식 프로세스 사망 등) */
  | 'throws';

/** 실제 aside 자식 프로세스를 절대 띄우지 않는 가짜 AsideReplApi. */
class FakeRepl implements AsideReplApi {
  startCalls = 0;
  disposeCalls = 0;
  evaluateCalls = 0;
  private readonly startError: Error | null;
  private readonly probe: ProbeBehavior;

  constructor(opts: { startError?: Error; probe?: ProbeBehavior } = {}) {
    this.startError = opts.startError ?? null;
    this.probe = opts.probe ?? 'alive';
  }

  async start(): Promise<void> {
    this.startCalls += 1;
    if (this.startError) {
      throw this.startError;
    }
  }

  async evaluate(_js: string): Promise<AsideEvalResult> {
    this.evaluateCalls += 1;
    // cookieFile 이 존재하지 않으므로 NaverSession.status() 는 evaluate 를 부르지 않는다 —
    // 여기 도달하는 것은 REPL 재사용 전 프로브뿐이다.
    if (this.probe === 'throws') {
      throw new Error('FakeRepl: 채널이 죽었다 (fixture)');
    }
    if (this.probe === 'dead') {
      return { ok: false, stdout: '', durationMs: 7, error: 'REPL session not found (fixture)' };
    }
    return { ok: true, stdout: '{"probe":true}', durationMs: 1, error: null };
  }

  async dispose(): Promise<void> {
    this.disposeCalls += 1;
  }
}

const createdRepls: FakeRepl[] = [];

function trackingFactory(opts: { startError?: Error; probe?: ProbeBehavior } = {}) {
  let calls = 0;
  const factory = (_config: AppConfig): AsideReplApi => {
    calls += 1;
    const repl = new FakeRepl(opts);
    createdRepls.push(repl);
    return repl;
  };
  return { factory, callCount: () => calls };
}

afterEach(async () => {
  await disposeServices();
  createdRepls.length = 0;
});

describe('createServices — 정상', () => {
  test('generator·publisher 가 각 인터페이스의 메서드를 갖는다', () => {
    const { factory } = trackingFactory();
    const services = createServices(fixtureConfig(), { replFactory: factory });
    expect(typeof services.generator.generate).toBe('function');
    expect(typeof services.publisher.fillEditor).toBe('function');
    expect(typeof services.publisher.publish).toBe('function');
    expect(typeof services.publisher.abort).toBe('function');
  });
});

describe('createServices — 지연 시작 (D8)', () => {
  test('createServices 직후에는 replFactory 가 호출되지 않는다', () => {
    const { factory, callCount } = trackingFactory();
    createServices(fixtureConfig(), { replFactory: factory });
    expect(callCount()).toBe(0);
  });

  test('첫 fillEditor 후 replFactory 호출 1회, repl.start() 호출 1회', async () => {
    const { factory, callCount } = trackingFactory();
    const services = createServices(fixtureConfig(), { replFactory: factory });

    await expect(services.publisher.fillEditor(makeDraft(), makeInput())).rejects.toThrow(/로그인/);

    expect(callCount()).toBe(1);
    expect(createdRepls[0]?.startCalls).toBe(1);
  });

  test('두 번째 fillEditor 후에도 replFactory 호출은 여전히 1회 (프로브가 살아 있음을 확인하고 재사용)', async () => {
    const { factory, callCount } = trackingFactory({ probe: 'alive' });
    const services = createServices(fixtureConfig(), { replFactory: factory });

    await expect(services.publisher.fillEditor(makeDraft(), makeInput())).rejects.toThrow(/로그인/);
    // 첫 호출에는 재사용할 REPL 이 없으므로 프로브도 없다.
    expect(createdRepls[0]?.evaluateCalls).toBe(0);

    await expect(services.publisher.fillEditor(makeDraft(), makeInput())).rejects.toThrow(/로그인/);

    expect(callCount()).toBe(1);
    expect(createdRepls[0]?.startCalls).toBe(1);
    // 두 번째 호출은 재사용 전에 정확히 한 번 찔러 봤다.
    expect(createdRepls[0]?.evaluateCalls).toBe(1);
    expect(createdRepls[0]?.disposeCalls).toBe(0);
  });
});

// 실측(2026-08-30): Aside 데몬이 21시간 쉰 REPL 세션을 회수했다. 자식 프로세스는 살아 있어
// 재사용됐지만 다음 evaluate 가 'REPL session not found' 로 실패했고, 그 실패가
// NaverSession.status() 를 거쳐 "네이버 로그인이 되어 있지 않습니다" 로 보고됐다 — 네이버
// 로그인은 멀쩡했다. 게다가 죽은 inner 가 그대로 남아 이후 모든 잡이 같은 실패를 반복했다.
describe('createServices — 죽은 REPL 세션 복구', () => {
  test('프로브가 ok:false 면 죽은 REPL 을 버리고 새로 만든다 (같은 죽은 채널을 다시 쓰지 않는다)', async () => {
    // 첫 REPL 은 세션이 회수된 것(dead), 두 번째부터는 정상인 REPL 을 준다.
    let calls = 0;
    const repls: FakeRepl[] = [];
    const factory = (_config: AppConfig): AsideReplApi => {
      calls += 1;
      const repl = new FakeRepl(calls === 1 ? { probe: 'dead' } : {});
      repls.push(repl);
      return repl;
    };
    const services = createServices(fixtureConfig(), { replFactory: factory });

    await expect(services.publisher.fillEditor(makeDraft(), makeInput())).rejects.toThrow(/로그인/);
    expect(calls).toBe(1);

    // 두 번째 호출: 프로브가 실패 → 첫 REPL 을 정리하고 새 REPL 을 만든다.
    await expect(services.publisher.fillEditor(makeDraft(), makeInput())).rejects.toThrow(/로그인/);

    expect(calls).toBe(2);
    expect(repls[0]?.disposeCalls).toBe(1);
    expect(repls[1]?.startCalls).toBe(1);
  });

  test('프로브가 throw 해도(자식 프로세스 사망) 새 REPL 을 만든다', async () => {
    let calls = 0;
    const repls: FakeRepl[] = [];
    const factory = (_config: AppConfig): AsideReplApi => {
      calls += 1;
      const repl = new FakeRepl(calls === 1 ? { probe: 'throws' } : {});
      repls.push(repl);
      return repl;
    };
    const services = createServices(fixtureConfig(), { replFactory: factory });

    await expect(services.publisher.fillEditor(makeDraft(), makeInput())).rejects.toThrow(/로그인/);
    await expect(services.publisher.fillEditor(makeDraft(), makeInput())).rejects.toThrow(/로그인/);

    expect(calls).toBe(2);
    expect(repls[0]?.disposeCalls).toBe(1);
    expect(repls[1]?.startCalls).toBe(1);
  });

  test('경계값: 죽은 REPL 이 연달아 나와도 매번 새로 만든다 (한 번 죽었다고 영영 막히지 않는다)', async () => {
    const { factory, callCount } = trackingFactory({ probe: 'dead' });
    const services = createServices(fixtureConfig(), { replFactory: factory });

    await expect(services.publisher.fillEditor(makeDraft(), makeInput())).rejects.toThrow(/로그인/);
    await expect(services.publisher.fillEditor(makeDraft(), makeInput())).rejects.toThrow(/로그인/);
    await expect(services.publisher.fillEditor(makeDraft(), makeInput())).rejects.toThrow(/로그인/);

    expect(callCount()).toBe(3);
    expect(createdRepls[0]?.disposeCalls).toBe(1);
    expect(createdRepls[1]?.disposeCalls).toBe(1);
  });

  test('publish() 는 죽은 채널을 만나도 REPL 을 새로 만들지 않는다 (빈 에디터를 발행하지 않기 위해)', async () => {
    const { factory, callCount } = trackingFactory({ probe: 'dead' });
    const services = createServices(fixtureConfig(), { replFactory: factory });

    await expect(services.publisher.fillEditor(makeDraft(), makeInput())).rejects.toThrow(/로그인/);
    expect(callCount()).toBe(1);

    // fillEditor 가 실패했으므로 publish() 는 거부된다 — 그 과정에서 REPL 을 더 만들지 않는다.
    const result = await services.publisher.publish();
    expect(result.ok).toBe(false);
    expect(callCount()).toBe(1);
  });
});

describe('createServices — 에러', () => {
  test('fillEditor 없이 publish() 를 부르면 ok:false 로 거부되고 replFactory 는 호출되지 않는다', async () => {
    const { factory, callCount } = trackingFactory();
    const services = createServices(fixtureConfig(), { replFactory: factory });

    const result = await services.publisher.publish();

    expect(result.ok).toBe(false);
    expect(callCount()).toBe(0);
  });

  test('abort() 를 fillEditor 없이 불러도 throw 하지 않는다', async () => {
    const { factory } = trackingFactory();
    const services = createServices(fixtureConfig(), { replFactory: factory });
    await expect(services.publisher.abort()).resolves.toBeUndefined();
  });

  test('start() 가 throw 하면 fillEditor 가 실패하고, 같은 publisher 의 다음 호출이 다시 시도한다 (실패한 inner 를 재사용하지 않는다)', async () => {
    // 처음 두 번은 start() 가 throw 하고, 세 번째부터는 성공하는 REPL 을 순서대로 만든다.
    // 팩토리가 매 fillEditor 호출마다 다시 불렸다는 것 자체가 "실패한 inner 를 들고
    // 재시도하지 않았다"는 증거다 — inner 가 남아있었다면 REPL 을 다시 만들 필요가 없다.
    let calls = 0;
    const repls: FakeRepl[] = [];
    const factory = (_config: AppConfig): AsideReplApi => {
      calls += 1;
      const repl = new FakeRepl(calls <= 2 ? { startError: new Error(`spawn 실패 #${calls} (fixture)`) } : {});
      repls.push(repl);
      return repl;
    };
    const services = createServices(fixtureConfig(), { replFactory: factory });

    await expect(services.publisher.fillEditor(makeDraft(), makeInput())).rejects.toThrow(/spawn 실패 #1/);
    expect(calls).toBe(1);
    expect(repls[0]?.startCalls).toBe(1);

    // 같은 publisher 인스턴스에 다시 호출 — 실패한 inner 를 재사용했다면 factory 가 다시
    // 불리지 않아야 하는데, 우리는 정확히 "다시 불렸다"를 요구한다 (재시도 성립의 증거).
    await expect(services.publisher.fillEditor(makeDraft(), makeInput())).rejects.toThrow(/spawn 실패 #2/);
    expect(calls).toBe(2);

    // 세 번째 시도는 start() 가 성공하는 REPL 을 받아 실제로 다음 단계(로그인 확인)까지
    // 진행된다 — 앞선 두 번의 실패가 이 REPL 생성을 막지 않았다는 것을 보여준다.
    await expect(services.publisher.fillEditor(makeDraft(), makeInput())).rejects.toThrow(/로그인/);
    expect(calls).toBe(3);
    expect(repls[2]?.startCalls).toBe(1);
  });
});

describe('createServices — 경계값', () => {
  test('REPL 이 만들어지기 전에 disposeServices() 를 불러도 throw 하지 않는다', async () => {
    const { factory } = trackingFactory();
    createServices(fixtureConfig(), { replFactory: factory });
    await expect(disposeServices()).resolves.toBeUndefined();
  });

  test('disposeServices() 를 두 번 불러도 실제 dispose() 는 1회만 수행된다', async () => {
    const { factory } = trackingFactory();
    const services = createServices(fixtureConfig(), { replFactory: factory });
    await expect(services.publisher.fillEditor(makeDraft(), makeInput())).rejects.toThrow(/로그인/);

    await disposeServices();
    await disposeServices();

    expect(createdRepls[0]?.disposeCalls).toBe(1);
  });
});
