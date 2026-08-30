import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { AppConfig } from '@/lib/config';
import { JobStore } from '@/lib/job/store';
import { EditorNotHeldError, getEditorQueue, resetEditorQueue } from '@/lib/job/queue';
import { getServices, resetServices, setServices } from '@/lib/job/services';
import { approveAndPublish, runJob } from '@/lib/job/runner';
import type {
  ContentGeneratorApi,
  EditorPreview,
  NaverPublisherApi,
  PostDraft,
  PostInput,
  ProgressFn,
  PublishResult,
} from '@/lib/types';

function makeConfig(dataDir: string): AppConfig {
  return {
    dataDir,
    claudeBin: 'claude',
    asideBin: 'aside',
    naverBlogId: null,
    cookieFile: path.join(dataDir, 'naver-cookies.json'),
    claudeTimeoutMs: 600000,
    asideStepTimeoutMs: 60000,
  };
}

function makeInput(jobId: string): PostInput {
  return {
    jobId,
    category: '일상',
    highlights: '오늘 다녀온 카페',
    place: '',
    images: [
      {
        id: 'img-0',
        originalName: 'a.jpg',
        path: `/data/jobs/${jobId}/images/img-0.jpg`,
        mimeType: 'image/jpeg',
        bytes: 123,
        width: 10,
        height: 10,
        order: 0,
      },
    ],
    createdAt: new Date().toISOString(),
  };
}

function makeDraft(): PostDraft {
  return {
    title: '제목',
    intro: '인트로',
    blocks: [],
    outro: '아웃트로',
    tags: ['일상'],
    topic: '일상',
    thumbnailImageId: 'img-0',
    generatedAt: new Date().toISOString(),
    model: 'claude',
  };
}

class FakeGenerator implements ContentGeneratorApi {
  callCount = 0;
  shouldThrow = false;

  async generate(_input: PostInput, onProgress?: ProgressFn): Promise<PostDraft> {
    this.callCount++;
    onProgress?.('이미지 분석 중');
    if (this.shouldThrow) throw new Error('generate boom');
    return makeDraft();
  }
}

class FakePublisher implements NaverPublisherApi {
  refreshPreviewCallCount = 0;
  fillEditorCallCount = 0;
  publishCallCount = 0;
  shouldThrowOnFill = false;
  publishResult: PublishResult = {
    ok: true,
    postUrl: 'https://blog.naver.com/x/1',
    publishedAt: new Date().toISOString(),
    message: '발행 완료',
  };

  async fillEditor(_draft: PostDraft, _input: PostInput, onProgress?: ProgressFn): Promise<EditorPreview> {
    this.fillEditorCallCount++;
    onProgress?.('에디터에 채우는 중');
    if (this.shouldThrowOnFill) throw new Error('fillEditor boom');
    return { screenshotPath: '/data/jobs/x/preview.png', editorUrl: 'https://blog.naver.com/PostWriteForm.naver' };
  }

  async refreshPreview(input: PostInput): Promise<EditorPreview> {
    this.refreshPreviewCallCount += 1;
    return { screenshotPath: `/preview/${input.jobId}.png`, editorUrl: 'https://blog.naver.com/tester?Redirect=Write' };
  }

  async publish(): Promise<PublishResult> {
    this.publishCallCount++;
    return this.publishResult;
  }

  async abort(): Promise<void> {}
}

let dataDir: string;
let store: JobStore;
let generator: FakeGenerator;
let publisher: FakePublisher;

beforeEach(async () => {
  // 보안 정책: /tmp·$TMPDIR 금지 — 워크트리 내부 경로만 사용한다
  dataDir = path.join(process.cwd(), '.dev-loop', 'test-tmp', `runner-${randomUUID()}`);
  await mkdir(dataDir, { recursive: true });
  store = new JobStore(makeConfig(dataDir));
  generator = new FakeGenerator();
  publisher = new FakePublisher();
  setServices({ generator, publisher });
  // 에디터 사용권 큐는 globalThis 에 있어 테스트 사이에 남는다. runJob 은 승인 대기까지
  // 사용권을 쥐고 끝나므로, 비우지 않으면 다음 테스트가 앞 테스트의 잡을 기다리게 된다.
  resetEditorQueue();
});

afterEach(async () => {
  resetEditorQueue();
  resetServices();
  await rm(dataDir, { recursive: true, force: true });
});

describe('runJob — 안전 계약', () => {
  test('안전 계약 1: runJob 완료 후 phase가 awaiting_approval이고 publish 호출 횟수가 0이다', async () => {
    const jobId = 'job-1';
    await store.create(makeInput(jobId));
    await runJob(store, jobId);
    const state = await store.get(jobId);
    expect(state?.phase).toBe('awaiting_approval');
    expect(publisher.publishCallCount).toBe(0);
    expect(publisher.fillEditorCallCount).toBe(1);
    expect(generator.callCount).toBe(1);
  });
});

describe('approveAndPublish — 안전 계약', () => {
  test('안전 계약 2: awaiting_approval이 아닌 상태에서 approveAndPublish가 throw하고 publish 호출 횟수가 0이다', async () => {
    const jobId = 'job-2';
    await store.create(makeInput(jobId));
    await store.transition(jobId, 'analyzing', 'x');
    await store.transition(jobId, 'drafting', 'x');
    await store.transition(jobId, 'draft_ready', 'x');
    await expect(approveAndPublish(store, jobId)).rejects.toThrow();
    expect(publisher.publishCallCount).toBe(0);
  });

  test('안전 계약 3: awaiting_approval에서 approveAndPublish를 부르면 publish가 정확히 1회 불리고 phase가 published가 된다', async () => {
    const jobId = 'job-3';
    await store.create(makeInput(jobId));
    await runJob(store, jobId);
    const result = await approveAndPublish(store, jobId);
    expect(publisher.publishCallCount).toBe(1);
    expect(result.ok).toBe(true);
    const state = await store.get(jobId);
    expect(state?.phase).toBe('published');
  });

  test('경계값: approveAndPublish를 연속 두 번 부르면 두 번째는 throw하고 publish 총 호출 횟수가 1로 유지된다', async () => {
    const jobId = 'job-4';
    await store.create(makeInput(jobId));
    await runJob(store, jobId);
    await approveAndPublish(store, jobId);
    await expect(approveAndPublish(store, jobId)).rejects.toThrow();
    expect(publisher.publishCallCount).toBe(1);
  });

  test('경계값: publisher.publish가 ok:false를 돌려주면 phase가 failed가 된다', async () => {
    const jobId = 'job-5';
    await store.create(makeInput(jobId));
    await runJob(store, jobId);
    publisher.publishResult = { ok: false, postUrl: null, publishedAt: null, message: '네이버 오류' };
    const result = await approveAndPublish(store, jobId);
    expect(result.ok).toBe(false);
    const state = await store.get(jobId);
    expect(state?.phase).toBe('failed');
    expect(state?.error?.step).toBe('publish');
  });

  test('에러: publisher.publish가 throw하면 phase가 failed이고 에러가 다시 던져진다', async () => {
    const jobId = 'job-8';
    await store.create(makeInput(jobId));
    await runJob(store, jobId);
    publisher.publish = async () => {
      publisher.publishCallCount++;
      throw new Error('publish network boom');
    };
    await expect(approveAndPublish(store, jobId)).rejects.toThrow('publish network boom');
    expect(publisher.publishCallCount).toBe(1);
    const state = await store.get(jobId);
    expect(state?.phase).toBe('failed');
    expect(state?.error?.step).toBe('publish');
  });
});

describe('runJob — 에러 처리', () => {
  test('에러: generator.generate가 throw하면 phase가 failed이고 error.step이 생성 단계를 가리킨다', async () => {
    const jobId = 'job-6';
    await store.create(makeInput(jobId));
    generator.shouldThrow = true;
    await runJob(store, jobId);
    const state = await store.get(jobId);
    expect(state?.phase).toBe('failed');
    expect(state?.error?.step).toBe('generate');
    expect(publisher.fillEditorCallCount).toBe(0);
    expect(publisher.publishCallCount).toBe(0);
  });

  test('에러: publisher.fillEditor가 throw하면 phase가 failed이고 error.step이 에디터 단계를 가리킨다', async () => {
    const jobId = 'job-7';
    await store.create(makeInput(jobId));
    publisher.shouldThrowOnFill = true;
    await runJob(store, jobId);
    const state = await store.get(jobId);
    expect(state?.phase).toBe('failed');
    expect(state?.error?.step).toBe('fillEditor');
    expect(publisher.publishCallCount).toBe(0);
  });
});

// 실측 회귀(2026-08-25): 서비스가 주입되지 않은 상태에서 runJob 이 그냥 던지면, 잡은
// 'created' 에 남고 화면은 영영 '진행 중'으로 보였다. 어떤 실패든 잡 상태에 남아야 한다.
describe('runJob — 부팅 실패도 잡에 기록한다', () => {
  test('에러: 서비스 미주입이면 phase 가 failed 이고 step 이 bootstrap 이다', async () => {
    const jobId = 'job-bootstrap';
    await store.create(makeInput(jobId));
    resetServices();

    await expect(runJob(store, jobId)).resolves.toBeUndefined();

    const state = await store.get(jobId);
    expect(state?.phase).toBe('failed');
    expect(state?.error?.step).toBe('bootstrap');
    expect(state?.error?.message).toMatch(/setServices/i);
  });

  test('에러: runJob 은 어떤 경우에도 reject 하지 않는다 (백그라운드 호출이므로)', async () => {
    const jobId = 'job-no-reject';
    await store.create(makeInput(jobId));
    resetServices();

    // reject 하면 라우트의 .catch 가 콘솔에만 찍고 끝나 화면에는 아무것도 안 뜬다.
    await expect(runJob(store, jobId)).resolves.toBeUndefined();
  });

  test('경계값: 존재하지 않는 잡에 대해서도 던지지 않는다', async () => {
    resetServices();
    await expect(runJob(store, 'no-such-job')).resolves.toBeUndefined();
  });
});

describe('getServices', () => {
  test('에러: getServices()가 미주입 상태에서 명확한 메시지로 throw한다', () => {
    resetServices();
    expect(() => getServices()).toThrow(/setServices/i);
  });

  test('정상: setServices 로 넣은 값을 그대로 돌려준다 (모듈 인스턴스가 갈려도 유지되도록 globalThis 보관)', () => {
    const services = { generator, publisher };
    setServices(services);
    expect(getServices()).toBe(services);
  });
});


// 승인 화면에서 고친 내용이 그대로 발행되어야 한다 — 고쳤으면 에디터를 다시 채우고,
// 안 고쳤으면 다시 채우지 않는다(사진 재업로드가 없어 훨씬 빠르다).
describe('approveAndPublish — 수정 반영', () => {
  test('정상: 고친 게 없으면 다시 채우지 않고 바로 발행한다', async () => {
    const jobId = 'job-nochange';
    await store.create(makeInput(jobId));
    const draft = makeDraft();
    await store.patch(jobId, { draft, editorDraft: draft });
    await store.transition(jobId, 'analyzing', 'x');
    await store.transition(jobId, 'drafting', 'x');
    await store.transition(jobId, 'draft_ready', 'x');
    await store.transition(jobId, 'filling_editor', 'x');
    await store.transition(jobId, 'awaiting_approval', 'x');

    // 계약 변경(동시 발행 직렬화): 발행은 그 잡이 에디터 사용권을 쥐고 있을 때만 된다.
    // 원래 runJob 이 fillEditor 직전에 잡아 두는 것을, 여기서는 단계를 손으로 옮겼으므로
    // 대신 잡아 준다.
    await getEditorQueue().acquire(jobId);

    const before = publisher.fillEditorCallCount;
    await approveAndPublish(store, jobId);

    expect(publisher.fillEditorCallCount).toBe(before);
    expect(publisher.publishCallCount).toBe(1);
  });

  test('정상: 고쳤으면 그 내용으로 다시 채운 뒤 발행한다', async () => {
    const jobId = 'job-changed';
    await store.create(makeInput(jobId));
    const filled = makeDraft();
    await store.patch(jobId, { draft: { ...filled, title: '사람이 고친 제목' }, editorDraft: filled });
    await store.transition(jobId, 'analyzing', 'x');
    await store.transition(jobId, 'drafting', 'x');
    await store.transition(jobId, 'draft_ready', 'x');
    await store.transition(jobId, 'filling_editor', 'x');
    await store.transition(jobId, 'awaiting_approval', 'x');

    // 계약 변경(동시 발행 직렬화): 발행은 그 잡이 에디터 사용권을 쥐고 있을 때만 된다.
    // 원래 runJob 이 fillEditor 직전에 잡아 두는 것을, 여기서는 단계를 손으로 옮겼으므로
    // 대신 잡아 준다.
    await getEditorQueue().acquire(jobId);

    const before = publisher.fillEditorCallCount;
    await approveAndPublish(store, jobId);

    expect(publisher.fillEditorCallCount).toBe(before + 1);
    expect(publisher.publishCallCount).toBe(1);
    const state = await store.get(jobId);
    expect(state?.editorDraft?.title).toBe('사람이 고친 제목');
  });
});


// 동시 발행 직렬화 (완료 기준 4): Aside REPL 이 하나뿐이라 두 잡이 같은 에디터 탭을 만지면
// 한쪽이 다른 쪽의 글을 발행하게 된다. 뒤 잡은 앞 잡이 발행을 마칠 때까지 시작하지 않는다.
describe('runJob/approveAndPublish — 동시 발행 직렬화', () => {
  test('정상: 앞 잡이 발행을 마친 뒤에야 뒤 잡이 에디터를 채운다', async () => {
    const events: string[] = [];
    let inFlight = 0;
    let releaseFirstFill: (() => void) | null = null;

    publisher.fillEditor = async (_draft: PostDraft, input: PostInput): Promise<EditorPreview> => {
      publisher.fillEditorCallCount += 1;
      inFlight += 1;
      // 에디터를 동시에 두 잡이 만지면 여기서 2가 된다 — 그게 이 테스트가 막는 상황이다.
      expect(inFlight).toBe(1);
      events.push(`fill:${input.jobId}`);
      if (input.jobId === 'job-first') {
        await new Promise<void>((resolve) => {
          releaseFirstFill = resolve;
        });
      }
      inFlight -= 1;
      return { screenshotPath: `/preview/${input.jobId}.png`, editorUrl: 'https://blog.naver.com/x' };
    };

    await store.create(makeInput('job-first'));
    await store.create(makeInput('job-second'));

    const first = runJob(store, 'job-first');
    // 첫 잡이 에디터를 잡을 때까지 기다린다.
    while (releaseFirstFill === null) await new Promise((resolve) => setTimeout(resolve, 5));

    const second = runJob(store, 'job-second');
    await new Promise((resolve) => setTimeout(resolve, 30));
    // 두 번째 잡은 아직 에디터를 만지지 못했다 — 대기 중이다.
    expect(events).toEqual(['fill:job-first']);
    expect(getEditorQueue().position('job-second')).toBe(1);
    const waitingLog = (await store.get('job-second'))?.log.map((entry) => entry.message) ?? [];
    expect(waitingLog.some((message) => message.includes('앞에 1건'))).toBe(true);

    (releaseFirstFill as () => void)();
    await first;
    expect((await store.get('job-first'))?.phase).toBe('awaiting_approval');
    // 첫 잡이 승인 대기 중인 동안에도 에디터를 빼앗기지 않는다.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(events).toEqual(['fill:job-first']);

    await approveAndPublish(store, 'job-first');
    await second;

    expect(events).toEqual(['fill:job-first', 'fill:job-second']);
    expect((await store.get('job-second'))?.phase).toBe('awaiting_approval');
    expect(getEditorQueue().isHeldBy('job-second')).toBe(true);
  });

  test('에러: 사용권을 쥐지 않은 잡의 발행은 거부한다 (서버 재시작·점유 만료 후)', async () => {
    const jobId = 'job-nolease';
    await store.create(makeInput(jobId));
    await runJob(store, jobId);
    // 서버가 다시 시작된 것과 같은 상태 — 잡 파일은 승인 대기지만 큐에는 아무도 없다.
    resetEditorQueue();

    await expect(approveAndPublish(store, jobId)).rejects.toThrow(EditorNotHeldError);
    expect(publisher.publishCallCount).toBe(0);
  });

  test('경계값: 발행이 끝나면 사용권을 바로 반납한다', async () => {
    const jobId = 'job-release';
    await store.create(makeInput(jobId));
    await runJob(store, jobId);
    expect(getEditorQueue().isHeldBy(jobId)).toBe(true);

    await approveAndPublish(store, jobId);
    expect(getEditorQueue().isHeldBy(jobId)).toBe(false);
    expect(getEditorQueue().snapshot()).toEqual({ holder: null, waiting: [] });
  });

  test('경계값: 에디터를 채우다 실패하면 사용권을 바로 반납한다', async () => {
    const jobId = 'job-fillfail';
    await store.create(makeInput(jobId));
    publisher.shouldThrowOnFill = true;
    await runJob(store, jobId);

    expect((await store.get(jobId))?.phase).toBe('failed');
    expect(getEditorQueue().snapshot()).toEqual({ holder: null, waiting: [] });
  });
});

describe('runJob — 예상 못 한 실패에서도 에디터를 반납한다', () => {
  test('에러: 에디터를 채운 뒤 상태 저장이 깨져도 사용권이 남지 않는다', async () => {
    const jobId = 'job-patchfail';
    await store.create(makeInput(jobId));
    // fillEditor 직후의 저장을 깨뜨린다 — 이때 사용권을 쥔 채 끝나면 뒤의 모두가 막힌다.
    const realPatch = store.patch.bind(store);
    let calls = 0;
    store.patch = async (id, fields) => {
      calls += 1;
      // 1회: draft 저장, 2회: preview/editorDraft 저장 → 여기서 깨뜨린다.
      if (calls === 2) throw new Error('디스크 오류');
      return realPatch(id, fields);
    };

    await runJob(store, jobId);

    // 실제로 에디터를 채운 뒤에 깨졌는지 확인한다 — 그래야 이 테스트가 의도한 경로를 짚는다.
    expect(publisher.fillEditorCallCount).toBe(1);
    expect((await store.get(jobId))?.phase).toBe('failed');
    expect(getEditorQueue().snapshot()).toEqual({ holder: null, waiting: [] });
  });
});
