// D4/D5: 각 단계는 (1) 성공, (2) 대상을 못 찾음(ElementNotFoundError), (3) 검사 자체를
// 수행 못 함(EvaluationFailedError) 을 서로 다른 에러로 낸다. 요소 찾기는 snapshot 의
// role+접근성 이름을 먼저 시도하고, 실패하면 selectors.ts 의 [추정] CSS 로 폴백한다.
// D7: REPL 로 보내는 JS 안의 사용자 값은 전부 JSON.stringify 로 직렬화해 주입한다 —
// 문자열 연결 금지.

import type { AsideReplApi, PostDraft, PostInput, ProgressFn } from '../types';
import { CategoryNotFoundError, ElementNotFoundError, EvaluationFailedError } from './errors';
import {
  A11Y_BODY_NAMES,
  A11Y_CATEGORY_CONTROL_NAMES,
  A11Y_IMAGE_BUTTON_NAMES,
  A11Y_PUBLISH_BUTTON_NAMES,
  A11Y_TAG_INPUT_NAMES,
  A11Y_THUMBNAIL_BUTTON_NAMES,
  A11Y_TITLE_NAMES,
  BODY_MODULE,
  EDITOR_FRAME_NAME,
  IMAGE_FILE_INPUT,
  POPUP_DRAFT_RESTORE_CANCEL,
  POPUP_HELP_PANEL_CLOSE,
  TIMEOUT_NAVIGATE_MS,
  TIMEOUT_PUBLISH_MS,
  TIMEOUT_TYPE_MS,
  TIMEOUT_UPLOAD_MS,
  TITLE_PLACEHOLDER,
  writeUrl,
} from './selectors';
import { excerptAround, findEntriesByRole, findRefByRoleAndName } from './snapshot-query';
import { parseLastJson } from '../aside/protocol';

export interface StepCtx {
  repl: AsideReplApi;
  onProgress?: ProgressFn;
}

// ---------------------------------------------------------------------------
// 저수준 evaluate 헬퍼
// ---------------------------------------------------------------------------

async function runEvaluate(ctx: StepCtx, stepName: string, js: string, timeoutMs: number): Promise<string> {
  const result = await ctx.repl.evaluate(js, { timeoutMs });
  if (!result.ok) {
    // D4-(3): evaluate 자체가 실패(ok:false) — 채널 poisoned·탭 없음·REPL 오류를 모두
    // 포함한다. 이유(result.error)를 그대로 보존해, 라이브에서 무엇이 원인인지 드러낸다.
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

// ---------------------------------------------------------------------------
// 요소 조회 (D5: snapshot role+name 우선, CSS 는 폴백)
// ---------------------------------------------------------------------------

interface LocatorRef {
  expr: string;
}

function refLocator(ref: string): LocatorRef {
  return { expr: `page.locator(${JSON.stringify(ref)})` };
}

function cssLocator(cssSelector: string, insideEditorFrame: boolean): LocatorRef {
  if (!insideEditorFrame) {
    return { expr: `page.locator(${JSON.stringify(cssSelector)})` };
  }
  const frameSelector = `iframe[name="${EDITOR_FRAME_NAME}"]`;
  return { expr: `page.frameLocator(${JSON.stringify(frameSelector)}).locator(${JSON.stringify(cssSelector)})` };
}

interface ResolveOptions {
  role: string;
  names: string[];
  cssSelector: string | null;
  insideEditorFrame: boolean;
}

async function resolveLocator(
  ctx: StepCtx,
  stepName: string,
  targetDescription: string,
  tree: string,
  opts: ResolveOptions,
  timeoutMs: number,
): Promise<LocatorRef> {
  const ref = findRefByRoleAndName(tree, opts.role, opts.names);
  if (ref) return refLocator(ref);

  if (opts.cssSelector) {
    const candidate = cssLocator(opts.cssSelector, opts.insideEditorFrame);
    const checkJs = `
await (async () => {
  const count = await (${candidate.expr}).count();
  console.log(JSON.stringify({ count }));
})();
`;
    const stdout = await runEvaluate(ctx, stepName, checkJs, timeoutMs);
    const parsed = parseJsonStdout<{ count?: unknown }>(stepName, stdout);
    if (typeof parsed.count === 'number' && parsed.count > 0) {
      return candidate;
    }
  }

  // D4-(2): evaluate 는 성공했지만(브라우저는 살아있다) role+name 도 CSS 폴백도 대상을
  // 찾지 못했다 — selectors.ts 의 [추정] 값이 틀렸을 가능성이 높다.
  throw new ElementNotFoundError(stepName, targetDescription, excerptAround(tree, opts.role));
}

async function clickLocator(ctx: StepCtx, stepName: string, locator: LocatorRef, timeoutMs: number): Promise<void> {
  const js = `
await (async () => {
  await (${locator.expr}).click();
  console.log(JSON.stringify({ clicked: true }));
})();
`;
  await runEvaluate(ctx, stepName, js, timeoutMs);
}

async function typeIntoLocator(
  ctx: StepCtx,
  stepName: string,
  locator: LocatorRef,
  value: string,
  timeoutMs: number,
): Promise<void> {
  // D7: value 는 JSON.stringify 로 직렬화해 리터럴로 주입한다 — 문자열 연결 금지.
  // 브리프: 제목/본문은 <input> 이 아니라 contenteditable 이다 — 클릭 후 키보드 입력.
  const js = `
await (async () => {
  const target = (${locator.expr});
  await target.click();
  await target.pressSequentially(${JSON.stringify(value)});
  console.log(JSON.stringify({ typed: true }));
})();
`;
  await runEvaluate(ctx, stepName, js, timeoutMs);
}

// ---------------------------------------------------------------------------
// 단계
// ---------------------------------------------------------------------------

/**
 * 탭을 열고 글쓰기 URL로 진입한 뒤, 에디터 iframe이 실제로 로드됐는지 확인한다.
 * 확인에 쓴 URL(가능하면 페이지가 보고한 실제 URL)을 돌려준다.
 */
export async function openEditor(ctx: StepCtx, blogId: string): Promise<string> {
  const stepName = 'openEditor';
  const url = writeUrl(blogId);
  const js = `
await (async () => {
  page = await openTab(${JSON.stringify(url)});
  await page.waitForLoadState('load');
  const result = await snapshot(page, { interactive: true });
  console.log(JSON.stringify({ tree: result.tree, url: page.url() }));
})();
`;
  const stdout = await runEvaluate(ctx, stepName, js, TIMEOUT_NAVIGATE_MS);
  const parsed = parseJsonStdout<{ tree?: unknown; url?: unknown }>(stepName, stdout);
  if (typeof parsed.tree !== 'string') {
    throw new EvaluationFailedError(stepName, '진입 후 snapshot 응답에 tree 필드가 없음');
  }

  const iframeRef = findRefByRoleAndName(parsed.tree, 'iframe', [EDITOR_FRAME_NAME]);
  if (!iframeRef) {
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
 * danger_zone: 이 함수는 `openEditor` 가 이 인스턴스에서 연 탭만 닫는다 — 사용자가 열어둔
 * 다른 탭은 건드리지 않는다. 호출 여부(탭을 열었는지)는 호출자(publisher.ts)가 판단한다.
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

/**
 * D10: 진입 시 팝업 2종(작성중인 글 복구, 도움말 패널)을 정리한다 — 선택적 정리다.
 * 없어도 실패하지 않는다. "정리했다"와 "없었음"을 진행 로그로 구분한다.
 */
export async function dismissEntryPopups(ctx: StepCtx): Promise<void> {
  const targets = [
    { label: '작성중인 글 복구 팝업', selector: POPUP_DRAFT_RESTORE_CANCEL },
    { label: '도움말 패널', selector: POPUP_HELP_PANEL_CLOSE },
  ];

  for (const target of targets) {
    const js = `
await (async () => {
  const locator = page.locator(${JSON.stringify(target.selector)});
  const count = await locator.count();
  if (count > 0) {
    await locator.first().click();
  }
  console.log(JSON.stringify({ dismissed: count > 0 }));
})();
`;
    const result = await ctx.repl.evaluate(js, { timeoutMs: TIMEOUT_TYPE_MS });
    if (!result.ok) {
      // D10: 선택적 정리 — evaluate 실패도 이 단계 전체를 실패시키지 않는다.
      ctx.onProgress?.(`[dismissEntryPopups] ${target.label} 확인 실패(치명적이지 않음): ${result.error ?? 'unknown'}`);
      continue;
    }
    try {
      const parsed = JSON.parse(result.stdout) as { dismissed?: boolean };
      ctx.onProgress?.(`[dismissEntryPopups] ${target.label}: ${parsed.dismissed ? '정리했다' : '없었음'}`);
    } catch {
      ctx.onProgress?.(`[dismissEntryPopups] ${target.label}: 응답 파싱 실패(치명적이지 않음)`);
    }
  }
}

/**
 * D14: 카테고리를 이름으로 고른다. 앞뒤 공백을 제거한 정확 일치만 허용한다 — 부분/유사
 * 일치는 하지 않는다. 일치하는 카테고리가 없으면 사용 가능한 이름 목록을 담아 실패한다.
 * 기본 카테고리로 조용히 넘어가지 않는다.
 */
export async function selectCategory(ctx: StepCtx, categoryName: string): Promise<void> {
  const stepName = 'selectCategory';
  const trimmedTarget = categoryName.trim();

  const openTree = await fetchTree(ctx, stepName, TIMEOUT_TYPE_MS);
  // D14: 카테고리 UI 에 대한 CSS 가설은 브리프에 없다(URL 방식만 있었고 D14 로 폐기됨) —
  // CSS 폴백 없이 role+name 만 시도하고, 못 찾으면 바로 실패한다.
  const controlLocator = await resolveLocator(
    ctx,
    stepName,
    '카테고리 선택 컨트롤',
    openTree,
    { role: 'button', names: A11Y_CATEGORY_CONTROL_NAMES, cssSelector: null, insideEditorFrame: true },
    TIMEOUT_TYPE_MS,
  );
  await clickLocator(ctx, stepName, controlLocator, TIMEOUT_TYPE_MS);

  const listTree = await fetchTree(ctx, stepName, TIMEOUT_TYPE_MS);
  const options = findEntriesByRole(listTree, 'listitem');
  const match = options.find((option) => option.name.trim() === trimmedTarget);
  if (!match) {
    throw new CategoryNotFoundError(
      categoryName,
      options.map((option) => option.name.trim()),
    );
  }

  await clickLocator(ctx, stepName, refLocator(match.ref), TIMEOUT_TYPE_MS);
  ctx.onProgress?.(`[${stepName}] 카테고리 "${trimmedTarget}" 선택함`);
}

export async function fillTitle(ctx: StepCtx, title: string): Promise<void> {
  const stepName = 'fillTitle';
  const tree = await fetchTree(ctx, stepName, TIMEOUT_TYPE_MS);
  const locator = await resolveLocator(
    ctx,
    stepName,
    '제목 입력 영역',
    tree,
    { role: 'textbox', names: A11Y_TITLE_NAMES, cssSelector: TITLE_PLACEHOLDER, insideEditorFrame: true },
    TIMEOUT_TYPE_MS,
  );
  await typeIntoLocator(ctx, stepName, locator, title, TIMEOUT_TYPE_MS);
  ctx.onProgress?.(`[${stepName}] 제목 입력 완료`);
}

type BodyPart = { kind: 'text'; value: string } | { kind: 'image'; path: string; caption: string };

/**
 * D11: intro → (이미지[0] → blocks[0].caption) → ... → outro 순서로 조립한다. 이미지는
 * `locator.setInputFiles` 를 쓴다. t2 의 계약(blocks[i].imageId===images[i].id,
 * thumbnailImageId===images[0].id)을 재검증만 한다 — 어긋나면 재정렬하지 않고 거부한다.
 * 이미지가 0장이면(최소 1장 필요) 브라우저를 건드리기 전에 거부한다.
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

  const tree = await fetchTree(ctx, stepName, TIMEOUT_TYPE_MS);
  const bodyLocator = await resolveLocator(
    ctx,
    stepName,
    '본문 입력 영역',
    tree,
    { role: 'textbox', names: A11Y_BODY_NAMES, cssSelector: BODY_MODULE, insideEditorFrame: true },
    TIMEOUT_TYPE_MS,
  );
  const imageButtonLocator = await resolveLocator(
    ctx,
    stepName,
    '사진 추가 버튼',
    tree,
    { role: 'button', names: A11Y_IMAGE_BUTTON_NAMES, cssSelector: null, insideEditorFrame: true },
    TIMEOUT_TYPE_MS,
  );

  const parts: BodyPart[] = [{ kind: 'text', value: draft.intro }];
  for (let i = 0; i < input.images.length; i++) {
    parts.push({ kind: 'image', path: input.images[i].path, caption: draft.blocks[i].caption });
  }
  parts.push({ kind: 'text', value: draft.outro });

  // fileInput 도 다른 로케이터와 마찬가지로 에디터 iframe(EDITOR_FRAME_NAME) 안 요소다 —
  // cssLocator() 로 같은 frameLocator 우회 경로를 태운다(직접 page.locator() 를 쓰면
  // iframe 을 뚫지 못한다).
  const fileInputLocator = cssLocator(IMAGE_FILE_INPUT, true);

  // D7: parts 전체(사용자 값 포함)를 JSON.stringify 로 직렬화해 주입한다.
  const js = `
await (async () => {
  const body = (${bodyLocator.expr});
  const imageButton = (${imageButtonLocator.expr});
  const fileInput = (${fileInputLocator.expr});
  const parts = ${JSON.stringify(parts)};
  await body.click();
  for (const part of parts) {
    if (part.kind === 'text') {
      if (part.value.length > 0) {
        await body.pressSequentially(part.value);
      }
    } else {
      await imageButton.click();
      await fileInput.setInputFiles(part.path);
      await body.click();
      await body.pressSequentially(part.caption);
    }
  }
  console.log(JSON.stringify({ ok: true, partsApplied: parts.length }));
})();
`;
  await runEvaluate(ctx, stepName, js, TIMEOUT_UPLOAD_MS);
  ctx.onProgress?.(`[${stepName}] 본문·이미지 ${input.images.length}장 조립 완료`);
}

/** D11: 첫 이미지를 대표(썸네일)로 지정한다. */
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

  const tree = await fetchTree(ctx, stepName, TIMEOUT_TYPE_MS);
  const locator = await resolveLocator(
    ctx,
    stepName,
    '대표 이미지 지정 컨트롤 — [추정] 미검증(스마트에디터가 첫 이미지를 자동으로 대표 지정할 수도 있음, docs/naver-live-validation.md 참고)',
    tree,
    { role: 'button', names: A11Y_THUMBNAIL_BUTTON_NAMES, cssSelector: null, insideEditorFrame: true },
    TIMEOUT_TYPE_MS,
  );
  await clickLocator(ctx, stepName, locator, TIMEOUT_TYPE_MS);
  ctx.onProgress?.(`[${stepName}] 대표 이미지 지정 완료 (thumbnailImageId=${draft.thumbnailImageId})`);
}

export async function setTags(ctx: StepCtx, tags: string[]): Promise<void> {
  const stepName = 'setTags';
  const tree = await fetchTree(ctx, stepName, TIMEOUT_TYPE_MS);
  const locator = await resolveLocator(
    ctx,
    stepName,
    '태그 입력란',
    tree,
    { role: 'textbox', names: A11Y_TAG_INPUT_NAMES, cssSelector: null, insideEditorFrame: true },
    TIMEOUT_TYPE_MS,
  );

  // D7: tags 는 JSON.stringify 로 직렬화해 주입한다.
  const js = `
await (async () => {
  const target = (${locator.expr});
  await target.click();
  const tags = ${JSON.stringify(tags)};
  for (const tag of tags) {
    await target.pressSequentially(tag);
    await target.press('Enter');
  }
  console.log(JSON.stringify({ ok: true, count: tags.length }));
})();
`;
  await runEvaluate(ctx, stepName, js, TIMEOUT_TYPE_MS);
  ctx.onProgress?.(`[${stepName}] 태그 ${tags.length}개 입력 완료`);
}

/** D12: 미리보기 스크린샷을 남긴다. 이 스크린샷을 워커 컨텍스트로 Read 하지 않는다. */
export async function capturePreview(ctx: StepCtx, screenshotPath: string): Promise<void> {
  const stepName = 'capturePreview';
  const js = `
await (async () => {
  await page.screenshot({ path: ${JSON.stringify(screenshotPath)} });
  console.log(JSON.stringify({ ok: true }));
})();
`;
  await runEvaluate(ctx, stepName, js, TIMEOUT_NAVIGATE_MS);
  ctx.onProgress?.(`[${stepName}] 미리보기 스크린샷 저장함: ${screenshotPath}`);
}

// D8: 발행 버튼을 누르는 코드는 이 함수 안에만 있다. fillEditor 의 코드 경로 어디에서도
// 이 함수를 호출하지 않는다(publisher.test.ts 가 evaluate 호출에서 이 마커의 등장 횟수로
// "발행 클릭 횟수"를 직접 센다).
export const PUBLISH_CLICK_MARKER = '/* NAVER_PUBLISH_CLICK */';

export interface SubmitPublishResult {
  resultUrl: string | null;
}

/** D8: 발행 버튼을 누르는 유일한 함수. */
export async function submitPublish(ctx: StepCtx): Promise<SubmitPublishResult> {
  const stepName = 'submitPublish';
  const tree = await fetchTree(ctx, stepName, TIMEOUT_PUBLISH_MS);
  const locator = await resolveLocator(
    ctx,
    stepName,
    '발행 버튼',
    tree,
    { role: 'button', names: A11Y_PUBLISH_BUTTON_NAMES, cssSelector: null, insideEditorFrame: true },
    TIMEOUT_PUBLISH_MS,
  );

  const js = `
await (async () => {
  ${PUBLISH_CLICK_MARKER}
  await (${locator.expr}).click();
  await page.waitForLoadState('load');
  const url = page.url();
  console.log(JSON.stringify({ url }));
})();
`;
  const stdout = await runEvaluate(ctx, stepName, js, TIMEOUT_PUBLISH_MS);
  const parsed = parseJsonStdout<{ url?: unknown }>(stepName, stdout);
  const resultUrl = typeof parsed.url === 'string' ? parsed.url : null;
  ctx.onProgress?.(`[${stepName}] 발행 버튼 클릭함 (url=${resultUrl ?? 'unknown'})`);
  return { resultUrl };
}
