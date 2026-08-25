import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AppConfig } from '../config';
import type { AsideEvalResult, AsideReplApi } from '../types';
import { findSentinel, stripAnsi, stripPrompt } from './protocol';

const FORCE_KILL_GRACE_MS = 3000;

interface PendingStep {
  resolve: (result: AsideEvalResult) => void;
  buffer: string;
  timer: NodeJS.Timeout | null;
  settled: boolean;
  startedAt: number;
}

interface QueuedStep {
  js: string;
  timeoutMs: number;
  resolve: (result: AsideEvalResult) => void;
}

// D6/F1: 채널은 항상 이 네 상태 중 하나다.
// - idle: 다음 큐 항목을 즉시 시작할 수 있다.
// - busy: 스텝 하나가 진행 중이고, 그 스텝의 센티넬을 기다리는 중이다.
// - draining: 스텝이 타임아웃으로 버려졌지만, 그 스텝이 뒤늦게 보낼 센티넬이 아직 채널에
//   남아있을 수 있다. 그 센티넬이 도착(또는 드레이닝 자체가 시간 초과)할 때까지는 다음 큐
//   항목을 시작하지 않는다 — 그래야 뒤늦은 출력이 다음 evaluate() 결과로 새지 않는다.
// - poisoned: 채널과 REPL 프로세스의 동기화를 더 이상 신뢰할 수 없다. 이후 evaluate() 는
//   즉시 실패한다 — dispose() 후 재시작해야 한다.
type ChannelState =
  | { kind: 'idle' }
  | { kind: 'busy'; step: PendingStep }
  | { kind: 'draining'; buffer: string; timer: NodeJS.Timeout }
  | { kind: 'poisoned'; reason: string };

export class AsideRepl implements AsideReplApi {
  private readonly config: AppConfig;
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready = false;
  private state: ChannelState = { kind: 'idle' };
  private readonly queue: QueuedStep[] = [];
  private disposed = false;

  constructor(config: AppConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    if (this.child) {
      throw new Error('AsideRepl.start() 는 한 번만 호출한다');
    }

    return new Promise<void>((resolve, reject) => {
      // D12: 테스트는 config.asideBin 에 `${process.execPath} <가짜 REPL 경로>` 처럼
      // 공백으로 구분된 커맨드를 주입한다 — 가짜 스크립트는 실행 권한 없이 `node <path>` 로만
      // 실행되어야 하므로(Task 02), asideBin 을 그대로 실행 파일로 spawn 할 수 없다.
      const [cmd, ...leadingArgs] = this.config.asideBin.trim().split(/\s+/);
      const child = spawn(cmd, [...leadingArgs, 'repl'], { stdio: ['pipe', 'pipe', 'pipe'] });
      this.child = child;

      let startSettled = false;
      let readyBuf = '';

      const readyTimer = setTimeout(() => {
        if (startSettled) return;
        startSettled = true;
        child.stdout.off('data', onReadyData);
        reject(new Error(`aside repl 준비 대기 타임아웃 (${this.config.asideStepTimeoutMs}ms)`));
      }, this.config.asideStepTimeoutMs);

      const onReadyData = (chunk: Buffer): void => {
        readyBuf += chunk.toString('utf8');
        if (!stripAnsi(readyBuf).includes('repl > ')) return;
        if (startSettled) return;
        startSettled = true;
        clearTimeout(readyTimer);
        child.stdout.off('data', onReadyData);
        this.ready = true;
        child.stdout.on('data', (c: Buffer) => this.onStdout(c));
        resolve();
      };
      child.stdout.on('data', onReadyData);

      child.on('exit', (code, signal) => {
        if (!startSettled) {
          startSettled = true;
          clearTimeout(readyTimer);
          reject(new Error(`aside repl 이 준비되기 전 종료됨 (code=${code}, signal=${signal})`));
          return;
        }
        this.handleProcessExit(code, signal);
      });

      child.on('error', (err) => {
        if (startSettled) return;
        startSettled = true;
        clearTimeout(readyTimer);
        reject(err);
      });
    });
  }

  async evaluate(js: string, opts?: { timeoutMs?: number }): Promise<AsideEvalResult> {
    if (this.state.kind === 'poisoned') {
      return { ok: false, stdout: '', durationMs: 0, error: this.state.reason };
    }
    if (!this.child || !this.ready) {
      return {
        ok: false,
        stdout: '',
        durationMs: 0,
        error: 'aside repl 이 준비되지 않음 (start() 가 완료되지 않았거나 실패함)',
      };
    }
    const timeoutMs = opts?.timeoutMs ?? this.config.asideStepTimeoutMs;
    return new Promise<AsideEvalResult>((resolve) => {
      this.queue.push({ js, timeoutMs, resolve });
      this.pump();
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    const child = this.child;

    if (this.state.kind === 'busy') {
      const step = this.state.step;
      if (!step.settled) {
        step.settled = true;
        if (step.timer) clearTimeout(step.timer);
        step.resolve({
          ok: false,
          stdout: '',
          durationMs: Date.now() - step.startedAt,
          error: 'aside repl 이 dispose 되어 스텝이 중단됨',
        });
      }
    }
    this.poison('aside repl 이 dispose 됨 — 재사용하려면 새 인스턴스를 만드세요');

    if (!child) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }

    await new Promise<void>((resolve) => {
      const forceKillTimer = setTimeout(() => {
        child.kill('SIGKILL');
      }, FORCE_KILL_GRACE_MS);
      child.once('exit', () => {
        clearTimeout(forceKillTimer);
        resolve();
      });
      try {
        child.stdin.end();
      } catch {
        // stdin 이 이미 닫혀 있을 수 있다 — 무시하고 종료를 기다린다
      }
    });
  }

  private pump(): void {
    if (this.state.kind !== 'idle') return;
    const next = this.queue.shift();
    if (!next) return;
    this.runStep(next.js, next.timeoutMs, next.resolve);
  }

  // F1: 채널을 오염 상태로 표시하고, 아직 실행되지 않은 큐 항목들도 즉시 같은 사유로 실패
  // 처리한다 — 그 항목들은 어차피 신뢰할 수 없는 채널에 쓰여선 안 된다. 이미 오염된 채널을
  // 다시 오염시키지 않는다(최초 사유를 보존).
  private poison(reason: string): void {
    if (this.state.kind === 'poisoned') return;
    if (this.state.kind === 'draining') clearTimeout(this.state.timer);
    this.state = { kind: 'poisoned', reason };

    const pending = this.queue.splice(0);
    for (const item of pending) {
      item.resolve({ ok: false, stdout: '', durationMs: 0, error: reason });
    }
  }

  // F1: 타임아웃된 스텝의 센티넬이 아직 채널에 남아있을 수 있으므로, 그것이 도착(또는
  // 시간 초과)할 때까지 다음 스텝을 시작하지 않는다.
  private enterDraining(): void {
    const timer = setTimeout(() => {
      this.poison('REPL 동기화 상실 — dispose 후 재시작 필요 (드레이닝 타임아웃)');
    }, this.config.asideStepTimeoutMs);
    this.state = { kind: 'draining', buffer: '', timer };
  }

  private runStep(js: string, timeoutMs: number, resolve: (result: AsideEvalResult) => void): void {
    const startedAt = Date.now();
    const step: PendingStep = {
      resolve,
      buffer: '',
      timer: null,
      settled: false,
      startedAt,
    };
    this.state = { kind: 'busy', step };

    step.timer = setTimeout(() => {
      if (step.settled) return;
      step.settled = true;
      step.resolve({
        ok: false,
        stdout: '',
        durationMs: Date.now() - startedAt,
        error: `timeout after ${timeoutMs}ms`,
      });
      this.enterDraining();
    }, timeoutMs);

    const line = js.replace(/\r?\n/g, ' ');
    try {
      this.child!.stdin.write(`${line}\n`);
    } catch (err) {
      if (step.settled) return;
      step.settled = true;
      if (step.timer) clearTimeout(step.timer);
      const reason = `stdin 쓰기 실패 (프로세스 사망 가능성): ${(err as Error).message}`;
      step.resolve({ ok: false, stdout: '', durationMs: Date.now() - startedAt, error: reason });
      this.poison(reason);
    }
  }

  private onStdout(chunk: Buffer): void {
    if (this.state.kind === 'draining') {
      this.state.buffer += chunk.toString('utf8');
      const clean = stripAnsi(this.state.buffer);
      const sentinel = findSentinel(clean);
      if (sentinel) {
        clearTimeout(this.state.timer);
        this.state = { kind: 'idle' };
        this.pump();
      }
      return; // 드레이닝 중에는 내용을 그 무엇의 결과로도 쓰지 않는다 — 버린다
    }

    if (this.state.kind !== 'busy') return; // idle/poisoned — 대응할 스텝이 없다, 폐기

    const step = this.state.step;
    step.buffer += chunk.toString('utf8');
    const clean = stripAnsi(step.buffer);
    const sentinel = findSentinel(clean);
    if (!sentinel) return;

    step.settled = true;
    if (step.timer) clearTimeout(step.timer);
    this.state = { kind: 'idle' };

    const stdout = stripPrompt(clean.slice(0, sentinel.index)).trim();
    if (sentinel.kind === 'ok') {
      step.resolve({ ok: true, stdout, durationMs: sentinel.durationMs, error: null });
    } else {
      step.resolve({
        ok: false,
        stdout,
        durationMs: sentinel.durationMs,
        error: `script failed: [error | ${sentinel.durationMs}ms]`,
      });
    }
    this.pump();
  }

  private handleProcessExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.ready = false;
    const reason = `process exited unexpectedly (code=${code}, signal=${signal})`;

    if (this.state.kind === 'busy') {
      const step = this.state.step;
      if (!step.settled) {
        step.settled = true;
        if (step.timer) clearTimeout(step.timer);
        step.resolve({
          ok: false,
          stdout: stripPrompt(stripAnsi(step.buffer)).trim(),
          durationMs: Date.now() - step.startedAt,
          error: reason,
        });
      }
    }
    this.poison(reason);
  }
}
