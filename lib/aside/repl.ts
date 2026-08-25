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

// D6: 큐에 쌓인 다음 작업을 실행할지 결정하는 순수 디스패치 함수. `current`가 null 이어야
// 다음 스텝을 시작한다 — 타임아웃으로 스텝이 버려진 뒤에도 이 불변식을 지켜야
// 뒤늦게 도착한 센티넬이 다음 evaluate() 결과로 잘못 소비되지 않는다.

export class AsideRepl implements AsideReplApi {
  private readonly config: AppConfig;
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready = false;
  private current: PendingStep | null = null;
  private readonly queue: Array<() => void> = [];
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
      this.queue.push(() => this.runStep(js, timeoutMs, resolve));
      this.pump();
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    const child = this.child;
    if (!child) return;

    if (this.current && !this.current.settled) {
      const step = this.current;
      step.settled = true;
      if (step.timer) clearTimeout(step.timer);
      this.current = null;
      step.resolve({
        ok: false,
        stdout: '',
        durationMs: Date.now() - step.startedAt,
        error: 'aside repl 이 dispose 되어 스텝이 중단됨',
      });
    }

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
    if (this.current) return;
    const next = this.queue.shift();
    if (next) next();
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
    this.current = step;

    step.timer = setTimeout(() => {
      if (step.settled) return;
      step.settled = true;
      // D6: 이 스텝을 버려진 것으로 표시 — 뒤늦게 도착하는 센티넬이 다음 evaluate() 결과로
      // 잘못 소비되지 않도록 current 를 즉시 비운다.
      this.current = null;
      step.resolve({
        ok: false,
        stdout: '',
        durationMs: Date.now() - startedAt,
        error: `timeout after ${timeoutMs}ms`,
      });
      this.pump();
    }, timeoutMs);

    const line = js.replace(/\r?\n/g, ' ');
    try {
      this.child!.stdin.write(`${line}\n`);
    } catch (err) {
      if (step.settled) return;
      step.settled = true;
      if (step.timer) clearTimeout(step.timer);
      this.current = null;
      step.resolve({
        ok: false,
        stdout: '',
        durationMs: Date.now() - startedAt,
        error: `stdin 쓰기 실패 (프로세스 사망 가능성): ${(err as Error).message}`,
      });
      this.pump();
    }
  }

  private onStdout(chunk: Buffer): void {
    const step = this.current;
    if (!step || step.settled) return; // 버려진 스텝의 늦은 출력 — 폐기 (D6)

    step.buffer += chunk.toString('utf8');
    const clean = stripAnsi(step.buffer);
    const sentinel = findSentinel(clean);
    if (!sentinel) return;

    step.settled = true;
    if (step.timer) clearTimeout(step.timer);
    this.current = null;

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
    const step = this.current;
    if (step && !step.settled) {
      step.settled = true;
      if (step.timer) clearTimeout(step.timer);
      this.current = null;
      step.resolve({
        ok: false,
        stdout: stripPrompt(stripAnsi(step.buffer)).trim(),
        durationMs: Date.now() - step.startedAt,
        error: `process exited unexpectedly (code=${code}, signal=${signal})`,
      });
    }
  }
}
