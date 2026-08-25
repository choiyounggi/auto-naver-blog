import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from '../config';
import { JobStateSchema, type JobPhase, type JobState, type PostInput } from '../types';
import { assertSafeJobDir } from './paths';

// D13: 합법 전이만 허용한다. 선형 체인을 따라 한 칸씩만 전진할 수 있고,
// failed/cancelled 로는 (터미널 상태가 아닌 한) 어디서든 갈 수 있다.
const CHAIN: JobPhase[] = [
  'created',
  'analyzing',
  'drafting',
  'draft_ready',
  'filling_editor',
  'awaiting_approval',
  'publishing',
  'published',
];
const TERMINAL_PHASES: ReadonlySet<JobPhase> = new Set(['published', 'failed', 'cancelled']);

function isLegalTransition(from: JobPhase, to: JobPhase): boolean {
  if (TERMINAL_PHASES.has(from)) return false;
  if (to === 'failed' || to === 'cancelled') return true;
  const fromIndex = CHAIN.indexOf(from);
  const toIndex = CHAIN.indexOf(to);
  if (fromIndex === -1 || toIndex === -1) return false;
  return toIndex === fromIndex + 1;
}

// D5/runtime-validation: state.json도 경계를 넘어온 데이터다. 파싱 실패는
// null(=존재하지 않음)과 구분되는 에러로 표면화한다.
export class JobStoreParseError extends Error {
  constructor(jobId: string, cause: unknown) {
    super(`JobStore: state.json for job '${jobId}' is not valid JobState — ${String(cause)}`);
    this.name = 'JobStoreParseError';
    this.cause = cause;
  }
}

export class JobStore {
  // 메모리 Map은 캐시일 뿐이다 — 없으면 디스크에서 읽는다 (D15)
  private readonly cache = new Map<string, JobState>();

  constructor(private readonly config: AppConfig) {}

  // r2 리뷰 F2: id로 경로를 조립하는 곳은 upload.ts의 resolveImagePathWithin과
  // 여기 하나로 모은다 — 둘 다 assertSafeJobDir을 거친다.
  private jobDir(id: string): string {
    return assertSafeJobDir(this.config.dataDir, id);
  }

  private stateFile(id: string): string {
    return path.join(this.jobDir(id), 'state.json');
  }

  async create(input: PostInput): Promise<JobState> {
    const now = new Date().toISOString();
    const state: JobState = {
      id: input.jobId,
      phase: 'created',
      input,
      draft: null,
      preview: null,
      result: null,
      error: null,
      log: [],
      updatedAt: now,
    };
    await this.persist(state);
    return state;
  }

  async get(id: string): Promise<JobState | null> {
    const cached = this.cache.get(id);
    if (cached) return cached;

    let raw: string;
    try {
      raw = await readFile(this.stateFile(id), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch (err) {
      throw new JobStoreParseError(id, err);
    }

    const result = JobStateSchema.safeParse(parsedJson);
    if (!result.success) {
      throw new JobStoreParseError(id, result.error);
    }

    this.cache.set(id, result.data);
    return result.data;
  }

  private async requireExisting(id: string): Promise<JobState> {
    const state = await this.get(id);
    if (!state) {
      throw new Error(`JobStore: job '${id}' does not exist`);
    }
    return state;
  }

  async transition(id: string, next: JobPhase, message: string): Promise<JobState> {
    const state = await this.requireExisting(id);
    if (!isLegalTransition(state.phase, next)) {
      throw new Error(`JobStore: illegal transition '${state.phase}' -> '${next}' for job '${id}'`);
    }
    const now = new Date().toISOString();
    const nextState: JobState = {
      ...state,
      phase: next,
      log: [...state.log, { at: now, phase: next, message }],
      updatedAt: now,
    };
    await this.persist(nextState);
    return nextState;
  }

  async patch(
    id: string,
    fields: Partial<Pick<JobState, 'draft' | 'preview' | 'result' | 'error'>>,
  ): Promise<JobState> {
    const state = await this.requireExisting(id);
    const nextState: JobState = { ...state, ...fields, updatedAt: new Date().toISOString() };
    await this.persist(nextState);
    return nextState;
  }

  async appendLog(id: string, message: string): Promise<JobState> {
    const state = await this.requireExisting(id);
    const now = new Date().toISOString();
    const nextState: JobState = {
      ...state,
      log: [...state.log, { at: now, phase: state.phase, message }],
      updatedAt: now,
    };
    await this.persist(nextState);
    return nextState;
  }

  // D15: 임시 파일에 쓴 뒤 rename — 읽는 쪽이 반쯤 쓰인 JSON을 보지 않는다
  private async persist(state: JobState): Promise<void> {
    const dir = this.jobDir(state.id);
    await mkdir(dir, { recursive: true });
    const file = this.stateFile(state.id);
    const tmp = path.join(dir, `.state.json.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
    await rename(tmp, file);
    this.cache.set(state.id, state);
  }
}
