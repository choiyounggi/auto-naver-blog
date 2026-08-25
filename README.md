# auto-naver-blog

사진과 강조할 내용, 카테고리를 입력하면 `claude` CLI 가 이미지를 분석해 블로그 글을 쓰고,
Aside 브라우저로 네이버 블로그 스마트에디터에 채워 넣은 뒤 — **사람이 미리보기를 승인해야만**
— 발행하는 로컬 단일 사용자 웹서비스다. 첫 번째 이미지가 대표(썸네일) 이미지가 된다.

## ⚠️ 아직 검증되지 않은 부분

`lib/naver/**` 이 네이버 스마트에디터를 조작하는 셀렉터·접근성 이름은 공개 자료를
교차 확인했거나 이 프로젝트가 자체 고안한 **가설**이다. 단위 테스트는 전부 합성(가짜)
스냅샷 픽스처에 대해서만 통과했고, **실제 네이버 스마트에디터에 대해 실행된 적이 없다.**
실제 발행이 성공하는지는 아직 아무도 확인하지 않았다.

라이브 환경에서 단계별로 확인하고 결과를 기록하는 방법은
[`docs/naver-live-validation.md`](docs/naver-live-validation.md) 를 참고한다.

## 아키텍처

- `lib/aside` — Aside 브라우저와의 REPL 채널(`AsideRepl`), 네이버 로그인 세션(`NaverSession`)
- `lib/content` — 이미지 분석과 초안 생성 (`ContentGenerator`, `claude` CLI 호출)
- `lib/naver` — 스마트에디터 조작 (`NaverPublisher`) — 위 경고 참고
- `lib/job` — 잡 상태 저장소와 API 라우트가 쓰는 서비스 주입 지점 (`setServices`/`getServices`)
- `app` — 업로드 UI, 잡 상태 폴링, 미리보기·발행 승인 화면
- `lib/pipeline` — 위 조각들을 실제로 조립하고 Aside REPL 의 지연 시작·정리를 담당
- `instrumentation.ts` — Next.js 서버 부팅 훅. `lib/pipeline` 이 만든 서비스를 주입하고,
  프로세스 종료 시 정리한다

## 최초 설정

```bash
npm install
npm run setup        # aside·claude 실행 가능 여부, data/ 준비, 쿠키 존재 여부를 점검하고 안내한다
npm run naver:login   # Aside 브라우저에서 직접 로그인한다 (자동 로그인 아님, 사람이 함)
```

로그인 후 실제로 발행하려는 네이버 블로그의 카테고리 이름을 미리 확인해 둔다 —
업로드 화면에서 입력하는 카테고리 문자열이 블로그의 실제 카테고리 이름과 정확히 일치해야
한다.

```bash
npm run dev            # http://127.0.0.1:3000
```

## 안전 계약

- 발행은 오직 `POST /api/jobs/[id]/publish` 로만 시작되고, 그 엔드포인트는 잡의 phase 가
  `awaiting_approval` 일 때만 동작한다 — 즉 사람이 채워진 에디터의 스크린샷 미리보기를 보고
  승인해야만 발행 버튼이 눌린다. 초안 생성이나 에디터 채우기 단계에서 자동으로 발행되는
  경로는 없다.
- 로그인은 항상 사람이 Aside 브라우저 창에서 직접 한다 (`npm run naver:login`). ID·비밀번호를
  코드나 환경변수로 다루는 곳은 없다.

## 알려진 제약

- 로컬 단일 사용자용이며 인증이 없다 — 반드시 루프백(`127.0.0.1`)에만 바인딩해서 쓴다
  (`npm run dev`/`npm start` 는 이미 `-H 127.0.0.1` 로 고정돼 있다).
- 한 번에 최대 20장의 이미지까지 지원한다.
- `claude` CLI 호출마다 비용이 발생한다.
