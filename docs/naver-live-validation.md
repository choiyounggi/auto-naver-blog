# 네이버 스마트에디터 라이브 검증 체크리스트

> **현재 상태를 정직하게 말하면:** 이 모듈(`lib/naver/**`)의 셀렉터·URL·접근성 이름은
> 공개 자료(Selenium 자동화 글 4건 이상, 서로 독립)에서 코디네이터가 교차 확인했거나
> 이 작업이 D5 전략(snapshot role+name 우선)을 실행하기 위해 자체 고안한 **가설**이다.
> **실제 네이버 스마트에디터에 대해 한 번도 실행된 적이 없다.** 단위 테스트는 전부
> 합성(가짜) 스냅샷 픽스처에 대해서만 돌았다 — 실제 발행 성공은 관측된 적이 없다.
>
> 이 문서는 **결과를 기록하는 양식**이지 결과가 아니다. 아래 체크박스는 모두 비어
> 있어야 하며, 실제로 라이브에서 확인하기 전까지는 채우지 않는다.

## 전제 조건

- [ ] 네이버 로그인 완료 (`npm run naver:login`)
- [ ] 테스트용 비공개 카테고리를 미리 하나 만들어 둔다 (실제 발행 대상 블로그에 노출되지
      않도록) — 아래 "카테고리 선택" 검증에 그 이름을 쓴다
- [ ] `NAVER_BLOG_ID` 등 `lib/config.ts` 가 요구하는 환경변수가 설정돼 있다

## 실패 시 읽는 법

이 모듈의 각 단계는 실패를 세 가지로 구분해서 낸다(D4):

1. **`ElementNotFoundError`** — evaluate 자체는 성공했다(브라우저는 살아있다). 찾던
   대상이 그 시점 페이지에 없었다는 뜻이다. 에러 메시지에 **단계명**, **찾던 대상**,
   **그 시점 스냅샷의 관련 부분(발췌)** 이 담긴다. → 아래 표에서 그 단계에 대응하는
   `lib/naver/selectors.ts` 상수를 스냅샷 발췌를 참고해 실제 값으로 고친다.
2. **`EvaluationFailedError`** — evaluate 가 `ok:false` 를 돌려줬다(채널 poisoned,
   탭 없음, REPL 오류 등). `selectors.ts` 문제가 아닐 수 있다. → aside 브라우저/REPL
   상태를 먼저 확인한다(재시작, `asideStepTimeoutMs` 조정 등).
3. **`CategoryNotFoundError`** — D14: 입력한 카테고리 이름이 블로그의 실제 카테고리
   목록과 정확히 일치하지 않았다. 에러에 사용 가능한 카테고리 이름 전체가 담긴다. →
   입력값의 오타를 고치거나, 목록 파싱이 실패한 것이면 `A11Y_CATEGORY_CONTROL_NAMES`
   를 고친다.

## 단계별 확인 순서

**중요:** 발행은 맨 마지막에, 그리고 가능하면 **임시저장으로 먼저** 시도한다.
실제 발행 버튼(`submitPublish`, `NaverPublisher.publish()`)은 이 순서를 모두 통과한
뒤, 되돌릴 수 없는 행동이라는 것을 인지한 상태에서만 누른다.

1. 진입 (`openEditor`) — `writeUrl(blogId)` 로 이동, `mainFrame` iframe 로드 확인
2. 팝업 정리 (`dismissEntryPopups`) — 선택적, 없어도 실패 아님
3. **카테고리 선택** (`selectCategory`) — 전제 조건에서 만든 비공개 카테고리 이름을 사용
4. 제목 (`fillTitle`)
5. 본문·이미지 (`fillBodyAndImages`) — intro → 이미지[0]+caption[0] → ... → outro
6. 대표 이미지 지정 (`setThumbnail`)
7. 태그 (`setTags`)
8. 미리보기 스크린샷 (`capturePreview`) — `<dataDir>/jobs/<jobId>/preview.png` 확인
9. (선택, 권장) 임시저장
10. 발행 (`submitPublish` / `publish()`) — 가장 마지막에, 신중하게

## 가설별 확인표

`lib/naver/selectors.ts` 가 export 하는 모든 상수를 다룬다. "확인 방법" 은 라이브에서
무엇을 관찰하면 되는지, "틀렸을 때 교체" 는 `selectors.ts` 의 어느 상수를 무엇으로
바꾸는지를 말한다.

| 상수 | 현재 가설 | 확인 방법 | 틀렸을 때 교체 | 확인 결과 |
|---|---|---|---|---|
| `writeUrl(blogId)` | `https://blog.naver.com/{blogId}?Redirect=Write` | `openEditor` 실행 후 실제로 글쓰기 화면이 뜨는지 확인 | `writeUrl` 함수 본문의 URL 템플릿을 교체 (예: `PostWriteForm.naver?blogId=...` 형태로) | [ ] |
| `EDITOR_FRAME_NAME` (`mainFrame`) | 에디터가 이 name의 iframe 안에 있다 | `openEditor` 가 "에디터 iframe 을 찾지 못함" 으로 실패하는지 확인. 실패하면 실제 iframe 의 name/id 를 개발자도구로 확인 | `EDITOR_FRAME_NAME` 값을 실제 name으로 교체 | [ ] |
| `POPUP_DRAFT_RESTORE_CANCEL` (`.se-popup-button.se-popup-button-cancel`) | "작성중인 글이 있습니다" 팝업의 취소 버튼 셀렉터 | `dismissEntryPopups` 진행 로그에서 이 팝업이 "정리했다"/"없었음" 중 어느 쪽으로 찍히는지 확인. 실제로 팝업이 떴는데 "없었음" 으로 나오면 셀렉터가 틀림 | 개발자도구로 실제 취소 버튼의 클래스를 확인해 교체 | [ ] |
| `POPUP_HELP_PANEL_CLOSE` (`.se-help-panel-close-button`) | 도움말 패널 닫기 버튼 셀렉터 | 위와 동일한 방식으로 도움말 패널에 대해 확인 | 실제 닫기 버튼의 클래스로 교체 | [ ] |
| `TITLE_PLACEHOLDER` (`.se-placeholder.__se_placeholder.se-fs32`) | 제목 입력 영역의 placeholder 클래스 (CSS 폴백) | `fillTitle` 이 role+name(`A11Y_TITLE_NAMES`)으로 못 찾고 이 CSS로도 못 찾으면 `ElementNotFoundError` 발생 — 그 발췌로 실제 클래스 확인 | 실제 제목 영역의 클래스로 교체 | [ ] |
| `TITLE_TEXT_MODULE` (`.se-title-text`) | 제목 텍스트 모듈 클래스 — 현재 `steps.ts` 어떤 단계도 아직 이 상수를 사용하지 않는다(향후 제목이 실제로 입력됐는지 검증하는 단계를 추가할 때 쓸 후보로 남겨둠) | 라이브에서 제목 입력 후 실제 DOM 에 이 클래스가 나타나는지 개발자도구로 확인 | 실제 클래스로 교체하거나, 쓰이지 않는다면 제거를 별도로 논의 | [ ] |
| `BODY_MODULE` (`.se-module.se-module-text`) | 본문 텍스트 모듈 클래스 (CSS 폴백) | `fillBodyAndImages` 가 role+name(`A11Y_BODY_NAMES`)으로 못 찾고 이 CSS로도 못 찾으면 실패 — 발췌로 확인 | 실제 본문 모듈 클래스로 교체 | [ ] |
| `IMAGE_FILE_INPUT` (`input[type="file"]`) | 이미지 업로드 시 `setInputFiles` 대상이 되는 숨겨진 파일 입력 | `fillBodyAndImages` 실행 중 이미지 업로드 단계에서 실패하면(파일이 실제로 들어가지 않으면) 이 셀렉터가 틀렸을 가능성 — 개발자도구로 실제 `<input type="file">` 위치 확인 | 실제 파일 입력 셀렉터로 교체 | [ ] |
| `A11Y_TITLE_NAMES` | `['제목을 입력하세요', '제목', '제목 입력']` | `fillTitle` 이 role+name 으로 바로 성공하는지, 아니면 CSS 폴백까지 가는지 확인 | 실제 접근성 이름(스냅샷에서 관찰)을 배열 맨 앞에 추가 | [ ] |
| `A11Y_IMAGE_BUTTON_NAMES` | `['사진', '사진 추가', '이미지 추가', '이미지']` | `fillBodyAndImages` 의 "사진 추가 버튼" 조회가 성공하는지 확인 | 실제 이름을 배열 맨 앞에 추가 | [ ] |
| `A11Y_TAG_INPUT_NAMES` | `['태그 입력', '태그를 입력하세요', '태그']` | `setTags` 의 태그 입력란 조회가 성공하는지 확인 | 실제 이름을 배열 맨 앞에 추가 | [ ] |
| `A11Y_PUBLISH_BUTTON_NAMES` | `['발행', '발행하기']` | `submitPublish` 의 발행 버튼 조회가 성공하는지 확인 (임시저장으로 먼저 이 단계 앞부분까지만 검증 권장) | 실제 이름을 배열 맨 앞에 추가 | [ ] |
| `A11Y_CATEGORY_CONTROL_NAMES` | `['카테고리', '카테고리 선택']` | `selectCategory` 가 카테고리 컨트롤을 여는 데 성공하는지 확인 | 실제 컨트롤의 접근성 이름을 배열 맨 앞에 추가 | [ ] |
| `A11Y_BODY_NAMES` | `['본문에 입력하세요', '본문을 입력하세요', '본문']` | `fillBodyAndImages` 의 본문 영역 조회가 role+name 으로 성공하는지 확인 | 실제 이름을 배열 맨 앞에 추가 | [ ] |
| `A11Y_THUMBNAIL_BUTTON_NAMES` | `['대표사진으로 설정', '대표 이미지로 설정', '대표사진 설정']` — **미검증**: 스마트에디터가 첫 이미지를 자동으로 대표 지정할 수도 있어, 이런 버튼이 아예 없을 가능성도 있다 | `setThumbnail` 이 성공하는지, 혹은 애초에 이런 컨트롤이 존재하지 않는지(첫 이미지가 이미 자동으로 대표로 지정돼 있는지) 확인 | 실제 컨트롤이 있으면 이름을 교체. 없다면(자동 지정이면) `setThumbnail` 단계 자체를 "확인만 하고 클릭하지 않는" 형태로 바꿔야 함 — 코드 변경 필요, 라이브 결과를 들고 다시 논의 | [ ] |
| `TIMEOUT_NAVIGATE_MS` (45000) | 페이지 진입 타임아웃 | `openEditor`/`capturePreview` 가 타임아웃으로 실패하는지 확인 | 실제 관찰된 소요 시간의 2배 이상으로 조정 | [ ] |
| `TIMEOUT_UPLOAD_MS` (90000) | 이미지 업로드 타임아웃 | `fillBodyAndImages` 가 타임아웃으로 실패하는지 확인(이미지가 많을수록 오래 걸림) | 실제 관찰된 소요 시간에 맞춰 조정 | [ ] |
| `TIMEOUT_TYPE_MS` (20000) | 텍스트 입력류 타임아웃 | `fillTitle`/`setTags`/`selectCategory`/`setThumbnail`/`dismissEntryPopups` 가 타임아웃으로 실패하는지 확인 | 실제 관찰된 소요 시간에 맞춰 조정 | [ ] |
| `TIMEOUT_PUBLISH_MS` (45000) | 발행 버튼 클릭+결과 확인 타임아웃 | `submitPublish` 가 타임아웃으로 실패하는지 확인 | 실제 관찰된 소요 시간에 맞춰 조정 | [ ] |

## 마커 정리 규칙

라이브에서 **확인된 항목만** 위 표의 상수 주석에서 `[추정]` 마커를 지운다. 확인하지
않은 항목의 마커를 함께 지우지 않는다 — provisional 마커는 근거가 생긴 뒤에만
확정으로 바뀐다. 일부만 확인했다면 확인된 것만 지우고, 나머지는 `[추정]` 그대로 둔다.

## 이 문서가 말하지 않는 것

- 이 코드가 "동작한다"는 주장은 어디에도 없다. 단위 테스트는 합성 픽스처에 대해서만
  통과했다.
- 실제 발행이 성공적으로 끝나 실제 블로그 글이 생성되는지는 이 문서를 채우기 전까지
  아무도 확인하지 않은 상태다.
