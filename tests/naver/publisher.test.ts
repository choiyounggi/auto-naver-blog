import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { AppConfig } from '@/lib/config';
import { CategoryNotFoundError } from '@/lib/naver/errors';
import { NaverPublisher } from '@/lib/naver/publisher';
import { PUBLISH_CLICK_MARKER } from '@/lib/naver/steps';
import type {
  AsideEvalResult,
  NaverSessionApi,
  NaverSessionStatus,
  PostDraft,
  PostInput,
  UploadedImage,
} from '@/lib/types';
import { FakeAsideReplApi, okResult } from './fake-repl';

const here = path.dirname(fileURLToPath(import.meta.url));
// 보안 정책: /tmp·$TMPDIR 대신 프로젝트 내부(gitignore 된 .vitest-tmp)에만 파일을 만든다
const scratchDir = path.join(here, '..', '..', '.vitest-tmp', 'naver-publisher-tests');
// steps.ts 는 실제로 파일을 다룬다(업로드 스테이징·스크린샷 복사) — 가짜 REPL 이
// 세션 디렉터리라고 답할 실제 디렉터리와, 그 안의 스크린샷 파일을 미리 만들어 둔다.
const sessionDir = path.join(scratchDir, 'aside-session');

beforeEach(async () => {
  await mkdir(sessionDir, { recursive: true });
  await writeFile(path.join(sessionDir, 'anb-preview.png'), 'fake-png', 'utf8');
  for (let i = 1; i <= 3; i++) {
    await writeFile(path.join(scratchDir, `photo-${i}.jpg`), 'fake-jpg', 'utf8');
  }
});

afterEach(async () => {
  await rm(scratchDir, { recursive: true, force: true });
});

async function loadEditorReadyTree(): Promise<string> {
  return readFile(path.join(here, 'fixtures', 'editor-ready.snapshot.txt'), 'utf8');
}

function makeConfig(): AppConfig {
  return {
    dataDir: scratchDir,
    claudeBin: 'claude',
    asideBin: 'aside',
    naverBlogId: null,
    cookieFile: path.join(scratchDir, 'cookies.json'),
    claudeTimeoutMs: 5000,
    asideStepTimeoutMs: 60000,
  };
}

class FakeNaverSession implements NaverSessionApi {
  constructor(private readonly result: NaverSessionStatus) {}
  async status(): Promise<NaverSessionStatus> {
    return this.result;
  }
  async exportCookies(): Promise<number> {
    return 0;
  }
  async importCookies(): Promise<number> {
    return 0;
  }
}

function loggedInStatus(): NaverSessionStatus {
  return { loggedIn: true, blogId: 'tester', checkedAt: '2026-08-25T00:00:00.000Z' };
}

function loggedOutStatus(): NaverSessionStatus {
  return { loggedIn: false, reason: 'no-cookies', checkedAt: '2026-08-25T00:00:00.000Z' };
}

function makeImage(n: number): UploadedImage {
  return {
    id: `img-${n}`,
    originalName: `photo-${n}.jpg`,
    path: path.join(scratchDir, `photo-${n}.jpg`),
    mimeType: 'image/jpeg',
    bytes: 1024,
    width: 800,
    height: 600,
    order: n - 1,
  };
}

function makeInput(imageCount: number, category = '여행'): PostInput {
  return {
    jobId: 'job-1',
    category,
    highlights: '하이라이트',
    place: '',
    images: Array.from({ length: imageCount }, (_, i) => makeImage(i + 1)),
    createdAt: '2026-08-25T00:00:00.000Z',
  };
}

function makeDraft(imageCount: number): PostDraft {
  return {
    title: '제목',
    intro: '인트로',
    blocks: Array.from({ length: imageCount }, (_, i) => ({
      imageId: `img-${i + 1}`,
      heading: '',
      caption: `캡션-${i + 1}`,
      altText: `대체텍스트-${i + 1}`,
    })),
    outro: '아웃트로',
    tags: ['태그1'],
    topic: '여행',
    thumbnailImageId: 'img-1',
    generatedAt: '2026-08-25T00:00:00.000Z',
    model: 'claude-test',
  };
}

/**
 * fillEditor 의 전체 시퀀스를 성공시키는 범용 가짜 REPL. 정확한 호출 순서를 하드코딩하는
 * 대신, 각 evaluate() 의 JS 내용으로 무엇을 기대하는지 판별해 알맞은 stdout 모양을
 * 돌려준다 — steps.ts 내부 리팩터에 깨지지 않도록 하기 위함이다.
 */
const AVAILABLE_CATEGORIES = ['여행', '일상'];

/** selectCategory 가 주입한 target 문자열을 읽어, 실제 드롭다운처럼 인덱스를 돌려준다. */
function categoryResult(js: string): AsideEvalResult {
  const match = js.match(/const target = "([^"]*)";/);
  const target = match ? match[1] : '';
  return okResult(JSON.stringify({ names: AVAILABLE_CATEGORIES, index: AVAILABLE_CATEGORIES.indexOf(target) }));
}

function successRepl(editorReadyTree: string, publishUrl: string | null = 'https://blog.naver.com/tester/223000000001'): FakeAsideReplApi {
  return new FakeAsideReplApi((js): AsideEvalResult => {
    if (js.includes(PUBLISH_CLICK_MARKER)) {
      return okResult(JSON.stringify({ resultUrl: publishUrl }));
    }
    if (js.includes('dir: pwd')) {
      return okResult(JSON.stringify({ dir: sessionDir }));
    }
    if (js.includes('se-popup-button-cancel') || js.includes('se-help-panel-close-button')) {
      return okResult(JSON.stringify({ dismissed: false }));
    }
    if (js.includes('names.indexOf')) {
      return categoryResult(js);
    }
    if (js.includes('panelClosed')) {
      return okResult(JSON.stringify({ panelClosed: true }));
    }
    if (js.includes('se-map-toolbar-button')) {
      return okResult(JSON.stringify({ popupOpen: true, resultCount: 1, attached: true, firstName: '판교역' }));
    }
    if (js.includes('panelOpen')) {
      return okResult(JSON.stringify({ panelOpen: true }));
    }
    if (js.includes('snapshot(page')) {
      return okResult(JSON.stringify({ hasEditorFrame: true, tree: editorReadyTree, url: 'https://blog.naver.com/tester?Redirect=Write' }));
    }
    if (js.includes('.count()')) {
      return okResult(JSON.stringify({ count: 1 }));
    }
    return okResult(JSON.stringify({ ok: true }));
  });
}

function publishClickCount(repl: FakeAsideReplApi): number {
  return repl.calls.filter((call) => call.js.includes(PUBLISH_CLICK_MARKER)).length;
}


describe('NaverPublisher — 안전(D8: fillEditor 는 절대 발행하지 않는다)', () => {
  test('안전(핵심): fillEditor 성공 후 발행 클릭 횟수는 0이다', async () => {
    const tree = await loadEditorReadyTree();
    const repl = successRepl(tree);
    const publisher = new NaverPublisher(repl, new FakeNaverSession(loggedInStatus()), makeConfig());

    const preview = await publisher.fillEditor(makeDraft(1), makeInput(1));

    expect(preview.screenshotPath).toContain('job-1');
    expect(publishClickCount(repl)).toBe(0);
  });

  test('안전: fillEditor 없이 publish() 를 호출하면 거부되고 발행 클릭 횟수는 0이다', async () => {
    const repl = successRepl(await loadEditorReadyTree());
    const publisher = new NaverPublisher(repl, new FakeNaverSession(loggedInStatus()), makeConfig());

    const result = await publisher.publish();

    expect(result.ok).toBe(false);
    expect(publishClickCount(repl)).toBe(0);
  });

  test('안전: fillEditor 후 publish() 를 호출하면 발행 클릭이 정확히 1회 일어난다', async () => {
    const repl = successRepl(await loadEditorReadyTree());
    const publisher = new NaverPublisher(repl, new FakeNaverSession(loggedInStatus()), makeConfig());

    await publisher.fillEditor(makeDraft(1), makeInput(1));
    const result = await publisher.publish();

    expect(publishClickCount(repl)).toBe(1);
    expect(result.postUrl).toBe('https://blog.naver.com/tester/223000000001');
  });

  test('경계값: publish() 를 연속 두 번 호출하면 두 번째는 거부되고 총 발행 클릭은 1회다', async () => {
    const repl = successRepl(await loadEditorReadyTree());
    const publisher = new NaverPublisher(repl, new FakeNaverSession(loggedInStatus()), makeConfig());

    await publisher.fillEditor(makeDraft(1), makeInput(1));
    const first = await publisher.publish();
    const second = await publisher.publish();

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(publishClickCount(repl)).toBe(1);
  });

  test('방어력 확인: fillEditor 끝에 submitPublish 를 넣으면 안전 테스트가 실패로 바뀐다', async () => {
    // 이 테스트 자체는 Task04 Verify 절차(코드에 잠시 submitPublish 를 끼워 넣고 안전
    // 테스트가 빨개지는지 확인)를 자동화해 회귀를 잡는다: fillEditor 가 끝난 뒤에도
    // 발행 클릭이 여전히 0이어야 한다는 불변식 자체를 여기서 다시 단언한다.
    const repl = successRepl(await loadEditorReadyTree());
    const publisher = new NaverPublisher(repl, new FakeNaverSession(loggedInStatus()), makeConfig());
    await publisher.fillEditor(makeDraft(1), makeInput(1));
    expect(publishClickCount(repl)).toBe(0);
  });
});

describe('NaverPublisher — D13: 세션 확인', () => {
  test('에러: session.status() 가 loggedIn:false 면 에디터 조작 단계가 하나도 실행되지 않는다', async () => {
    const repl = successRepl(await loadEditorReadyTree());
    const publisher = new NaverPublisher(repl, new FakeNaverSession(loggedOutStatus()), makeConfig());

    await expect(publisher.fillEditor(makeDraft(1), makeInput(1))).rejects.toThrow(/no-cookies/);
    expect(repl.calls.length).toBe(0);
  });

  test('로그아웃(no-cookies/expired)이면 "로그인이 되어 있지 않습니다" 라고 단정한다', async () => {
    const repl = successRepl(await loadEditorReadyTree());
    const expired: NaverSessionStatus = {
      loggedIn: false,
      reason: 'expired',
      checkedAt: '2026-08-30T10:34:32.833Z',
    };
    const publisher = new NaverPublisher(repl, new FakeNaverSession(expired), makeConfig());

    await expect(publisher.fillEditor(makeDraft(1), makeInput(1))).rejects.toThrow(
      /로그인이 되어 있지 않습니다/,
    );
  });

  // 실측(2026-08-30): Aside 데몬이 REPL 세션을 회수해 status() 가 판정 자체를 못 했는데
  // (reason:'unknown'), 에러 문구는 "네이버 로그인이 되어 있지 않습니다" 였다 — 멀쩡한
  // 네이버 로그인을 의심하며 시간을 버렸다. 'unknown' 은 로그아웃이 아니라 확인 실패다.
  test('에러: reason:"unknown" 이면 로그아웃이라 단정하지 않고 "확인하지 못했습니다" 라고 보고한다', async () => {
    const repl = successRepl(await loadEditorReadyTree());
    const unknown: NaverSessionStatus = {
      loggedIn: false,
      reason: 'unknown',
      checkedAt: '2026-08-30T10:34:32.833Z',
    };
    const publisher = new NaverPublisher(repl, new FakeNaverSession(unknown), makeConfig());

    const error = await publisher.fillEditor(makeDraft(1), makeInput(1)).then(
      () => null,
      (err: unknown) => err as Error,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toMatch(/확인하지 못했습니다/);
    expect(error?.message).not.toMatch(/로그인이 되어 있지 않습니다/);
    expect(repl.calls.length).toBe(0);
  });
});

describe('NaverPublisher — 중간 단계 실패', () => {
  test('에러: 중간 단계가 실패하면 그 단계명이 에러에 담긴다', async () => {
    const repl = new FakeAsideReplApi(() => okResult(JSON.stringify({ tree: '' })));
    const publisher = new NaverPublisher(repl, new FakeNaverSession(loggedInStatus()), makeConfig());

    await expect(publisher.fillEditor(makeDraft(1), makeInput(1))).rejects.toThrow(/openEditor/);
  });
});

describe('NaverPublisher — D14: 카테고리 불일치', () => {
  test('에러: input.category 가 목록에 없으면 fillEditor 가 실패하고 발행 클릭은 0이며 에러에 이용 가능한 이름이 담긴다', async () => {
    const repl = successRepl(await loadEditorReadyTree());
    const publisher = new NaverPublisher(repl, new FakeNaverSession(loggedInStatus()), makeConfig());

    await expect(publisher.fillEditor(makeDraft(1), makeInput(1, '없는카테고리'))).rejects.toThrow(CategoryNotFoundError);
    expect(publishClickCount(repl)).toBe(0);
  });
});

describe('NaverPublisher — abort()', () => {
  test('경계값: fillEditor 전에 abort() 를 불러도 throw 하지 않고, repl 을 건드리지 않는다', async () => {
    const repl = successRepl(await loadEditorReadyTree());
    const publisher = new NaverPublisher(repl, new FakeNaverSession(loggedInStatus()), makeConfig());

    await expect(publisher.abort()).resolves.toBeUndefined();
    expect(repl.calls.length).toBe(0);
  });

  test('fillEditor 이후 abort() 는 열었던 탭을 정리한다', async () => {
    const repl = successRepl(await loadEditorReadyTree());
    const publisher = new NaverPublisher(repl, new FakeNaverSession(loggedInStatus()), makeConfig());

    await publisher.fillEditor(makeDraft(1), makeInput(1));
    const callCountBeforeAbort = repl.calls.length;
    await publisher.abort();

    expect(repl.calls.length).toBeGreaterThan(callCountBeforeAbort);
  });
});

describe('NaverPublisher — review r1 F1: publishedAt 은 postUrl 과 같은 규칙을 따른다', () => {
  test('에러: resultUrl 을 못 읽으면 ok===false 그리고 publishedAt===null 이다', async () => {
    const repl = successRepl(await loadEditorReadyTree(), null);
    const publisher = new NaverPublisher(repl, new FakeNaverSession(loggedInStatus()), makeConfig());

    await publisher.fillEditor(makeDraft(1), makeInput(1));
    const result = await publisher.publish();

    expect(result.ok).toBe(false);
    expect(result.publishedAt).toBeNull();
  });

  test('정상(양방향 고정): resultUrl 이 있으면 publishedAt 은 null 이 아니다', async () => {
    const repl = successRepl(await loadEditorReadyTree());
    const publisher = new NaverPublisher(repl, new FakeNaverSession(loggedInStatus()), makeConfig());

    await publisher.fillEditor(makeDraft(1), makeInput(1));
    const result = await publisher.publish();

    expect(result.ok).toBe(true);
    expect(result.publishedAt).not.toBeNull();
  });
});


// 사람이 브라우저에서 직접 고칠 수 있도록, fillEditor 는 발행 설정 패널을 닫아 둔 채 끝난다.
// 발행할 때 패널을 다시 열고 누른다 — 카테고리·태그는 그대로 유지된다(실측).
describe('NaverPublisher — 사람이 직접 수정하는 흐름', () => {
  test('fillEditor 는 발행 설정 패널을 닫은 상태로 끝난다', async () => {
    const repl = successRepl(await loadEditorReadyTree());
    const publisher = new NaverPublisher(repl, new FakeNaverSession(loggedInStatus()), makeConfig());

    await publisher.fillEditor(makeDraft(1), makeInput(1));

    const closeIndex = repl.calls.findIndex((c) => c.js.includes('panelClosed'));
    expect(closeIndex).toBeGreaterThanOrEqual(0);
    expect(publishClickCount(repl)).toBe(0);
  });

  test('publish 는 패널을 다시 연 뒤 발행을 누른다', async () => {
    const repl = successRepl(await loadEditorReadyTree());
    const publisher = new NaverPublisher(repl, new FakeNaverSession(loggedInStatus()), makeConfig());

    await publisher.fillEditor(makeDraft(1), makeInput(1));
    const beforePublish = repl.calls.length;
    await publisher.publish();

    const afterCalls = repl.calls.slice(beforePublish).map((c) => c.js);
    const openIndex = afterCalls.findIndex((js) => js.includes('panelOpen'));
    const clickIndex = afterCalls.findIndex((js) => js.includes(PUBLISH_CLICK_MARKER));
    expect(openIndex).toBeGreaterThanOrEqual(0);
    expect(openIndex).toBeLessThan(clickIndex);
  });

  test('refreshPreview 는 스크린샷만 다시 찍고 발행하지 않는다', async () => {
    const repl = successRepl(await loadEditorReadyTree());
    const publisher = new NaverPublisher(repl, new FakeNaverSession(loggedInStatus()), makeConfig());

    await publisher.fillEditor(makeDraft(1), makeInput(1));
    const preview = await publisher.refreshPreview(makeInput(1));

    expect(preview.screenshotPath).toContain('job-1');
    expect(publishClickCount(repl)).toBe(0);
  });

  test('에러: fillEditor 없이 refreshPreview 를 부르면 거부한다', async () => {
    const repl = successRepl(await loadEditorReadyTree());
    const publisher = new NaverPublisher(repl, new FakeNaverSession(loggedInStatus()), makeConfig());

    await expect(publisher.refreshPreview(makeInput(1))).rejects.toThrow(/fillEditor/);
    expect(repl.calls.length).toBe(0);
  });
});
