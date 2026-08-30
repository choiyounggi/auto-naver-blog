// t5 D2: 구현체 import 는 여기 한 곳에만 모인다. instrumentation.ts 는 조립을 하지 않고
// createServices()/disposeServices() 를 호출만 한다 — 그래야 조립을 테스트에서 브라우저
// 없이 부를 수 있다.
import { AsideRepl } from './aside/repl';
import { NaverSession } from './aside/naver-session';
import type { AppConfig } from './config';
import { ContentGenerator } from './content/generator';
import type { Services } from './job/services';
import { NaverPublisher } from './naver/publisher';
import type {
  AsideReplApi,
  EditorPreview,
  NaverPublisherApi,
  PostDraft,
  PostInput,
  ProgressFn,
  PublishResult,
} from './types';
import { PublishResultSchema } from './types';

// 실측(2026-08-30, ~/.aside/logs/daemon-2026-08-30.log): Aside 데몬은 오래 쉰 CLI REPL
// 세션을 회수한다. 우리 `aside repl` 자식 프로세스는 그대로 살아 있어 채널은 멀쩡해 보이지만,
// 다음 evaluate 가 'REPL session not found' 로 7ms 만에 실패한다. 그러면 NaverSession.status()
// 가 그 실패를 reason:'unknown' 으로 접어 넣고 fillEditor 는 "네이버 로그인이 되어 있지
// 않습니다" 로 죽는다 — 네이버 로그인은 멀쩡한데도. 게다가 inner 가 그대로 남아, 서버를
// 재시작하기 전까지 이후 모든 잡이 같은 죽은 채널을 다시 쓴다(21시간 쉬었다 온 잡 하나가
// 그렇게 실패했다).
//
// `aside repl` 에는 세션을 살려 두는 옵션이 없다(aside repl --help 실측). 그래서 재사용 전에
// 부작용 없는 한 줄로 한 번 찔러 본다 — 살아 있으면 값싸게 끝나고, 죽었으면 그 자리에서
// 드러나 REPL 을 버리고 새로 만든다.
const PROBE_JS = `console.log(JSON.stringify({ probe: true }));`;

export type ReplFactory = (config: AppConfig) => AsideReplApi;

export interface CreateServicesOptions {
  replFactory?: ReplFactory;
}

// t5 D3: NaverPublisherApi 에는 start() 가 없다(실측) — 이 어댑터가 REPL 의 지연 시작·재사용을
// 감싼다. 첫 fillEditor() 호출 때만 AsideRepl 을 만들고 start() 한다; 잡이 없는데 서버 부팅만
//으로 브라우저 자식 프로세스를 띄우지 않기 위해서다.
class LazyNaverPublisher implements NaverPublisherApi {
  private readonly config: AppConfig;
  private readonly replFactory: ReplFactory;
  private repl: AsideReplApi | null = null;
  private inner: NaverPublisherApi | null = null;

  constructor(config: AppConfig, replFactory: ReplFactory) {
    this.config = config;
    this.replFactory = replFactory;
  }

  async fillEditor(draft: PostDraft, input: PostInput, onProgress?: ProgressFn): Promise<EditorPreview> {
    const inner = await this.ensureInner();
    return inner.fillEditor(draft, input, onProgress);
  }

  /**
   * 쓸 수 있는 REPL 을 보장한다 — 살아 있으면 재사용하고, 죽었으면 버리고 새로 만든다.
   *
   * 이 복구는 fillEditor 에서만 한다. publish()/refreshPreview() 는 이미 채워 둔 에디터
   * 탭을 전제로 하므로, 그 채널이 죽었다면 조용히 새 REPL 을 붙여선 안 된다 — 빈 에디터를
   * 발행하게 된다. 거기서는 시끄럽게 실패하는 편이 맞다.
   */
  private async ensureInner(): Promise<NaverPublisherApi> {
    if (this.inner && !(await this.replResponds())) {
      await this.discardRepl();
    }
    if (!this.inner) {
      const repl = this.replFactory(this.config);
      // start() 가 throw 하면 this.repl/this.inner 는 여전히 null 로 남아, 다음 호출이
      // 깨끗한 상태에서 다시 시도한다 (실패한 inner 를 재사용하지 않는다).
      await repl.start();
      const session = new NaverSession(repl, this.config);
      this.inner = new NaverPublisher(repl, session, this.config);
      this.repl = repl;
    }
    return this.inner;
  }

  private async replResponds(): Promise<boolean> {
    const repl = this.repl;
    if (!repl) return false;
    try {
      return (await repl.evaluate(PROBE_JS)).ok;
    } catch {
      return false;
    }
  }

  /** 못 쓰게 된 REPL 을 버린다. disposeRepl() 은 await 하기 전에 repl/inner 를 비우므로,
   * 정리가 실패해도 다음 호출은 새 REPL 을 만든다. */
  private async discardRepl(): Promise<void> {
    try {
      await this.disposeRepl();
    } catch {
      // 이미 죽은 채널을 닫다 난 오류는 무시한다 — 어차피 버리는 중이다.
    }
  }

  async refreshPreview(input: PostInput): Promise<EditorPreview> {
    if (!this.inner) {
      throw new Error('[pipeline] refreshPreview() 가 fillEditor() 없이 호출되었습니다.');
    }
    return this.inner.refreshPreview(input);
  }

  async publish(): Promise<PublishResult> {
    if (!this.inner) {
      // NaverPublisher.publish() 가 fillEditor 없이 불렸을 때와 같은 방식으로 거부한다:
      // throw 가 아니라 ok:false 인 PublishResult 를 돌려준다.
      return PublishResultSchema.parse({
        ok: false,
        postUrl: null,
        publishedAt: null,
        message: '[pipeline] publish() 가 fillEditor() 없이(또는 실패 후) 호출되었습니다 — 발행을 거부합니다.',
      });
    }
    return this.inner.publish();
  }

  async abort(): Promise<void> {
    if (!this.inner) {
      // fillEditor 가 아직 REPL 을 만든 적이 없으면 건드릴 게 없다 — 무해하게 반환한다.
      return;
    }
    return this.inner.abort();
  }

  async disposeRepl(): Promise<void> {
    if (this.repl) {
      const repl = this.repl;
      this.repl = null;
      this.inner = null;
      await repl.dispose();
    }
  }
}

let activePublisher: LazyNaverPublisher | null = null;

export function createServices(config: AppConfig, opts: CreateServicesOptions = {}): Services {
  const replFactory = opts.replFactory ?? ((c) => new AsideRepl(c));
  const generator = new ContentGenerator(config);
  const publisher = new LazyNaverPublisher(config, replFactory);
  activePublisher = publisher;
  return { generator, publisher };
}

// t5 D3/D4: 프로세스 종료 시 호출된다. 멱등 — REPL 이 없거나 이미 정리됐으면 아무 일도
// 하지 않는다.
export async function disposeServices(): Promise<void> {
  const publisher = activePublisher;
  activePublisher = null;
  if (publisher) {
    await publisher.disposeRepl();
  }
}
