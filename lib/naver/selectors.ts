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
// 글자 서식 (소제목 강조)
// ---------------------------------------------------------------------------

// [실측] 글자 크기 드롭다운 버튼과, 열렸을 때 나타나는 옵션 목록.
// 고를 수 있는 크기는 11·13·15·16·19·24·28·30·34·38 이고 기본은 15 다.
export const FONT_SIZE_BUTTON = '.se-font-size-code-toolbar-button';
export const FONT_SIZE_OPTION = '.se-toolbar-option-font-size-code button';

// [실측] 굵게 토글. 켜고 끄는 방식이라 소제목을 쓴 뒤 반드시 다시 꺼야 한다.
export const BOLD_BUTTON = '.se-bold-toolbar-button';

// 본문 기본 크기와 소제목 크기. 인기글 4편을 분석해 보니 본문은 기본 크기를 그대로 쓰고
// 강조는 굵게로만 한다 — 소제목만 한 단계 키워 구조가 보이게 하고, 그 외에는 손대지 않는다.
export const FONT_SIZE_BODY = '15';
export const FONT_SIZE_HEADING = '19';

// ---------------------------------------------------------------------------
// 장소(위치) 첨부 — 툴바 '장소' 를 누르면 검색 팝업이 열린다
// ---------------------------------------------------------------------------

// [실측] 툴바의 '장소' 버튼.
export const PLACE_TOOLBAR_BUTTON = '.se-map-toolbar-button';

// [실측] 장소 검색 팝업. 다른 팝업과 구분해야 하므로 이 컨테이너 안으로 범위를 좁힌다.
export const PLACE_POPUP = '.se-popup-placesMap';

// [실측] 검색어 입력칸. react-autosuggest 로 만들어져 있어 키보드 타이핑으로는 한글이
// 첫 글자만 들어간다("판교역" → "판") — locator.fill() 로 값을 한 번에 넣어야 한다.
export const PLACE_SEARCH_INPUT = 'input.react-autosuggest__input';

// [실측] Enter 로는 검색이 걸리지 않는다 — 전용 검색 버튼을 눌러야 한다.
export const PLACE_SEARCH_BUTTON = 'button.se-place-search-button';

// [실측] 검색 결과 항목. 결과가 없으면 0개이고 "검색 결과가 없습니다." 문구가 뜬다.
export const PLACE_RESULT_ITEM = 'li.se-place-map-search-result-item';

// [실측] 각 결과의 '추가' 버튼. hover 전에는 Playwright 의 클릭 가능 판정을 통과하지
// 못하므로 DOM 클릭으로 누른다.
export const PLACE_ADD_BUTTON = 'button.se-place-add-button';

// [실측] 팝업 하단의 '확인' — 이걸 눌러야 본문에 se-placesMap 컴포넌트가 삽입된다.
export const PLACE_CONFIRM_BUTTON = 'button.se-popup-button-confirm';

// [실측] 팝업 닫기. 검색 결과가 없을 때 이걸로 닫고 장소 없이 진행한다.
export const PLACE_CLOSE_BUTTON = 'button.se-popup-close-button';

// [실측] 결과 항목 안의 장소 이름·주소. 진행 로그에 무엇이 골라졌는지 남기기 위해 읽는다.
export const PLACE_RESULT_TITLE = '.se-place-map-search-result-title';
export const PLACE_RESULT_ADDRESS = '.se-place-map-search-result-address';

// [실측] 삽입된 장소 컴포넌트.
export const PLACE_COMPONENT = '.se-component.se-placesMap';

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
