// D8: fillEditor 는 절대 발행하지 않는다 — 발행 버튼을 누르는 코드(submitPublish)는
// publish() 안에서만 호출한다. publish() 는 fillEditor 가 성공한 뒤에만 동작한다.
// D2: 이 모듈은 "단계 시퀀스가 구현되었고, 합성 스냅샷 픽스처에 대해 단위 테스트가
// 통과한다"까지만 정직하게 주장한다 — 실제 발행 성공은 관측된 적이 없다.

import path from 'node:path';
import type { AppConfig } from '../config';
import type {
  AsideReplApi,
  EditorPreview,
  NaverPublisherApi,
  NaverSessionApi,
  PostDraft,
  PostInput,
  ProgressFn,
  PublishResult,
} from '../types';
import { PublishResultSchema } from '../types';
import type { StepCtx } from './steps';
import {
  capturePreview,
  closeCurrentTab,
  dismissEntryPopups,
  fillBodyAndImages,
  fillTitle,
  openEditor,
  selectCategory,
  setTags,
  setThumbnail,
  submitPublish,
} from './steps';

export class NaverPublisher implements NaverPublisherApi {
  private readonly repl: AsideReplApi;
  private readonly session: NaverSessionApi;
  private readonly config: AppConfig;

  // D8: fillEditor 가 성공적으로 끝났을 때만 true 로 바뀐다. publish() 는 이게 true 가
  // 아니면 submitPublish 를 호출하지 않고 거부한다.
  private editorFilled = false;

  // danger_zone: openEditor 가 이 인스턴스에서 탭을 연 적이 있는지 — abort() 가 "자기가
  // 연 탭만" 닫도록 판정하는 데 쓴다.
  private tabOpened = false;

  constructor(repl: AsideReplApi, session: NaverSessionApi, config: AppConfig) {
    this.repl = repl;
    this.session = session;
    this.config = config;
  }

  async fillEditor(draft: PostDraft, input: PostInput, onProgress?: ProgressFn): Promise<EditorPreview> {
    // D13: 로그인 확인이 에디터 조작 시작 전 가장 먼저다. 로그아웃 상태에서 클릭을 시작하면
    // 엉뚱한 페이지를 조작하게 된다.
    const status = await this.session.status();
    if (!status.loggedIn) {
      throw new Error(`[fillEditor] 네이버 로그인이 되어 있지 않습니다 (reason=${status.reason}).`);
    }

    const blogId = status.blogId ?? this.config.naverBlogId;
    if (!blogId) {
      throw new Error('[fillEditor] blogId 를 확인할 수 없습니다 (session.status() 도 config.naverBlogId 도 없음).');
    }

    const ctx: StepCtx = { repl: this.repl, onProgress };

    const editorUrl = await openEditor(ctx, blogId);
    this.tabOpened = true;
    await dismissEntryPopups(ctx);
    await selectCategory(ctx, input.category);
    await fillTitle(ctx, draft.title);
    await fillBodyAndImages(ctx, draft, input);
    await setThumbnail(ctx, draft, input);
    await setTags(ctx, draft.tags);

    // D12: 스크린샷은 <dataDir>/jobs/<jobId>/preview.png 에 남긴다. 이 스크린샷을 워커
    // 컨텍스트로 Read 하지 않는다.
    const screenshotPath = path.join(this.config.dataDir, 'jobs', input.jobId, 'preview.png');
    await capturePreview(ctx, screenshotPath);

    this.editorFilled = true;

    return {
      screenshotPath,
      editorUrl,
    };
  }

  async publish(): Promise<PublishResult> {
    // D8: fillEditor 가 성공한 적이 없으면 거부한다 — submitPublish 를 호출하지 않는다.
    if (!this.editorFilled) {
      return PublishResultSchema.parse({
        ok: false,
        postUrl: null,
        publishedAt: null,
        message: 'publish() 가 fillEditor() 없이(또는 실패 후) 호출되었습니다 — 발행을 거부합니다.',
      });
    }

    // D8 경계값: 이 publish() 호출이 소비하는 "채워짐" 상태를 여기서 소진한다 — 연속으로
    // publish() 를 또 부르면(새 fillEditor 없이) 두 번째는 거부되어야 한다.
    this.editorFilled = false;

    const ctx: StepCtx = { repl: this.repl };
    const { resultUrl } = await submitPublish(ctx);

    // D2: 실제로 관측한 것만 주장한다 — evaluate 가 성공했다는 것과 URL을 읽었다는 것뿐,
    // 그 URL이 실제로 발행된 글이라는 것은 라이브에서 확인된 적이 없다.
    // review r1 F1: publishedAt 도 postUrl 과 같은 규칙을 따른다 — resultUrl 을 못 읽었으면
    // (ok:false) 발행이 확인되지 않은 것이므로 시각을 채우지 않는다. 안 그러면 발행되지
    // 않은 기록에 "발행 시각"이 남아 사용자가 화면에서 잘못된 시각을 보게 된다.
    return PublishResultSchema.parse({
      ok: resultUrl !== null,
      postUrl: resultUrl,
      publishedAt: resultUrl !== null ? new Date().toISOString() : null,
      message:
        resultUrl !== null
          ? '발행 버튼을 클릭했고 URL을 읽었습니다. 실제 발행 성공 여부는 라이브에서 확인된 적이 없습니다.'
          : '발행 버튼을 클릭했지만 결과 URL을 읽지 못했습니다.',
    });
  }

  async abort(): Promise<void> {
    // danger_zone: 자기가 연 탭만 정리한다. 사용자가 열어둔 탭은 건드리지 않는다.
    // fillEditor 이전에 호출돼도(아직 아무 탭도 열지 않았어도) throw 하지 않는다 — 그때는
    // repl 을 아예 건드리지 않는다.
    if (this.tabOpened) {
      try {
        await closeCurrentTab({ repl: this.repl });
      } catch {
        // abort() 는 정리 시도다 — 정리 자체가 실패해도 다시 던지지 않는다.
      }
    }
    this.tabOpened = false;
    this.editorFilled = false;
  }
}
