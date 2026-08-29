import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { CategoryNotFoundError, ElementNotFoundError, EvaluationFailedError } from '@/lib/naver/errors';
import {
  attachPlace,
  capturePreview,
  closeCurrentTab,
  dismissEntryPopups,
  fillBodyAndImages,
  fillTitle,
  openEditor,
  openPublishPanel,
  selectCategory,
  setTags,
  setThumbnail,
  submitPublish,
  PUBLISH_CLICK_MARKER,
} from '@/lib/naver/steps';
import type { AsideEvalResult, AsideReplApi, PostDraft, PostInput, UploadedImage } from '@/lib/types';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures');
// 보안 정책: /tmp·$TMPDIR 대신 프로젝트 내부(gitignore 된 .vitest-tmp)에만 파일을 만든다
const scratchDir = path.join(here, '..', '..', '.vitest-tmp', 'naver-steps-tests');
const sessionDir = path.join(scratchDir, 'aside-session');

async function loadFixture(name: string): Promise<string> {
  return readFile(path.join(fixturesDir, name), 'utf8');
}

function ok(stdout: string): AsideEvalResult {
  return { ok: true, stdout, durationMs: 1, error: null };
}

function fail(error: string): AsideEvalResult {
  return { ok: false, stdout: '', durationMs: 1, error };
}

interface FakeOptions {
  tree?: string;
  hasEditorFrame?: boolean;
  categories?: string[];
  panelOpen?: boolean;
  imageCount?: number;
  visibleCount?: number;
  publishUrl?: string | null;
  placePopupOpen?: boolean;
  placeResultCount?: number;
  placeAttached?: boolean;
  failAll?: string;
}

/**
 * 호출 순서를 하드코딩하지 않고 JS 내용으로 무엇을 묻는지 판별하는 가짜 REPL —
 * steps.ts 내부 리팩터에 깨지지 않게 하기 위함이다.
 */
function fakeRepl(opts: FakeOptions = {}) {
  const calls: string[] = [];
  let uploadCount = 0;
  const repl: AsideReplApi = {
    async start() {},
    async dispose() {},
    async evaluate(js: string): Promise<AsideEvalResult> {
      calls.push(js);
      if (opts.failAll !== undefined) return fail(opts.failAll);

      if (js.includes('se-map-toolbar-button')) {
        const popupOpen = opts.placePopupOpen ?? true;
        const resultCount = popupOpen ? (opts.placeResultCount ?? 1) : 0;
        return ok(
          JSON.stringify({
            popupOpen,
            resultCount,
            attached: resultCount > 0 && (opts.placeAttached ?? true),
            firstName: '판교역 신분당선',
          }),
        );
      }
      if (js.includes(PUBLISH_CLICK_MARKER)) {
        return ok(JSON.stringify({ resultUrl: opts.publishUrl ?? null }));
      }
      if (js.includes('dir: pwd')) {
        return ok(JSON.stringify({ dir: sessionDir }));
      }
      if (js.includes('se-popup-button-cancel') || js.includes('se-help-panel-close-button')) {
        return ok(JSON.stringify({ dismissed: false }));
      }
      if (js.includes('names.indexOf')) {
        const match = js.match(/const target = "([^"]*)";/);
        const target = match ? match[1] : '';
        const names = opts.categories ?? ['여행', '일상'];
        return ok(JSON.stringify({ names, index: names.indexOf(target) }));
      }
      if (js.includes('panelOpen')) {
        return ok(JSON.stringify({ panelOpen: opts.panelOpen ?? true }));
      }
      if (js.includes('chooser')) {
        // 실제 에디터처럼 업로드할 때마다 이미지 수가 늘어난다. opts.imageCount 를 주면
        // 그 값으로 고정해 "업로드가 확인되지 않는" 상황을 흉내낼 수 있다.
        uploadCount += 1;
        return ok(JSON.stringify({ count: opts.imageCount ?? uploadCount }));
      }
      if (js.includes('openTab')) {
        return ok(
          JSON.stringify({
            hasEditorFrame: opts.hasEditorFrame ?? true,
            tree: opts.tree ?? '',
            url: 'https://blog.naver.com/tester?Redirect=Write',
          }),
        );
      }
      if (js.includes('snapshot(page')) {
        return ok(JSON.stringify({ tree: opts.tree ?? '' }));
      }
      if (js.includes('.count()')) {
        return ok(JSON.stringify({ count: opts.visibleCount ?? 1 }));
      }
      return ok(JSON.stringify({ ok: true }));
    },
  };
  return { repl, calls };
}

function makeImage(n: number, overrides: Partial<UploadedImage> = {}): UploadedImage {
  return {
    id: `img-${n}`,
    originalName: `photo-${n}.jpg`,
    path: path.join(scratchDir, `photo-${n}.jpg`),
    mimeType: 'image/jpeg',
    bytes: 1024,
    width: 800,
    height: 600,
    order: n - 1,
    ...overrides,
  };
}

function makeInput(imageCount: number, overrides: Partial<PostInput> = {}): PostInput {
  return {
    jobId: 'job-1',
    category: '여행',
    highlights: '하이라이트',
    place: '',
    images: Array.from({ length: imageCount }, (_, i) => makeImage(i + 1)),
    createdAt: '2026-08-25T00:00:00.000Z',
    ...overrides,
  };
}

function makeDraft(imageCount: number, overrides: Partial<PostDraft> = {}): PostDraft {
  return {
    title: '제목',
    intro: '인트로',
    blocks: Array.from({ length: imageCount }, (_, i) => ({
      imageId: `img-${i + 1}`,
      caption: `캡션-${i + 1}`,
      altText: `대체텍스트-${i + 1}`,
    })),
    outro: '아웃트로',
    tags: ['태그1'],
    topic: '여행',
    thumbnailImageId: 'img-1',
    generatedAt: '2026-08-25T00:00:00.000Z',
    model: 'claude-test',
    ...overrides,
  };
}

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

describe('openEditor', () => {
  test('정상: 에디터 iframe 이 확인되면 진입 URL 을 돌려준다', async () => {
    const { repl } = fakeRepl({ tree: await loadFixture('editor-ready.snapshot.txt') });
    await expect(openEditor({ repl }, 'tester')).resolves.toContain('blog.naver.com/tester');
  });

  // 실측 회귀: iframe 의 접근성 이름으로 판정하면 정상 화면에서도 실패한다 —
  // 존재 확인은 DOM 셀렉터(hasEditorFrame)로만 한다.
  test('에러: iframe 이 없으면(로그인 페이지 등) 단계명·발췌를 담아 실패한다', async () => {
    const { repl } = fakeRepl({ hasEditorFrame: false, tree: await loadFixture('login-page.snapshot.txt') });
    await expect(openEditor({ repl }, 'tester')).rejects.toThrow(ElementNotFoundError);
    await expect(openEditor({ repl }, 'tester')).rejects.toThrow(/openEditor/);
  });

  test('에러: evaluate 자체가 실패하면 "못 찾음" 이 아니라 "수행 못 함" 이다', async () => {
    const { repl } = fakeRepl({ failAll: '채널 죽음' });
    await expect(openEditor({ repl }, 'tester')).rejects.toThrow(EvaluationFailedError);
    await expect(openEditor({ repl }, 'tester')).rejects.toThrow(/채널 죽음/);
  });
});

describe('dismissEntryPopups', () => {
  test('정상: 팝업이 없어도 실패하지 않는다', async () => {
    const { repl } = fakeRepl();
    await expect(dismissEntryPopups({ repl })).resolves.toBeUndefined();
  });

  test('경계값: evaluate 가 실패해도 이 단계는 실패하지 않는다(선택적 정리)', async () => {
    const { repl } = fakeRepl({ failAll: '팝업 확인 실패' });
    await expect(dismissEntryPopups({ repl })).resolves.toBeUndefined();
  });
});

describe('fillTitle', () => {
  test('정상: 제목을 입력한다', async () => {
    const { repl } = fakeRepl();
    await expect(fillTitle({ repl }, '제목입니다')).resolves.toBeUndefined();
  });

  test('경계값(D7): 따옴표·개행·백틱·역슬래시가 든 제목이 안전하게 주입된다', async () => {
    const { repl, calls } = fakeRepl();
    const nasty = '"따옴표" `백틱` \\역슬래시\\ \n줄바꿈';
    await fillTitle({ repl }, nasty);
    const typed = calls.find((js) => js.includes('keyboard.type'));
    expect(typed).toBeDefined();
    expect(typed).toContain(JSON.stringify(nasty));
  });

  test('에러: 제목 입력 영역이 없으면 실패한다', async () => {
    const { repl } = fakeRepl({ visibleCount: 0 });
    await expect(fillTitle({ repl }, '제목')).rejects.toThrow(ElementNotFoundError);
  });
});

describe('fillBodyAndImages — 정상', () => {
  test('이미지 1장짜리 draft 로 동작한다', async () => {
    const { repl } = fakeRepl();
    await expect(fillBodyAndImages({ repl }, makeDraft(1), makeInput(1))).resolves.toBeUndefined();
  });

  // 실측 회귀: 조각마다 본문을 다시 클릭해 캐럿을 잡으면 글이 뒤엉킨다.
  test('본문 클릭(포커스)은 딱 한 번만 일어난다', async () => {
    const { repl, calls } = fakeRepl();
    await fillBodyAndImages({ repl }, makeDraft(2), makeInput(2));
    const focusCalls = calls.filter((js) => js.includes('focused: true'));
    expect(focusCalls).toHaveLength(1);
  });

  test('이미지를 aside 세션 디렉터리로 복사한 뒤 그 경로로 업로드한다', async () => {
    const { repl, calls } = fakeRepl();
    await fillBodyAndImages({ repl }, makeDraft(1), makeInput(1));
    const upload = calls.find((js) => js.includes('setFiles'));
    expect(upload).toContain(path.join(sessionDir, 'anb-uploads'));
  });
});

describe('fillBodyAndImages — 에러/경계값', () => {
  test('에러: 이미지가 0장이면 거부하고 브라우저를 건드리지 않는다', async () => {
    const { repl, calls } = fakeRepl();
    await expect(fillBodyAndImages({ repl }, makeDraft(0), makeInput(0))).rejects.toThrow(/0장/);
    expect(calls).toHaveLength(0);
  });

  test('에러: blocks 개수가 이미지 수와 다르면 거부한다', async () => {
    const { repl } = fakeRepl();
    await expect(fillBodyAndImages({ repl }, makeDraft(2), makeInput(1))).rejects.toThrow(/blocks 개수/);
  });

  test('에러: 업로드가 확인되지 않으면 실패한다', async () => {
    const { repl } = fakeRepl({ imageCount: 0 });
    await expect(fillBodyAndImages({ repl }, makeDraft(1), makeInput(1))).rejects.toThrow(/업로드가 확인되지 않음/);
  });
});

// 실측(2026-08-29): 장소는 본문에 텍스트로 적는 대신 에디터의 '장소' 검색으로 붙인다.
// 검색어 입력칸이 react-autosuggest 라 키보드 타이핑으로는 한글이 첫 글자만 들어가서
// fill() 을 쓰고, 결과의 '추가' 버튼은 hover 전 클릭 판정을 통과하지 못해 DOM 클릭한다.
describe('attachPlace — 정상', () => {
  test('검색 결과 1번째를 고르고 본문에 장소 블록을 넣는다', async () => {
    const { repl, calls } = fakeRepl({ placeResultCount: 3, placeAttached: true });
    await expect(attachPlace({ repl }, '판교역')).resolves.toBeUndefined();
    const js = calls.find((call) => call.includes('se-map-toolbar-button'));
    expect(js).toContain('"판교역"');
    expect(js).toContain('items.first()');
  });

  test('검색어는 타이핑이 아니라 fill() 로 한 번에 넣는다(한글 잘림 회귀)', async () => {
    const { repl, calls } = fakeRepl({ placeResultCount: 1, placeAttached: true });
    await attachPlace({ repl }, '판교역');
    const js = calls.find((call) => call.includes('se-map-toolbar-button'));
    expect(js).toContain('.fill("판교역")');
    expect(js).not.toContain('keyboard.type');
  });

  test('경계값: 앞뒤 공백은 다듬어 검색한다', async () => {
    const { repl, calls } = fakeRepl({ placeResultCount: 1, placeAttached: true });
    await attachPlace({ repl }, '  판교역  ');
    expect(calls.find((call) => call.includes('se-map-toolbar-button'))).toContain('.fill("판교역")');
  });
});

describe('attachPlace — 결과 없음/생략', () => {
  test('검색 결과가 없으면 팝업만 닫고 실패하지 않는다', async () => {
    const { repl } = fakeRepl({ placeResultCount: 0, placeAttached: false });
    await expect(attachPlace({ repl }, '없는장소')).resolves.toBeUndefined();
  });

  test('경계값: 장소가 비어 있으면 브라우저를 건드리지 않는다', async () => {
    const { repl, calls } = fakeRepl();
    await attachPlace({ repl }, '');
    expect(calls).toHaveLength(0);
  });

  test('경계값: 공백뿐이면 브라우저를 건드리지 않는다', async () => {
    const { repl, calls } = fakeRepl();
    await attachPlace({ repl }, '   ');
    expect(calls).toHaveLength(0);
  });
});

describe('attachPlace — 에러', () => {
  test('팝업이 열리지 않으면 실패한다', async () => {
    const { repl } = fakeRepl({ placePopupOpen: false });
    await expect(attachPlace({ repl }, '판교역')).rejects.toThrow(ElementNotFoundError);
  });

  test('결과를 골랐는데 장소 블록이 안 들어가면 실패한다', async () => {
    const { repl } = fakeRepl({ placeResultCount: 2, placeAttached: false });
    await expect(attachPlace({ repl }, '판교역')).rejects.toThrow(/장소 블록이 들어가지 않았습니다/);
  });

  test('evaluate 가 실패하면 던진다', async () => {
    const { repl } = fakeRepl({ failAll: '팝업 죽음' });
    await expect(attachPlace({ repl }, '판교역')).rejects.toThrow(EvaluationFailedError);
  });
});

describe('setThumbnail', () => {
  test('정상: 첫 이미지가 대표면 통과한다(에디터 기본 동작이라 브라우저를 건드리지 않는다)', async () => {
    const { repl, calls } = fakeRepl();
    await expect(setThumbnail({ repl }, makeDraft(1), makeInput(1))).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  test('에러: thumbnailImageId 가 첫 이미지와 다르면 거부한다', async () => {
    const { repl } = fakeRepl();
    const draft = makeDraft(1, { thumbnailImageId: 'img-9' });
    await expect(setThumbnail({ repl }, draft, makeInput(1))).rejects.toThrow(/thumbnailImageId/);
  });

  test('경계값: 이미지가 0장이면 거부한다', async () => {
    const { repl } = fakeRepl();
    await expect(setThumbnail({ repl }, makeDraft(0), makeInput(0))).rejects.toThrow(/0장/);
  });
});

describe('openPublishPanel', () => {
  test('정상: 패널이 열리면 성공한다', async () => {
    const { repl } = fakeRepl({ panelOpen: true });
    await expect(openPublishPanel({ repl })).resolves.toBeUndefined();
  });

  test('에러: 패널이 열리지 않으면 실패한다', async () => {
    const { repl } = fakeRepl({ panelOpen: false });
    await expect(openPublishPanel({ repl })).rejects.toThrow(ElementNotFoundError);
  });

  test('경계값: 툴바 발행 버튼이 없으면 실패한다', async () => {
    const { repl } = fakeRepl({ visibleCount: 0 });
    await expect(openPublishPanel({ repl })).rejects.toThrow(/openPublishPanel/);
  });
});

describe('selectCategory', () => {
  test('정상: 목록에 있는 이름을 고른다', async () => {
    const { repl } = fakeRepl({ categories: ['여행', '일상'] });
    await expect(selectCategory({ repl }, '여행')).resolves.toBeUndefined();
  });

  test('정상(D14): 앞뒤 공백만 다른 이름도 일치로 처리한다', async () => {
    const { repl } = fakeRepl({ categories: ['여행'] });
    await expect(selectCategory({ repl }, '  여행  ')).resolves.toBeUndefined();
  });

  test('에러: 목록에 없으면 사용 가능한 이름들을 담아 실패한다', async () => {
    const { repl } = fakeRepl({ categories: ['여행', '일상'] });
    await expect(selectCategory({ repl }, '없는카테고리')).rejects.toThrow(CategoryNotFoundError);
    await expect(selectCategory({ repl }, '없는카테고리')).rejects.toThrow(/여행/);
  });

  test('경계값: 목록이 비어 있어도 조용히 넘어가지 않고 실패한다', async () => {
    const { repl } = fakeRepl({ categories: [] });
    await expect(selectCategory({ repl }, '여행')).rejects.toThrow(CategoryNotFoundError);
  });
});

describe('setTags', () => {
  test('정상: 태그를 입력한다', async () => {
    const { repl, calls } = fakeRepl();
    await setTags({ repl }, ['태그1', '태그2']);
    expect(calls.some((js) => js.includes('태그1') && js.includes('태그2'))).toBe(true);
  });

  test('경계값: 태그가 없으면 브라우저를 건드리지 않는다', async () => {
    const { repl, calls } = fakeRepl();
    await setTags({ repl }, []);
    expect(calls).toHaveLength(0);
  });

  test('에러: 태그 입력칸이 없으면 실패한다', async () => {
    const { repl } = fakeRepl({ visibleCount: 0 });
    await expect(setTags({ repl }, ['태그1'])).rejects.toThrow(ElementNotFoundError);
  });
});

describe('capturePreview', () => {
  test('정상: 세션 디렉터리에 찍은 뒤 목적지로 옮긴다', async () => {
    const { repl } = fakeRepl();
    const dest = path.join(scratchDir, 'out', 'preview.png');
    await capturePreview({ repl }, dest);
    expect(await readFile(dest, 'utf8')).toBe('fake-png');
  });

  test('에러: evaluate 가 실패하면 던진다', async () => {
    const { repl } = fakeRepl({ failAll: '스크린샷 실패' });
    await expect(capturePreview({ repl }, path.join(scratchDir, 'out', 'p.png'))).rejects.toThrow(/스크린샷 실패/);
  });
});

describe('submitPublish', () => {
  test('정상: 결과 URL 을 읽으면 그대로 돌려준다', async () => {
    const { repl } = fakeRepl({ publishUrl: 'https://blog.naver.com/tester/223000000001' });
    await expect(submitPublish({ repl })).resolves.toEqual({
      resultUrl: 'https://blog.naver.com/tester/223000000001',
    });
  });

  test('경계값: URL 을 못 읽으면 null 이다 (성공이라고 주장하지 않는다)', async () => {
    const { repl } = fakeRepl({ publishUrl: null });
    await expect(submitPublish({ repl })).resolves.toEqual({ resultUrl: null });
  });

  test('에러: evaluate 가 실패하면 던진다', async () => {
    const { repl } = fakeRepl({ failAll: '발행 클릭 실패' });
    await expect(submitPublish({ repl })).rejects.toThrow(EvaluationFailedError);
  });
});

describe('closeCurrentTab', () => {
  test('정상: 탭 정리를 요청한다', async () => {
    const { repl, calls } = fakeRepl();
    await closeCurrentTab({ repl });
    expect(calls.some((js) => js.includes('closeTab'))).toBe(true);
  });

  test('에러: evaluate 가 실패하면 던진다', async () => {
    const { repl } = fakeRepl({ failAll: '탭 정리 실패' });
    await expect(closeCurrentTab({ repl })).rejects.toThrow(/탭 정리 실패/);
  });
});
