// t4/D1 갱신(2026-08-25): 이 파일의 값들은 이제 [추정]이 아니라 **실측**이다 — 실제
// 네이버 스마트에디터 ONE(blog.naver.com/<blogId>?Redirect=Write)에서 DOM 과 접근성
// 스냅샷을 직접 읽어 확인했다. 확인 방법은 각 상수 위 주석에 적는다.
//
// 이 파일 밖에는 셀렉터·URL 문자열이 존재해서는 안 된다.

// ---------------------------------------------------------------------------
// URL
// ---------------------------------------------------------------------------

// [실측] 이 URL 로 들어가면 mainFrame 안에 스마트에디터가 뜬다.
export function writeUrl(blogId: string): string {
  return `https://blog.naver.com/${blogId}?Redirect=Write`;
}

// ---------------------------------------------------------------------------
// iframe
// ---------------------------------------------------------------------------

// [실측] 에디터는 name/id 가 모두 'mainFrame' 인 iframe 안에서 렌더링된다.
// 주의: iframe 의 접근성 이름은 title/aria-label 에서 오므로 스냅샷에는 이름 없는
// `- iframe:` 으로만 찍힌다 — 존재 확인은 반드시 DOM 셀렉터로 한다.
export const EDITOR_FRAME_NAME = 'mainFrame';

// ---------------------------------------------------------------------------
// 진입 팝업 (선택적 정리 — 없어도 실패 아님)
// ---------------------------------------------------------------------------

// [추정] 실측 당시에는 두 팝업 모두 뜨지 않아 확인하지 못했다. 없으면 그냥 넘어간다.
export const POPUP_DRAFT_RESTORE_CANCEL = '.se-popup-button.se-popup-button-cancel';
export const POPUP_HELP_PANEL_CLOSE = '.se-help-panel-close-button';

// ---------------------------------------------------------------------------
// 제목 / 본문
// ---------------------------------------------------------------------------

// [실측] 제목 자리표시자. 실제 class 는
// `se-placeholder __se_placeholder se-ff-nanumgothic se-fs32` 였다 — 폰트 클래스는
// 사용자 설정에 따라 달라질 수 있어 제외하고, 크기 클래스(se-fs32)로 제목을 특정한다.
export const TITLE_PLACEHOLDER = '.se-placeholder.__se_placeholder.se-fs32';

// [실측] 본문 텍스트 모듈. 제목 모듈도 같은 클래스를 쓰므로 **마지막 것**이 본문이다.
export const BODY_MODULE = '.se-module.se-module-text';

// [실측] 사진 추가 버튼. 누르면 DOM 의 file input 이 아니라 **네이티브 파일 선택창**이
// 열린다 — page.waitForEvent('filechooser') 로 받아야 한다.
export const IMAGE_TOOLBAR_BUTTON = '.se-image-toolbar-button';

// [실측] 업로드가 끝나면 본문에 이 이미지 태그가 생긴다(src 가 blogfiles.pstatic.net).
export const UPLOADED_IMAGE = 'img.se-image-resource';

// ---------------------------------------------------------------------------
// 발행 패널 (툴바 '발행' 을 눌러야 나타난다)
// ---------------------------------------------------------------------------

// [실측] 툴바의 '발행' 버튼. 누르면 발행 설정 패널이 열린다(아직 발행되지 않는다).
// class 는 `publish_btn__m9KHH` 처럼 빌드 해시가 붙으므로 접두사로만 매칭한다.
export const PUBLISH_PANEL_OPEN_BUTTON = 'button[class*="publish_btn"]';

// [실측] 발행 패널 안의 카테고리 드롭다운 버튼. aria-label 이 안정적이다.
export const CATEGORY_DROPDOWN_BUTTON = 'button[aria-label="카테고리 목록 버튼"]';

// [실측] 드롭다운을 연 뒤의 카테고리 항목들. `li.item__<hash> > label.radio_label__<hash>`
// 구조이며, 이름은 label 의 텍스트다.
export const CATEGORY_OPTION_LABEL = 'li[class*="item__"] label[class*="radio_label"]';

// [실측] 태그 입력칸. id 가 있어 가장 안정적이다.
export const TAG_INPUT = '#tag-input';

// [실측] 공개 설정 라디오는 name="open_type" 이고 id 는 아래 네 가지다.
// 라디오 자체는 hidden 이라 label[for=...] 을 클릭해야 한다.
export const VISIBILITY_LABEL_PUBLIC = 'label[for="open_public"]';
export const VISIBILITY_LABEL_PRIVATE = 'label[for="open_private"]';

// [실측] 패널 안의 최종 '발행' 버튼 — 이것을 눌러야 실제로 발행된다.
// 툴바의 발행 버튼(publish_btn)과 구분해야 한다.
export const PUBLISH_CONFIRM_BUTTON = 'button[class*="confirm_btn"]';

// ---------------------------------------------------------------------------
// 접근성 이름 후보 (스냅샷 기반 조회에 쓴다)
// ---------------------------------------------------------------------------

// [실측] 발행 패널의 카테고리 버튼은 접근성 이름이 "카테고리 목록 버튼" 이다.
export const A11Y_CATEGORY_CONTROL_NAMES = ['카테고리 목록 버튼'];
// [실측] 태그 입력칸의 접근성 이름은 "태그 입력 (최대 30개)" 이다.
export const A11Y_TAG_INPUT_NAMES = ['태그 입력 (최대 30개)', '태그 입력'];
// [실측] 발행 버튼(툴바·패널 모두) 접근성 이름은 "발행" 이다.
export const A11Y_PUBLISH_BUTTON_NAMES = ['발행'];

// ---------------------------------------------------------------------------
// 타임아웃
// ---------------------------------------------------------------------------

export const TIMEOUT_NAVIGATE_MS = 90_000;
export const TIMEOUT_TYPE_MS = 60_000;
// 이미지 업로드는 네이버 서버 왕복이 있어 넉넉히 잡는다(실측: 1장에 5~9초).
export const TIMEOUT_UPLOAD_MS = 300_000;
export const TIMEOUT_PUBLISH_MS = 120_000;
