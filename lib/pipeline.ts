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
    if (!this.inner) {
      const repl = this.replFactory(this.config);
      // start() 가 throw 하면 this.repl/this.inner 는 여전히 null 로 남아, 다음 호출이
      // 깨끗한 상태에서 다시 시도한다 (실패한 inner 를 재사용하지 않는다).
      await repl.start();
      const session = new NaverSession(repl, this.config);
      this.inner = new NaverPublisher(repl, session, this.config);
      this.repl = repl;
    }
    return this.inner.fillEditor(draft, input, onProgress);
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
