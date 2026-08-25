// D3/제약: 실제 브라우저를 절대 띄우지 않는 인메모리 가짜 AsideReplApi. evaluate() 가
// 미리 정한 AsideEvalResult 를 돌려주게 한다.
import type { AsideEvalResult, AsideReplApi } from '@/lib/types';

export interface RecordedCall {
  js: string;
  timeoutMs?: number;
}

export type ReplHandler = (js: string, call: RecordedCall, index: number) => AsideEvalResult;

export class FakeAsideReplApi implements AsideReplApi {
  readonly calls: RecordedCall[] = [];
  private readonly handler: ReplHandler;

  constructor(handler: ReplHandler) {
    this.handler = handler;
  }

  async start(): Promise<void> {}
  async dispose(): Promise<void> {}

  async evaluate(js: string, opts?: { timeoutMs?: number }): Promise<AsideEvalResult> {
    const call: RecordedCall = { js, timeoutMs: opts?.timeoutMs };
    const index = this.calls.length;
    this.calls.push(call);
    return this.handler(js, call, index);
  }
}

export function okResult(stdout: string): AsideEvalResult {
  return { ok: true, stdout, durationMs: 1, error: null };
}

export function failResult(error: string): AsideEvalResult {
  return { ok: false, stdout: '', durationMs: 1, error };
}

/** 호출 순서대로 미리 정한 응답을 하나씩 돌려준다. 준비된 것보다 호출이 많으면 던진다. */
export function sequenceRepl(responses: AsideEvalResult[]): FakeAsideReplApi {
  return new FakeAsideReplApi((js, _call, index) => {
    if (index >= responses.length) {
      throw new Error(
        `FakeAsideReplApi: 준비된 응답(${responses.length}개)보다 evaluate 호출이 많음 (호출 #${index + 1}): ${js.slice(0, 200)}`,
      );
    }
    return responses[index];
  });
}

export function treeResult(tree: string): AsideEvalResult {
  return okResult(JSON.stringify({ tree }));
}
