# 다음 세션 프롬프트 — 외부 공개용 인증·격리 (A안)

> 다음 세션에서 **`/dev-loop:orchestrate`** 에 아래 "목표" 절을 그대로 붙여 넣으면 된다.
> 그 아래 절들(현재 상태·요구사항·제약·분해 힌트·완료 기준)은 오케스트레이터가 작업을
> 쪼갤 때 함께 읽히도록 이 문서 경로를 목표문에 적어 두었다.

---

## 목표 (이 부분을 orchestrate 에 붙여 넣는다)

auto-naver-blog 를 로컬 단일 사용자용에서 **여러 사람이 같이 쓸 수 있는 형태**로 바꾼다.
지금은 인증이 전혀 없어 주소만 알면 누구나 내 네이버 계정으로 글을 발행할 수 있고,
Aside REPL 이 하나뿐이라 두 명이 동시에 발행하면 서로의 에디터를 망가뜨린다.

네 가지를 모두 적용한다. 상세 요구사항·제약·완료 기준은
`docs/next-session-multiuser-prompt.md` 에 적혀 있으니 반드시 먼저 읽고 시작한다.

1. **공유 비밀번호 인증** — 비밀번호를 아는 사람만 앱을 쓸 수 있게 한다
2. **관리자 전용 경로 분리** — 네이버 로그인·재로그인·설정은 관리자만
3. **동시 발행 직렬화** — 두 사람이 겹쳐도 서로의 에디터를 건드리지 않게 한다
4. **바인딩 개방** — `127.0.0.1` 고정을 설정으로 풀되, 인증 없이는 열리지 않게 한다

기존 안전 계약(사람 승인 없이는 발행하지 않는다, 자격증명을 코드가 다루지 않는다)은
그대로 유지한다.

---

## 현재 상태 (2026-08-29 기준)

- Next.js 16 (App Router, Turbopack) + TypeScript + vitest. 테스트 425개 통과.
- `npm run dev` / `npm start` 가 `-H 127.0.0.1` 로 고정돼 있다(`package.json`).
- **인증 코드가 한 줄도 없다.** 모든 API 가 무인증이다.

### 현재 API 표면

| 경로 | 메서드 | 성격 |
|---|---|---|
| `/api/setup` | GET | 온보딩 상태(`?verify=1` 이면 라이브 로그인 확인, 60초 캐시) |
| `/api/setup/login` | POST | 네이버 로그인 창 열고 대기 (최대 5분) |
| `/api/setup/relogin` | POST | 쿠키 삭제 + 네이버 로그아웃 + 재로그인 |
| `/api/jobs` | POST | 잡 생성(사진 업로드) |
| `/api/jobs/[id]` | GET | 잡 상태 |
| `/api/jobs/[id]/events` | GET | 진행 상황 SSE |
| `/api/jobs/[id]/images` | POST | 사진 추가 |
| `/api/jobs/[id]/images/[imageId]` | GET | 사진 서빙 |
| `/api/jobs/[id]/draft` | PUT | 고친 초안 저장 |
| `/api/jobs/[id]/preview` | GET/POST | 미리보기 스크린샷 조회/재촬영 |
| `/api/jobs/[id]/publish` | POST | **발행** |

### 알아야 할 구조

- `lib/config.ts` — 환경변수로 설정을 읽는다(`loadConfig`). `ENV_FILE_PATH` 도 여기 있다.
- `lib/job/services.ts` — `globalThis` 심볼에 서비스를 주입한다(dev HMR 로 모듈 인스턴스가
  갈려도 공유되도록). 새로 만드는 전역 상태도 같은 방식을 따를 것.
- `lib/pipeline.ts` — `LazyNaverPublisher` 가 **AsideRepl 하나**를 지연 생성해 재사용한다.
  `activePublisher` 도 모듈 전역이다. **동시성 문제의 근원지가 여기다.**
- `lib/job/store.ts` — 잡 상태를 `data/jobs/<id>/state.json` 에 저장한다. 단계 전이는
  한 방향으로만 흐른다(`isLegalTransition`). 이 불변식을 느슨하게 만들지 말 것.
- `lib/job/runner.ts` — `runJob`(생성→미리보기까지) / `approveAndPublish`(발행).
  `approveAndPublish` 는 사람이 고친 초안이 있으면 에디터를 다시 채운 뒤 발행한다.
- `lib/aside/login-verify-cache.ts` — 로그인 확인 결과 60초 캐시(globalThis).

---

## 요구사항 상세

### 1. 공유 비밀번호 인증

- 비밀번호는 **환경변수**로 준다(예: `ANB_ACCESS_PASSWORD`). 코드·저장소에 넣지 않는다.
- **해시로 비교한다.** 평문 비교 금지, 타이밍 공격을 피해 `crypto.timingSafeEqual` 을 쓴다.
- 로그인하면 **서명된 세션 쿠키**를 준다(`HttpOnly`, `SameSite=Lax`, HTTPS 면 `Secure`).
  서명 키도 환경변수(`ANB_SESSION_SECRET`). 키가 없으면 **서버가 뜨지 않게** 한다 —
  조용히 무인증으로 도는 상태를 만들지 않는다.
- 비밀번호가 설정돼 있지 않으면: 루프백 바인딩일 때만 무인증 허용, 외부 바인딩이면 부팅 거부.
- 로그인 시도에 **속도 제한**을 건다(예: IP 당 분당 N회). 무한 대입을 막는다.
- 화면: 인증 안 된 사용자는 비밀번호 입력 화면만 본다.

### 2. 관리자 전용 경로 분리

- 관리자 비밀번호는 별도 환경변수(`ANB_ADMIN_PASSWORD`). 일반 비밀번호와 달라야 한다.
- **관리자만** 쓸 수 있는 것: `/api/setup/login`, `/api/setup/relogin`,
  그리고 `/api/setup?verify=1` 의 라이브 확인(브라우저를 띄우므로).
- 일반 사용자에게는 `/api/setup` 의 **읽기 전용 요약**만 준다(준비됨 여부·카테고리 목록).
  쿠키 만료 시각 같은 계정 정보는 일반 사용자에게 주지 않는다.
- 온보딩 화면(`app/components/Onboarding.tsx`)은 관리자에게만 보인다. 일반 사용자에게는
  "관리자가 네이버 로그인을 해야 합니다" 안내만 보인다.

### 3. 동시 발행 직렬화

- **핵심 문제**: `LazyNaverPublisher` 가 AsideRepl 하나를 공유한다. 두 잡이 동시에
  `fillEditor`/`publish` 를 부르면 같은 브라우저 탭을 서로 조작한다.
- **잡 큐**를 만든다: 브라우저를 쓰는 구간(`fillEditor`·`refreshPreview`·`publish`)은
  한 번에 하나만 실행한다. 나머지는 대기하고, 화면에 "앞에 N건 대기 중" 을 보여준다.
- 큐 상태도 `globalThis` 에 둔다(모듈 인스턴스가 갈려도 공유되도록).
- 이미 승인 대기 중인 잡이 있는데 다른 사람이 발행을 시작하면, **에디터를 빼앗지 않고**
  순서를 기다리게 한다.
- 대기가 너무 길어지면(예: 10분) 거절하고 사유를 남긴다 — 조용히 매달려 있지 않는다.
- 잡에 **소유자**를 기록한다(세션 식별자). 남의 잡을 고치거나 발행할 수 없게 한다.

### 4. 바인딩 개방

- 바인딩 호스트를 환경변수로 뺀다(예: `ANB_HOST`, 기본값 `127.0.0.1`).
- `127.0.0.1` 이 아닌 값으로 뜰 때는 **인증 설정이 갖춰져 있는지 부팅 시 검사**하고,
  없으면 명확한 메시지와 함께 종료한다.
- README 의 "반드시 루프백에만 바인딩" 문구를 실제 동작에 맞게 고친다.

---

## 제약 (반드시 지킬 것)

- **안전 계약 유지**: 발행은 오직 `POST /api/jobs/[id]/publish` 로만 시작되고, 잡이
  `awaiting_approval` 일 때만 동작한다. `fillEditor` 경로에서 발행 버튼을 누르지 않는다.
  `tests/naver/publisher.test.ts` 의 "발행 클릭 횟수" 안전 테스트를 깨뜨리지 말 것.
- **자격증명 무취급**: 네이버 아이디·비밀번호는 코드가 다루지 않는다. 사람이 브라우저에
  직접 입력한다. `tests/aside/naver-login-args.test.ts` 가드를 깨뜨리지 말 것.
- **단계 전이 불변식 유지**: `lib/job/store.ts` 의 `isLegalTransition` 을 느슨하게 만들지
  않는다. 되돌아가는 전이가 필요해 보이면 로그로 대신한다.
- **비밀은 저장소에 없다**: 비밀번호·서명 키는 환경변수로만. `.env` 는 이미 gitignore 됨.
- **테스트 기준**: 새 기능마다 정상·에러·경계값을 각각 1개 이상. assertion 없는 테스트 금지.
  임시 파일은 `/tmp` 가 아니라 프로젝트 안(`.vitest-tmp/`)에만 만든다.
- **한국어 주석**: 기존 코드처럼 "왜 이렇게 했는지" 를 한국어로 남긴다. 실측으로 알아낸
  사실은 근거와 함께 적는다.
- **커밋 전 검증**: `npm run typecheck`, `npm test`, `npm run build` 세 개 모두 통과.

---

## 병렬 분해 힌트 (파일 범위를 겹치지 않게)

오케스트레이터가 아래처럼 쪼개면 파일 충돌 없이 병렬로 갈 수 있다.

| 작업 | 주로 만지는 파일 | 의존 |
|---|---|---|
| **A. 인증 코어** | `lib/auth/*` (신규), `lib/config.ts`, `tests/auth/*` | 없음 |
| **B. 큐/동시성** | `lib/job/queue.ts`(신규), `lib/pipeline.ts`, `lib/job/runner.ts`, `tests/job/queue.test.ts` | 없음 |
| **C. 라우트 가드 적용** | `app/api/**/route.ts`, `middleware.ts`(신규) | A |
| **D. 화면** | `app/page.tsx`, `app/components/*`(로그인 화면 신규) | A |
| **E. 부팅 검사·바인딩** | `package.json`, `instrumentation-node.ts`, `README.md`, `.env.example` | A |

- A 와 B 는 서로 독립이므로 **동시에** 진행할 수 있다.
- C·D 는 A 가 인터페이스를 확정한 뒤 시작한다.
- E 는 마지막에 문서까지 함께 맞춘다.

---

## 완료 기준

1. 비밀번호 없이 `POST /api/jobs`, `PUT /api/jobs/[id]/draft`, `POST /api/jobs/[id]/publish`
   를 부르면 **401** 이 돌아온다.
2. 일반 세션으로 `POST /api/setup/relogin` 을 부르면 **403** 이 돌아온다.
3. 남의 잡을 고치거나 발행하려 하면 **403** 이 돌아온다.
4. 두 잡이 동시에 발행을 요청하면 **하나가 끝난 뒤 다른 하나가 시작**된다(브라우저 조작이
   겹치지 않는다). 대기 중인 쪽 화면에 대기 상태가 보인다.
5. `ANB_HOST` 를 `0.0.0.0` 으로 두고 비밀번호·서명 키 없이 실행하면 **부팅이 거부**되고
   이유가 출력된다.
6. `npm run typecheck`, `npm test`, `npm run build` 전부 통과. 기존 425개 테스트가 모두
   그대로 통과하거나, 계약이 바뀐 테스트는 **왜 바뀌었는지 주석과 함께** 갱신돼 있다.
7. README 에 인증 설정 방법과 외부 공개 시 주의사항이 적혀 있다.

---

## 하지 말 것

- HTTPS 종단·리버스 프록시 설정까지 이 작업에 넣지 않는다(별도 결정). 다만 README 에
  "외부 공개 시 HTTPS 뒤에 두라" 는 안내는 남긴다.
- 사용자별 계정·권한 체계(B안)로 확대하지 않는다. 이번은 공유 비밀번호 + 관리자 구분까지다.
- 네이버 계정을 여러 개 붙이는 일은 범위 밖이다 — 블로그는 하나다.
