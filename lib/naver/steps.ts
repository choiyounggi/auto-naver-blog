// 스마트에디터 ONE 조작 단계.
//
// 2026-08-25 실측으로 흐름이 바뀌었다: 카테고리·태그·공개설정은 본문 화면이 아니라
// 툴바의 '발행' 을 눌렀을 때 열리는 **발행 설정 패널** 안에 있다. 그래서 순서가
//   제목 → 본문·이미지 → 발행 패널 열기 → 카테고리 → 태그 → 미리보기(정지)
// 가 되고, 실제 발행은 패널 안의 '발행' 버튼을 누르는 별도 단계다.
// 이 구조 덕분에 안전 계약이 그대로 유지된다 — 패널을 열어 둔 상태에서 멈추므로
// 사람이 승인하기 전에는 아무것도 발행되지 않는다.
//
// D4/D5: 각 단계는 (1) 성공, (2) 대상을 못 찾음(ElementNotFoundError), (3) 검사 자체를
// 수행 못 함(EvaluationFailedError) 을 서로 다른 에러로 낸다.
// D7: REPL 로 보내는 JS 안의 사용자 값은 전부 JSON.stringify 로 직렬화해 주입한다.

import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { AsideReplApi, PostDraft, PostInput, ProgressFn } from '../types';
import { CategoryNotFoundError, ElementNotFoundError, EvaluationFailedError } from './errors';
import {
  BODY_MODULE,
  BOLD_BUTTON,
  CATEGORY_DROPDOWN_BUTTON,
  CATEGORY_OPTION_LABEL,
  EDITOR_FRAME_NAME,
  FONT_SIZE_BODY,
  FONT_SIZE_BUTTON,
  FONT_SIZE_HEADING,
  FONT_SIZE_OPTION,
  IMAGE_TOOLBAR_BUTTON,
  POPUP_DRAFT_RESTORE_CANCEL,
  POPUP_HELP_PANEL_CLOSE,
  PLACE_ADD_BUTTON,
  PLACE_CLOSE_BUTTON,
  PLACE_COMPONENT,
  PLACE_CONFIRM_BUTTON,
  PLACE_POPUP,
  PLACE_RESULT_ADDRESS,
  PLACE_RESULT_ITEM,
  PLACE_RESULT_TITLE,
  PLACE_SEARCH_BUTTON,
  PLACE_SEARCH_INPUT,
  PLACE_TOOLBAR_BUTTON,
  PUBLISH_CONFIRM_BUTTON,
  PUBLISH_PANEL_OPEN_BUTTON,
  TAG_INPUT,
  TIMEOUT_NAVIGATE_MS,
  TIMEOUT_PUBLISH_MS,
  TIMEOUT_TYPE_MS,
  TIMEOUT_UPLOAD_MS,
  TITLE_PLACEHOLDER,
  UPLOADED_IMAGE,
  writeUrl,
} from './selectors';
import { excerptAround } from './snapshot-query';
import { parseLastJson } from '../aside/protocol';

export interface StepCtx {
  repl: AsideReplApi;
  onProgress?: ProgressFn;
}

// 에디터 iframe 안을 가리키는 로케이터 표현식. 직접 page.locator() 를 쓰면 iframe 을 뚫지 못한다.
const FRAME = `page.frameLocator(${JSON.stringify(`iframe[name="${EDITOR_FRAME_NAME}"]`)})`;

function frameLocator(cssSelector: string): string {
  return `${FRAME}.locator(${JSON.stringify(cssSelector)})`;
}

// ---------------------------------------------------------------------------
// 저수준 헬퍼
// ---------------------------------------------------------------------------

async function runEvaluate(ctx: StepCtx, stepName: string, js: string, timeoutMs: number): Promise<string> {
  const result = await ctx.repl.evaluate(js, { timeoutMs });
  if (!result.ok) {
    throw new EvaluationFailedError(stepName, result.error ?? 'evaluate 가 이유 없이 실패함');
  }
  return result.stdout;
}

function parseJsonStdout<T>(stepName: string, stdout: string): T {
  const parsed = parseLastJson<T>(stdout);
  if (parsed === null) {
    throw new EvaluationFailedError(stepName, `evaluate 응답을 JSON으로 파싱하지 못함: ${stdout.slice(0, 300)}`);
  }
  return parsed;
}

/** 현재 화면의 접근성 스냅샷 — 실패했을 때 사람이 볼 근거로 쓴다. */
async function fetchTree(ctx: StepCtx, stepName: string, timeoutMs: number): Promise<string> {
  const js = `
await (async () => {
  const result = await snapshot(page, { interactive: true });
  console.log(JSON.stringify({ tree: result.tree }));
})();
`;
  const stdout = await runEvaluate(ctx, stepName, js, timeoutMs);
  const parsed = parseJsonStdout<{ tree?: unknown }>(stepName, stdout);
  if (typeof parsed.tree !== 'string') {
    throw new EvaluationFailedError(stepName, 'snapshot 응답에 tree 필드가 없음');
  }
  return parsed.tree;
}

/** 셀렉터가 실제로 하나 이상 잡히는지 확인한다. 없으면 스냅샷 발췌를 담아 실패한다. */
async function requireVisible(
  ctx: StepCtx,
  stepName: string,
  label: string,
  cssSelector: string,
  timeoutMs: number,
  excerptNeedle: string,
): Promise<void> {
  const js = `
await (async () => {
  const locator = ${frameLocator(cssSelector)};
  let count = 0;
  for (let attempt = 0; attempt < 20 && count === 0; attempt++) {
    count = await locator.count();
    if (count === 0) await sleep(500);
  }
  console.log(JSON.stringify({ count }));
})();
`;
  const stdout = await runEvaluate(ctx, stepName, js, timeoutMs);
  const { count } = parseJsonStdout<{ count?: number }>(stepName, stdout);
  if (typeof count !== 'number' || count === 0) {
    const tree = await fetchTree(ctx, stepName, TIMEOUT_TYPE_MS).catch(() => '(스냅샷도 실패)');
    throw new ElementNotFoundError(stepName, `${label} (${cssSelector})`, excerptAround(tree, excerptNeedle));
  }
}

// ---------------------------------------------------------------------------
// 단계
// ---------------------------------------------------------------------------

/** 탭을 열고 글쓰기 URL로 진입한 뒤, 에디터 iframe이 실제로 로드됐는지 확인한다. */
export async function openEditor(ctx: StepCtx, blogId: string): Promise<string> {
  const stepName = 'openEditor';
  const url = writeUrl(blogId);
  // 실측: iframe 존재를 스냅샷의 접근성 이름으로 판정하면 안 된다 — iframe 의 접근성
  // 이름은 title/aria-label 에서 오지 name 속성에서 오지 않아, 정상 화면에서도 이름 없는
  // `- iframe:` 으로만 찍힌다. frameLocator 가 쓰는 것과 같은 셀렉터를 DOM 에서 확인한다.
  const js = `
await (async () => {
  page = await openTab(${JSON.stringify(url)});
  await page.waitForLoadState('load');
  const frameSelector = ${JSON.stringify(`iframe[name="${EDITOR_FRAME_NAME}"]`)};
  let hasEditorFrame = false;
  for (let attempt = 0; attempt < 30 && !hasEditorFrame; attempt++) {
    hasEditorFrame = await page.evaluate((sel) => document.querySelector(sel) !== null, frameSelector);
    if (!hasEditorFrame) await sleep(500);
  }
  const result = await snapshot(page, { interactive: true });
  console.log(JSON.stringify({ tree: result.tree, url: page.url(), hasEditorFrame }));
})();
`;
  const stdout = await runEvaluate(ctx, stepName, js, TIMEOUT_NAVIGATE_MS);
  const parsed = parseJsonStdout<{ tree?: unknown; url?: unknown; hasEditorFrame?: unknown }>(stepName, stdout);
  if (typeof parsed.tree !== 'string') {
    throw new EvaluationFailedError(stepName, '진입 후 snapshot 응답에 tree 필드가 없음');
  }
  if (parsed.hasEditorFrame !== true) {
    throw new ElementNotFoundError(
      stepName,
      `에디터 iframe(name="${EDITOR_FRAME_NAME}") — 로그인 페이지 등 다른 페이지로 튕겼을 가능성`,
      excerptAround(parsed.tree, 'iframe'),
    );
  }
  const confirmedUrl = typeof parsed.url === 'string' ? parsed.url : url;
  ctx.onProgress?.(`[${stepName}] 에디터 진입 확인됨 (url=${confirmedUrl})`);
  return confirmedUrl;
}

/**
 * danger_zone: `openEditor` 가 이 인스턴스에서 연 탭만 닫는다 — 사용자가 열어둔 다른 탭은
 * 건드리지 않는다.
 */
export async function closeCurrentTab(ctx: StepCtx): Promise<void> {
  const stepName = 'closeCurrentTab';
  const js = `
await (async () => {
  if (typeof page !== 'undefined' && page) {
    await closeTab(page);
  }
  console.log(JSON.stringify({ closed: true }));
})();
`;
  await runEvaluate(ctx, stepName, js, TIMEOUT_NAVIGATE_MS);
}

/** D10: 진입 팝업 정리는 선택적이다 — 없어도 실패하지 않는다. */
export async function dismissEntryPopups(ctx: StepCtx): Promise<void> {
  const targets = [
    { label: '작성중인 글 복구 팝업', selector: POPUP_DRAFT_RESTORE_CANCEL },
    { label: '도움말 패널', selector: POPUP_HELP_PANEL_CLOSE },
  ];

  for (const target of targets) {
    const js = `
await (async () => {
  const locator = ${frameLocator('__SELECTOR__')};
  const count = await locator.count();
  if (count > 0) {
    await locator.first().click();
  }
  console.log(JSON.stringify({ dismissed: count > 0 }));
})();
`.replace('"__SELECTOR__"', JSON.stringify(target.selector));

    const result = await ctx.repl.evaluate(js, { timeoutMs: TIMEOUT_TYPE_MS });
    if (!result.ok) {
      ctx.onProgress?.(`[dismissEntryPopups] ${target.label} 확인 실패(치명적이지 않음): ${result.error ?? 'unknown'}`);
      continue;
    }
    const parsed = parseLastJson<{ dismissed?: boolean }>(result.stdout);
    ctx.onProgress?.(
      `[dismissEntryPopups] ${target.label}: ${parsed?.dismissed ? '정리했다' : '없었음'}`,
    );
  }
}

export async function fillTitle(ctx: StepCtx, title: string): Promise<void> {
  const stepName = 'fillTitle';
  await requireVisible(ctx, stepName, '제목 입력 영역', TITLE_PLACEHOLDER, TIMEOUT_TYPE_MS, 'iframe');

  // 제목 영역은 <input> 이 아니라 contenteditable 이라 클릭 후 키보드로 친다.
  const js = `
await (async () => {
  await ${frameLocator(TITLE_PLACEHOLDER)}.first().click();
  await page.keyboard.type(${JSON.stringify(title)}, { delay: ${TYPE_DELAY_MS} });
  await sleep(${SETTLE_MS});
  console.log(JSON.stringify({ typed: true }));
})();
`;
  await runEvaluate(ctx, stepName, js, TIMEOUT_TYPE_MS);
  ctx.onProgress?.(`[${stepName}] 제목 입력 완료`);
}

/**
 * 본문과 이미지를 순서대로 채운다.
 *
 * 실측: 사진 추가 버튼은 DOM 의 file input 이 아니라 네이티브 파일 선택창을 연다. 그리고
 * Aside 는 **세션 디렉터리 밖의 경로를 거부한다**("escapes the session directory") — 그래서
 * 업로드 전에 이미지를 세션 디렉터리로 복사해 둔다.
 */
export async function fillBodyAndImages(ctx: StepCtx, draft: PostDraft, input: PostInput): Promise<void> {
  const stepName = 'fillBodyAndImages';

  if (input.images.length < 1) {
    throw new Error(`[${stepName}] 이미지가 0장입니다 — 최소 1장이 필요합니다.`);
  }
  if (draft.blocks.length !== input.images.length) {
    throw new Error(
      `[${stepName}] blocks 개수(${draft.blocks.length})가 이미지 수(${input.images.length})와 다릅니다.`,
    );
  }
  for (let i = 0; i < input.images.length; i++) {
    if (draft.blocks[i].imageId !== input.images[i].id) {
      throw new Error(
        `[${stepName}] blocks[${i}].imageId(${draft.blocks[i].imageId})가 images[${i}].id(${input.images[i].id})와 다릅니다.`,
      );
    }
  }
  if (draft.thumbnailImageId !== input.images[0].id) {
    throw new Error(
      `[${stepName}] thumbnailImageId(${draft.thumbnailImageId})가 첫 번째 이미지 id(${input.images[0].id})와 다릅니다.`,
    );
  }

  await requireVisible(ctx, stepName, '본문 입력 영역', BODY_MODULE, TIMEOUT_TYPE_MS, 'iframe');

  const stagedPaths = await stageImagesInSession(ctx, stepName, input.images.map((image) => image.path));

  await focusBody(ctx, stepName);

  // 인트로 → (이미지 + 캡션) × N → 아웃트로 → 장소
  await typeIntoBody(ctx, stepName, draft.intro);

  for (let i = 0; i < stagedPaths.length; i++) {
    await insertImage(ctx, stepName, stagedPaths[i], i + 1);
    // 소제목은 사진 바로 아래에 굵고 큰 글씨로 한 줄, 그 다음 줄부터 본문이다.
    if (draft.blocks[i].heading !== '') {
      await typeIntoBody(ctx, stepName, draft.blocks[i].heading, { heading: true });
      await typeIntoBody(ctx, stepName, draft.blocks[i].caption, { newParagraph: true });
    } else {
      await typeIntoBody(ctx, stepName, draft.blocks[i].caption);
    }
  }

  await typeIntoBody(ctx, stepName, draft.outro, { newParagraph: true });

  ctx.onProgress?.(`[${stepName}] 본문·이미지 ${input.images.length}장 조립 완료`);
}

/**
 * Aside 세션 디렉터리 경로. Aside 는 이 디렉터리 밖의 파일을 읽지도 쓰지도 못한다
 * ("escapes the session directory") — 업로드할 파일과 스크린샷 목적지가 모두 여기 있어야 한다.
 */
async function readSessionDir(ctx: StepCtx, stepName: string): Promise<string> {
  const stdout = await runEvaluate(
    ctx,
    stepName,
    `await (async () => { console.log(JSON.stringify({ dir: pwd })); })();`,
    TIMEOUT_TYPE_MS,
  );
  const { dir } = parseJsonStdout<{ dir?: unknown }>(stepName, stdout);
  if (typeof dir !== 'string' || dir === '') {
    throw new EvaluationFailedError(stepName, 'aside 세션 디렉터리(pwd)를 읽지 못함');
  }
  return dir;
}

/** Aside 세션 디렉터리로 이미지를 복사하고, 그 안의 경로들을 돌려준다. */
async function stageImagesInSession(ctx: StepCtx, stepName: string, imagePaths: string[]): Promise<string[]> {
  const dir = await readSessionDir(ctx, stepName);
  const stagingDir = path.join(dir, 'anb-uploads');
  await mkdir(stagingDir, { recursive: true });

  const staged: string[] = [];
  for (let i = 0; i < imagePaths.length; i++) {
    const dest = path.join(stagingDir, `${i}${path.extname(imagePaths[i])}`);
    await copyFile(imagePaths[i], dest);
    staged.push(dest);
  }
  ctx.onProgress?.(`[${stepName}] 이미지 ${staged.length}장을 aside 세션 디렉터리로 준비함`);
  return staged;
}

// 실측: 조각마다 본문을 다시 클릭해 캐럿을 잡으려 하면 글이 뒤엉킨다. 클릭 지점이 문단
// 중간(줄바꿈된 시각적 위치)에 떨어져서, 그 자리에 이미지가 끼어들고 나머지 글이 뒤로
// 밀렸다 — 인트로가 "…점검하려 [이미지] 고 올린…" 처럼 쪼개졌다.
// 그래서 본문 진입 때 **딱 한 번만** 클릭해 캐럿을 잡고, 이후에는 캐럿을 건드리지 않는다.
// 타이핑도 사진 삽입도 항상 현재 캐럿(=마지막으로 쓴 자리) 뒤에서 이어진다.

// 실측: page.keyboard.type() 은 스마트에디터가 입력을 다 처리하기 전에 반환한다. 그래서
// 곧바로 다음 동작(사진 삽입·다음 문단 입력)을 시키면 글자가 뒤엉킨다 — 실제로 인트로가
// "…파이프라인" 에서 잘리고 그 자리에 이미지가 끼어든 뒤 나머지가 뒤에 붙었다.
// 그래서 (1) 줄 단위로 끊어 Enter 를 명시적으로 누르고, (2) 타이핑에 딜레이를 주고,
// (3) 각 조각 뒤에 편집기가 반영할 시간을 준다.
const TYPE_DELAY_MS = 12;
const SETTLE_MS = 400;

/** 본문에 캐럿을 한 번만 잡는다. 이후 모든 입력은 이 캐럿 뒤로 이어진다. */
async function focusBody(ctx: StepCtx, stepName: string): Promise<void> {
  const js = `
await (async () => {
  await ${frameLocator(BODY_MODULE)}.last().click();
  await sleep(300);
  console.log(JSON.stringify({ focused: true }));
})();
`;
  await runEvaluate(ctx, stepName, js, TIMEOUT_TYPE_MS);
}

// 글자 크기를 바꾼다. 드롭다운을 열고 숫자가 적힌 옵션을 고르는 방식이다.
function setFontSizeJs(size: string): string {
  return `
  await ${frameLocator(FONT_SIZE_BUTTON)}.first().click();
  await sleep(300);
  {
    const options = ${frameLocator(FONT_SIZE_OPTION)};
    const total = await options.count();
    for (let i = 0; i < total; i++) {
      const label = ((await options.nth(i).textContent()) || '').trim();
      if (label.startsWith(${JSON.stringify(size)})) {
        await options.nth(i).click();
        break;
      }
    }
  }
  await sleep(300);
`;
}

const TOGGLE_BOLD_JS = `
  await ${frameLocator(BOLD_BUTTON)}.first().click();
  await sleep(200);
`;

async function typeIntoBody(
  ctx: StepCtx,
  stepName: string,
  text: string,
  opts: { newParagraph?: boolean; heading?: boolean } = {},
): Promise<void> {
  if (text === '') return;
  const heading = opts.heading === true;
  const js = `
await (async () => {
  if (${opts.newParagraph === true}) {
    await page.keyboard.press('Enter');
    await sleep(150);
  }
${heading ? setFontSizeJs(FONT_SIZE_HEADING) + TOGGLE_BOLD_JS : ''}
  const lines = ${JSON.stringify(text.split(String.fromCharCode(10)))};
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) {
      await page.keyboard.press('Enter');
      await sleep(150);
    }
    if (lines[i] !== '') {
      await page.keyboard.type(lines[i], { delay: ${TYPE_DELAY_MS} });
      await sleep(150);
    }
  }
${heading ? TOGGLE_BOLD_JS + setFontSizeJs(FONT_SIZE_BODY) : ''}
  await sleep(${SETTLE_MS});
  console.log(JSON.stringify({ typed: true }));
})();
`;
  await runEvaluate(ctx, stepName, js, TIMEOUT_TYPE_MS);
}

async function insertImage(ctx: StepCtx, stepName: string, stagedPath: string, expectedCount: number): Promise<void> {
  const js = `
await (async () => {
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 20000 }),
    ${frameLocator(IMAGE_TOOLBAR_BUTTON)}.first().click(),
  ]);
  await chooser.setFiles(${JSON.stringify(stagedPath)});
  const images = ${frameLocator(UPLOADED_IMAGE)};
  let count = 0;
  for (let attempt = 0; attempt < 120 && count < ${expectedCount}; attempt++) {
    count = await images.count();
    if (count < ${expectedCount}) await sleep(1000);
  }
  await sleep(${SETTLE_MS});
  console.log(JSON.stringify({ count }));
})();
`;
  const stdout = await runEvaluate(ctx, stepName, js, TIMEOUT_UPLOAD_MS);
  const { count } = parseJsonStdout<{ count?: number }>(stepName, stdout);
  if (typeof count !== 'number' || count < expectedCount) {
    throw new EvaluationFailedError(
      stepName,
      `이미지 업로드가 확인되지 않음 (기대 ${expectedCount}장, 실제 ${String(count)}장)`,
    );
  }
  ctx.onProgress?.(`[${stepName}] 이미지 ${expectedCount}장째 업로드 확인`);
}

/**
 * 글 끝에 장소(위치)를 붙인다. 툴바의 '장소' 로 검색해 **가장 위 결과 1건**을 고른다.
 *
 * 실측으로 확인한 것들:
 * - 검색어 입력칸은 react-autosuggest 라서 키보드 타이핑으로는 한글이 첫 글자만 들어간다
 *   ("판교역" → "판"). `fill()` 로 값을 한 번에 넣어야 한다.
 * - Enter 로는 검색이 걸리지 않는다 — 전용 검색 버튼을 눌러야 한다.
 * - 결과의 '추가' 버튼은 hover 전에는 클릭 가능 판정을 통과하지 못해 DOM 클릭으로 누른다.
 * - '추가' 뒤 팝업의 '확인' 까지 눌러야 본문에 se-placesMap 컴포넌트가 들어간다.
 *
 * 검색 결과가 없으면 팝업만 닫고 장소 없이 진행한다 — 실패로 보지 않는다.
 */
export async function attachPlace(ctx: StepCtx, place: string): Promise<void> {
  const stepName = 'attachPlace';
  const query = place.trim();
  if (query === '') {
    ctx.onProgress?.(`[${stepName}] 장소 입력 없음 — 건너뜀`);
    return;
  }

  const js = `
await (async () => {
  await ${frameLocator(PLACE_TOOLBAR_BUTTON)}.first().click();

  const popup = ${frameLocator(PLACE_POPUP)};
  let popupOpen = false;
  for (let attempt = 0; attempt < 30 && !popupOpen; attempt++) {
    popupOpen = (await popup.count()) > 0;
    if (!popupOpen) await sleep(500);
  }
  if (!popupOpen) {
    console.log(JSON.stringify({ popupOpen: false, resultCount: 0, attached: false }));
    return;
  }

  await ${frameLocator(PLACE_SEARCH_INPUT)}.first().fill(${JSON.stringify(query)});
  await ${frameLocator(PLACE_SEARCH_BUTTON)}.first().click();

  const items = ${frameLocator(PLACE_RESULT_ITEM)};
  let resultCount = 0;
  for (let attempt = 0; attempt < 30 && resultCount === 0; attempt++) {
    await sleep(500);
    resultCount = await items.count();
  }

  if (resultCount === 0) {
    await ${frameLocator(`${PLACE_POPUP} ${PLACE_CLOSE_BUTTON}`)}.first().evaluate((el) => el.click());
    await sleep(1000);
    console.log(JSON.stringify({ popupOpen: true, resultCount: 0, attached: false }));
    return;
  }

  const readText = async (selector) => {
    const locator = items.first().locator(selector);
    return (await locator.count()) > 0 ? ((await locator.first().textContent()) || '').trim() : '';
  };
  const firstName = await readText(${JSON.stringify(PLACE_RESULT_TITLE)});
  const firstAddress = await readText(${JSON.stringify(PLACE_RESULT_ADDRESS)});
  await items.first().locator(${JSON.stringify(PLACE_ADD_BUTTON)}).evaluate((el) => el.click());
  await sleep(1500);
  await ${frameLocator(`${PLACE_POPUP} ${PLACE_CONFIRM_BUTTON}`)}.first().evaluate((el) => el.click());

  const inserted = ${frameLocator(PLACE_COMPONENT)};
  let attached = false;
  for (let attempt = 0; attempt < 30 && !attached; attempt++) {
    await sleep(500);
    attached = (await inserted.count()) > 0;
  }
  console.log(JSON.stringify({ popupOpen: true, resultCount, attached, firstName, firstAddress }));
})();
`;

  const stdout = await runEvaluate(ctx, stepName, js, TIMEOUT_UPLOAD_MS);
  const parsed = parseJsonStdout<{
    popupOpen?: boolean;
    resultCount?: number;
    attached?: boolean;
    firstName?: string;
    firstAddress?: string;
  }>(stepName, stdout);

  if (parsed.popupOpen !== true) {
    throw new ElementNotFoundError(stepName, `장소 검색 팝업(${PLACE_POPUP})`, '(팝업이 열리지 않음)');
  }
  if (parsed.resultCount === 0) {
    ctx.onProgress?.(`[${stepName}] "${query}" 검색 결과 없음 — 장소 없이 진행합니다`);
    return;
  }
  if (parsed.attached !== true) {
    throw new EvaluationFailedError(stepName, `장소를 고른 뒤에도 본문에 장소 블록이 들어가지 않았습니다 (검색어="${query}")`);
  }
  const chosen = parsed.firstName !== undefined && parsed.firstName !== '' ? parsed.firstName : query;
  const address = parsed.firstAddress !== undefined && parsed.firstAddress !== '' ? ` (${parsed.firstAddress})` : '';
  ctx.onProgress?.(
    `[${stepName}] 장소 추가: ${chosen}${address} — "${query}" 검색 결과 ${parsed.resultCount}건 중 1번째`,
  );
}

/**
 * 실측: 대표(썸네일) 이미지는 스마트에디터 ONE 이 **본문 첫 번째 이미지를 기본값으로**
 * 삼는다. 이 프로젝트의 계약(첫 장이 대표)과 같으므로 별도 조작이 필요 없다 — 대신
 * 초안과 입력이 그 계약을 지키는지만 확인한다. 브라우저를 건드리지 않는다.
 */
export async function setThumbnail(ctx: StepCtx, draft: PostDraft, input: PostInput): Promise<void> {
  const stepName = 'setThumbnail';
  if (input.images.length < 1) {
    throw new Error(`[${stepName}] 이미지가 0장입니다 — 최소 1장이 필요합니다.`);
  }
  if (draft.thumbnailImageId !== input.images[0].id) {
    throw new Error(
      `[${stepName}] thumbnailImageId(${draft.thumbnailImageId})가 첫 번째 이미지 id(${input.images[0].id})와 다릅니다.`,
    );
  }
  ctx.onProgress?.(`[${stepName}] 첫 번째 이미지가 대표로 쓰인다(에디터 기본 동작)`);
}

/** 툴바의 '발행' 을 눌러 발행 설정 패널을 연다. 아직 발행되지 않는다. */
export async function openPublishPanel(ctx: StepCtx): Promise<void> {
  const stepName = 'openPublishPanel';
  await requireVisible(ctx, stepName, '툴바 발행 버튼', PUBLISH_PANEL_OPEN_BUTTON, TIMEOUT_TYPE_MS, '발행');

  const js = `
await (async () => {
  await ${frameLocator(PUBLISH_PANEL_OPEN_BUTTON)}.first().click();
  const dropdown = ${frameLocator(CATEGORY_DROPDOWN_BUTTON)};
  let count = 0;
  for (let attempt = 0; attempt < 30 && count === 0; attempt++) {
    count = await dropdown.count();
    if (count === 0) await sleep(500);
  }
  console.log(JSON.stringify({ panelOpen: count > 0 }));
})();
`;
  const stdout = await runEvaluate(ctx, stepName, js, TIMEOUT_TYPE_MS);
  const { panelOpen } = parseJsonStdout<{ panelOpen?: boolean }>(stepName, stdout);
  if (panelOpen !== true) {
    const tree = await fetchTree(ctx, stepName, TIMEOUT_TYPE_MS).catch(() => '(스냅샷도 실패)');
    throw new ElementNotFoundError(stepName, '발행 설정 패널(카테고리 드롭다운이 나타나지 않음)', excerptAround(tree, '발행'));
  }
  ctx.onProgress?.(`[${stepName}] 발행 설정 패널 열림`);
}

/**
 * 발행 설정 패널을 닫는다 — 카테고리·태그는 그대로 유지된다(실측: 닫았다 다시 열어도
 * "테슬라", "#유지테스트" 가 남아 있었다). 패널을 닫아야 사람이 본문을 직접 고칠 수 있다.
 *
 * 주의: 패널 안의 '발행 설정 닫기' 버튼은 그 아래 체크박스 묶음만 접는 버튼이라 패널 전체를
 * 닫지 못한다(실측). Escape 를 눌러야 패널이 사라진다.
 */
export async function closePublishPanel(ctx: StepCtx): Promise<void> {
  const stepName = 'closePublishPanel';
  const js = `
await (async () => {
  await page.keyboard.press('Escape');
  const dropdown = ${frameLocator(CATEGORY_DROPDOWN_BUTTON)};
  let stillOpen = true;
  for (let attempt = 0; attempt < 20 && stillOpen; attempt++) {
    await sleep(500);
    stillOpen = (await dropdown.count()) > 0;
  }
  console.log(JSON.stringify({ panelClosed: !stillOpen }));
})();
`;
  const stdout = await runEvaluate(ctx, stepName, js, TIMEOUT_TYPE_MS);
  const { panelClosed } = parseJsonStdout<{ panelClosed?: boolean }>(stepName, stdout);
  if (panelClosed !== true) {
    throw new EvaluationFailedError(stepName, '발행 설정 패널이 닫히지 않았습니다 — 본문을 수정할 수 없습니다.');
  }
  ctx.onProgress?.(`[${stepName}] 발행 설정 패널을 닫았습니다 — 이제 브라우저에서 직접 고칠 수 있습니다`);
}

/**
 * 카테고리를 이름으로 고른다. 앞뒤 공백을 제거한 정확 일치만 허용한다 — 부분/유사 일치는
 * 하지 않고, 없으면 사용 가능한 이름 목록을 담아 실패한다. 기본 카테고리로 조용히 넘어가지
 * 않는다. (발행 설정 패널이 열려 있어야 한다.)
 */
export async function selectCategory(ctx: StepCtx, categoryName: string): Promise<void> {
  const stepName = 'selectCategory';
  const target = categoryName.trim();

  const js = `
await (async () => {
  await ${frameLocator(CATEGORY_DROPDOWN_BUTTON)}.first().click();
  const options = ${frameLocator(CATEGORY_OPTION_LABEL)};
  let count = 0;
  for (let attempt = 0; attempt < 20 && count === 0; attempt++) {
    count = await options.count();
    if (count === 0) await sleep(500);
  }
  const names = [];
  for (let i = 0; i < count; i++) {
    names.push(((await options.nth(i).textContent()) || '').trim());
  }
  const target = ${JSON.stringify(target)};
  const index = names.indexOf(target);
  if (index >= 0) {
    await options.nth(index).click();
  }
  console.log(JSON.stringify({ names, index }));
})();
`;
  const stdout = await runEvaluate(ctx, stepName, js, TIMEOUT_TYPE_MS);
  const { names, index } = parseJsonStdout<{ names?: string[]; index?: number }>(stepName, stdout);
  const available = Array.isArray(names) ? names : [];
  if (typeof index !== 'number' || index < 0) {
    throw new CategoryNotFoundError(categoryName, available);
  }
  ctx.onProgress?.(`[${stepName}] 카테고리 "${target}" 선택함`);
}

/** 태그를 입력한다. 각 태그는 Enter 로 확정한다. (발행 설정 패널이 열려 있어야 한다.) */
export async function setTags(ctx: StepCtx, tags: string[]): Promise<void> {
  const stepName = 'setTags';
  if (tags.length === 0) {
    ctx.onProgress?.(`[${stepName}] 태그 없음 — 건너뜀`);
    return;
  }
  await requireVisible(ctx, stepName, '태그 입력칸', TAG_INPUT, TIMEOUT_TYPE_MS, '태그');

  const js = `
await (async () => {
  const input = ${frameLocator(TAG_INPUT)}.first();
  const tags = ${JSON.stringify(tags)};
  for (const tag of tags) {
    await input.click();
    await page.keyboard.type(tag);
    await page.keyboard.press('Enter');
    await sleep(300);
  }
  console.log(JSON.stringify({ entered: tags.length }));
})();
`;
  await runEvaluate(ctx, stepName, js, TIMEOUT_TYPE_MS);
  ctx.onProgress?.(`[${stepName}] 태그 ${tags.length}개 입력 완료`);
}

/**
 * 채워진 화면을 스크린샷으로 남긴다 — 사람이 승인할 근거다.
 *
 * 실측: Aside 는 세션 디렉터리 밖의 경로에 쓰는 것을 거부한다(업로드와 같은 제약).
 * 그래서 세션 디렉터리에 찍은 뒤 Node 쪽에서 목적지로 옮긴다.
 */
export async function capturePreview(ctx: StepCtx, screenshotPath: string): Promise<void> {
  const stepName = 'capturePreview';
  await mkdir(path.dirname(screenshotPath), { recursive: true });

  const sessionDir = await readSessionDir(ctx, stepName);
  const stagedPath = path.join(sessionDir, 'anb-preview.png');

  const js = `
await (async () => {
  await page.screenshot({ path: ${JSON.stringify(stagedPath)}, fullPage: true });
  console.log(JSON.stringify({ captured: true }));
})();
`;
  await runEvaluate(ctx, stepName, js, TIMEOUT_TYPE_MS);
  await copyFile(stagedPath, screenshotPath);
  ctx.onProgress?.(`[${stepName}] 미리보기 스크린샷 저장: ${screenshotPath}`);
}

/**
 * 안전 테스트가 "발행 클릭이 몇 번 일어났는가" 를 셀 수 있도록, 발행 클릭 JS 에만 넣는 표식.
 * 줄바꿈이 공백으로 접히므로 `//` 주석이 아니라 블록 주석으로 넣는다.
 */
export const PUBLISH_CLICK_MARKER = 'ANB_PUBLISH_CLICK';

/**
 * danger_zone: 실제 발행. 발행 설정 패널 안의 '발행' 버튼을 누른다.
 * 이 함수는 오직 publisher.publish() 에서만 호출된다.
 */
export async function submitPublish(ctx: StepCtx): Promise<{ resultUrl: string | null }> {
  const stepName = 'submitPublish';
  // 실측: 발행 후 이동은 최상위 페이지가 아니라 mainFrame 안에서 일어난다. 최상위 URL 만
  // 보면 계속 `?Redirect=Write` 라서 발행에 성공해도 결과 URL 을 못 읽는다 —
  // 프레임 URL 도 함께 본다. 발행된 글은 `logNo=` 를 갖거나 `/<blogId>/<글번호>` 꼴이다.
  const js = `
await (async () => {
  /* ${PUBLISH_CLICK_MARKER} */
  await ${frameLocator(PUBLISH_CONFIRM_BUTTON)}.first().click();
  const looksPublished = (u) => typeof u === 'string'
    && u.includes('blog.naver.com')
    && !u.includes('Redirect=Write')
    && (u.includes('logNo=') || /blog\\.naver\\.com\\/[^/?#]+\\/[0-9]+/.test(u));
  let url = null;
  for (let attempt = 0; attempt < 60 && url === null; attempt++) {
    await sleep(1000);
    const candidates = [page.url()];
    for (const frame of page.frames()) {
      candidates.push(frame.url());
    }
    url = candidates.find(looksPublished) || null;
  }
  console.log(JSON.stringify({ resultUrl: url, seen: [page.url()].concat(page.frames().map((f) => f.url())) }));
})();
`;
  const stdout = await runEvaluate(ctx, stepName, js, TIMEOUT_PUBLISH_MS);
  const { resultUrl } = parseJsonStdout<{ resultUrl?: unknown }>(stepName, stdout);
  return { resultUrl: typeof resultUrl === 'string' ? resultUrl : null };
}
