import { draftNeedsRefill } from './draft-diff';
import { EditorNotHeldError, getEditorQueue } from './queue';
import { getServices } from './services';
import type { JobStore } from './store';
import type { PublishResult } from '../types';

/**
 * 점유 제한 시간을 넘겨 에디터를 강제로 반납할 때의 뒷정리.
 *
 * 사람이 승인 화면을 열어 둔 채 사라진 경우다. 버려진 에디터 탭을 닫고 잡을 취소로 끝낸다 —
 * 그래야 뒤에서 기다리던 사람이 깨끗한 에디터를 받는다. 큐는 이 정리가 끝난 뒤에야 다음
 * 잡을 들여보낸다(lib/job/queue.ts).
 */
async function releaseAbandonedEditor(store: JobStore, jobId: string): Promise<void> {
  try {
    const state = await store.get(jobId);
    // 이미 발행됐거나 실패했으면 정리할 것이 없다.
    if (!state || state.phase !== 'awaiting_approval') return;
    await getServices().publisher.abort();
    await store.transition(
      jobId,
      'cancelled',
      '승인이 없어 에디터를 반납했습니다 — 다른 사람이 쓸 수 있도록 잡을 취소합니다.',
    );
  } catch (err) {
    console.error(`releaseAbandonedEditor: job '${jobId}' 정리에 실패했습니다:`, err);
  }
}

async function failJob(store: JobStore, jobId: string, step: string, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  await store.patch(jobId, { error: { message, step, at: new Date().toISOString() } });
  await store.transition(jobId, 'failed', `실패(${step}): ${message}`);
}

// D14: awaiting_approval에서 반드시 반환하고 publisher.publish()를 부르지 않는다.
// 발행은 approveAndPublish()에서만 시작된다 — 이게 안전 계약의 기계적 표현이다.
export async function runJob(store: JobStore, jobId: string): Promise<void> {
  // 이 함수는 백그라운드로 불린다(POST /api/jobs 는 기다리지 않는다). 여기서 그냥 던지면
  // 잡 상태가 'created' 에 남아 화면은 영영 '진행 중'으로 보인다 — 어떤 실패든 잡에 기록한다.
  try {
    await runJobSteps(store, jobId);
  } catch (err) {
    // 예상 못 한 실패(예: 에디터를 채운 뒤 상태 저장이 깨진 경우)로 여기까지 왔다면 승인 대기에
    // 이르지 못한 것이다 — 에디터를 쥔 채 끝나지 않도록 반납한다. 쥐고 있지 않으면 무해하다.
    getEditorQueue().release(jobId);
    await failJob(store, jobId, 'unexpected', err).catch((patchErr: unknown) => {
      console.error(`runJob: 실패 기록조차 실패했습니다 (job '${jobId}'):`, patchErr);
    });
  }
}

async function runJobSteps(store: JobStore, jobId: string): Promise<void> {
  // 서비스 주입이 안 됐으면 여기서 바로 끝난다 — 부팅 훅이 돌지 않았다는 뜻이다.
  let services;
  try {
    services = getServices();
  } catch (err) {
    await failJob(store, jobId, 'bootstrap', err);
    return;
  }
  const { generator, publisher } = services;
  const onProgress = (message: string) => {
    // fire-and-forget: never let a log-append failure surface as an unhandled rejection
    store.appendLog(jobId, message).catch((err: unknown) => {
      console.error(`runJob: appendLog failed for job '${jobId}':`, err);
    });
  };

  const created = await store.transition(jobId, 'analyzing', '이미지 분석 시작');

  let draft;
  try {
    draft = await generator.generate(created.input, onProgress);
  } catch (err) {
    await failJob(store, jobId, 'generate', err);
    return;
  }

  await store.transition(jobId, 'drafting', '초안 생성 중');
  const draftReady = await store.patch(jobId, { draft });
  await store.transition(jobId, 'draft_ready', '초안 준비 완료');
  await store.transition(jobId, 'filling_editor', '네이버 에디터에 채우는 중');

  // 에디터(Aside REPL)는 하나뿐이다 — 차례를 기다렸다가 잡는다. 여기서 잡은 사용권은
  // 사람이 승인(발행)하거나 잡이 끝날 때까지 계속 쥐고 있다. 중간에 놓으면 다른 잡이
  // 같은 탭을 덮어써서, 승인한 내용과 다른 글이 올라간다.
  const queue = getEditorQueue();
  try {
    await queue.acquire(jobId, {
      onWait: (ahead) => onProgress(`앞에 ${ahead}건이 에디터를 쓰고 있습니다 — 차례를 기다립니다.`),
      onHoldExpired: () => releaseAbandonedEditor(store, jobId),
    });
  } catch (err) {
    await failJob(store, jobId, 'editorQueue', err);
    return;
  }

  let preview;
  try {
    preview = await publisher.fillEditor(draft, draftReady.input, onProgress);
  } catch (err) {
    // 에디터를 채우지 못했으면 붙잡고 있을 이유가 없다 — 바로 다음 사람에게 넘긴다.
    queue.release(jobId);
    await failJob(store, jobId, 'fillEditor', err);
    return;
  }

  // 지금 에디터에 채워진 초안을 기록해 둔다 — 사람이 승인 화면에서 고치면 이것과 달라지고,
  // 그때는 발행 전에 에디터를 고친 내용대로 다시 채운다.
  await store.patch(jobId, { preview, editorDraft: draft });
  await store.transition(jobId, 'awaiting_approval', '사람 승인 대기 중');
  // 여기서 끝난다 — publisher.publish()는 절대 호출하지 않는다.
  // 에디터 사용권은 반납하지 않는다. approveAndPublish() 가 발행을 마친 뒤(또는 점유 제한
  // 시간이 지나 releaseAbandonedEditor 가 정리한 뒤) 반납된다.
}

export async function approveAndPublish(store: JobStore, jobId: string): Promise<PublishResult> {
  const { publisher } = getServices();

  const state = await store.get(jobId);
  if (!state) {
    throw new Error(`approveAndPublish: job '${jobId}' does not exist`);
  }
  if (state.phase !== 'awaiting_approval') {
    throw new Error(
      `approveAndPublish: job '${jobId}' is not awaiting approval (current phase: '${state.phase}')`,
    );
  }

  // 이 잡이 에디터를 쥐고 있을 때만 발행한다. 서버가 다시 시작됐거나 점유 제한 시간이 지나
  // 반납된 뒤라면, 지금 에디터에 있는 내용은 이 잡의 것이 아니다 — 남의 글을 발행하지 않는다.
  const queue = getEditorQueue();
  if (!queue.isHeldBy(jobId)) {
    throw new EditorNotHeldError(jobId);
  }

  try {
    // 사람이 승인 화면에서 고쳤으면, 그 내용대로 에디터를 다시 채운 뒤 발행한다 —
    // 화면에서 본 그대로 올라가야 한다. 고친 게 없으면 다시 채우지 않는다(사진 재업로드가
    // 없으니 훨씬 빠르다).
    if (state.draft !== null && draftNeedsRefill(state.draft, state.editorDraft)) {
      // 단계는 awaiting_approval 그대로 둔다 — 이 잡의 단계 사슬은 한 방향으로만 흐르게
      // 되어 있고(store.isLegalTransition), 그 불변식을 이 경로 때문에 느슨하게 만들지 않는다.
      // 진행 상황은 로그로 알린다.
      await store.appendLog(jobId, '수정한 내용으로 에디터를 다시 채우는 중');
      const onProgress = (message: string) => {
        store.appendLog(jobId, message).catch((err: unknown) => {
          console.error(`approveAndPublish: appendLog failed for job '${jobId}':`, err);
        });
      };
      try {
        // 기존 에디터 탭을 정리하고 처음부터 다시 채운다.
        await publisher.abort();
        const preview = await publisher.fillEditor(state.draft, state.input, onProgress);
        await store.patch(jobId, { preview, editorDraft: state.draft });
      } catch (err) {
        await failJob(store, jobId, 'refillEditor', err);
        throw err;
      }
    }

    await store.transition(jobId, 'publishing', '발행 시작');

    let result: PublishResult;
    try {
      result = await publisher.publish();
    } catch (err) {
      await failJob(store, jobId, 'publish', err);
      throw err;
    }

    if (!result.ok) {
      await failJob(store, jobId, 'publish', new Error(result.message));
      return result;
    }

    await store.patch(jobId, { result });
    await store.transition(jobId, 'published', '발행 완료');
    return result;
  } finally {
    // 성공했든 실패했든 여기서 에디터를 놓는다 — 기다리던 다음 잡이 바로 들어간다.
    queue.release(jobId);
  }
}
