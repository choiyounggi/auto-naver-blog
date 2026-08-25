// D4: 실패의 세 가지 결과 중 (2) "대상을 못 찾음" 과 (3) "검사 자체를 수행 못 함" 을 서로
// 다른 에러 타입으로 구별한다. 라이브에서 "셀렉터가 틀렸다"(ElementNotFoundError) 와
// "브라우저가 죽었다"(EvaluationFailedError) 는 정반대 대응을 요구하기 때문이다.

/**
 * D4-(2): snapshot role+name 조회와 selectors.ts 의 [추정] CSS 폴백이 모두 실패했다 —
 * evaluate() 자체는 성공했지만(브라우저는 살아있다) 찾던 대상이 그 시점 페이지에 없었다.
 * 라이브에서 이 에러를 보면 `selectors.ts` 를 고쳐야 한다.
 */
export class ElementNotFoundError extends Error {
  readonly step: string;
  readonly target: string;
  readonly excerpt: string;

  constructor(step: string, target: string, excerpt: string) {
    super(`[${step}] 대상을 찾지 못함: ${target}\n스냅샷 발췌:\n${excerpt}`);
    this.name = 'ElementNotFoundError';
    this.step = step;
    this.target = target;
    this.excerpt = excerpt;
  }
}

/**
 * D4-(3): evaluate() 가 ok:false 를 돌려줬다 — 채널이 poisoned 되었거나, 탭이 없거나,
 * REPL 자체가 실패한 경우를 포함한다. 검사 자체를 수행하지 못했으므로 selectors.ts 문제가
 * 아닐 수 있다. 라이브에서 이 에러를 보면 aside 브라우저/REPL 상태를 먼저 확인해야 한다.
 */
export class EvaluationFailedError extends Error {
  readonly step: string;
  readonly reason: string;

  constructor(step: string, reason: string) {
    super(`[${step}] 검사를 수행하지 못함(evaluate 실패): ${reason}`);
    this.name = 'EvaluationFailedError';
    this.step = step;
    this.reason = reason;
  }
}

/** D14: 카테고리 이름이 블로그의 카테고리 목록과 일치하지 않았다 — 기본 카테고리로 조용히 넘어가지 않는다. */
export class CategoryNotFoundError extends Error {
  readonly step: string;
  readonly requested: string;
  readonly available: string[];

  constructor(requested: string, available: string[]) {
    super(
      `[selectCategory] 카테고리 "${requested}" 를 찾지 못함. 사용 가능한 카테고리: ` +
        (available.length > 0 ? available.join(', ') : '(목록을 읽지 못함)'),
    );
    this.name = 'CategoryNotFoundError';
    this.step = 'selectCategory';
    this.requested = requested;
    this.available = available;
  }
}
