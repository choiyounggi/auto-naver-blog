import { spawn } from 'node:child_process';
import type { AppConfig } from '../config';

const CLAUDE_MODEL_ALIAS = 'sonnet';
const STDOUT_SNIPPET_LEN = 300;
const STDERR_SNIPPET_LEN = 500;

export interface ClaudeCallResult {
  ok: boolean;
  structuredOutput: unknown | null;
  model: string | null;
  error: string | null;
  costUsd: number | null;
}

export interface CallClaudeArgs {
  config: AppConfig;
  prompt: string;
  jsonSchema: unknown;
  allowDirs?: string[];
  timeoutMs?: number;
}

interface RawClaudeResponse {
  is_error?: unknown;
  terminal_reason?: unknown;
  structured_output?: unknown;
  permission_denials?: unknown;
  modelUsage?: unknown;
  total_cost_usd?: unknown;
  result?: unknown;
}

export async function callClaude(args: CallClaudeArgs): Promise<ClaudeCallResult> {
  const { config, prompt, jsonSchema, allowDirs = [], timeoutMs } = args;
  const effectiveTimeoutMs = timeoutMs ?? config.claudeTimeoutMs;

  const argv = [
    '-p',
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(jsonSchema),
    '--allowedTools',
    'Read',
    '--model',
    CLAUDE_MODEL_ALIAS,
    ...allowDirs.flatMap((dir) => ['--add-dir', dir]),
    // 실측(2026-08-25): `--add-dir` 는 가변인자(<directories...>)라 뒤따르는 위치인자를
    // 전부 디렉터리로 삼킨다. 그래서 프롬프트가 CLI 에 전달되지 않고 다음으로 죽었다:
    //   Error: Input must be provided either through stdin or as a prompt argument
    //   when using --print
    // `--` 로 옵션 파싱을 끊어야 그 뒤가 프롬프트로 남는다. 앞에 어떤 가변인자 옵션이
    // 오더라도 안전하므로 순서에 의존하지 않는 이 방식을 쓴다.
    '--',
    prompt,
  ];

  return new Promise((resolve) => {
    let settled = false;
    const stdoutChunks: Buffer[] = [];
    // D9 는 그대로다 — stderr 는 데이터 채널이 아니다. 다만 stdout 이 비어 실패했을 때
    // 사람이 원인을 볼 수 있도록 진단 문구에만 덧붙인다(실측: 빈 stdout 만으로는 아무것도
    // 알 수 없었다).
    const stderrChunks: Buffer[] = [];

    // D5b: -p is a policy flag only, not a guarantee the CLI never reads stdin —
    // detach fd 0 explicitly.
    const child = spawn(config.claudeBin, argv, { stdio: ['ignore', 'pipe', 'pipe'] });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      resolve({
        ok: false,
        structuredOutput: null,
        model: null,
        error: `claude CLI timed out after ${effectiveTimeoutMs}ms`,
        costUsd: null,
      });
    }, effectiveTimeoutMs);

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        structuredOutput: null,
        model: null,
        error: `failed to spawn claude CLI: ${err.message}`,
        costUsd: null,
      });
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      const exitInfo = `exit=${code ?? 'null'}${signal === null ? '' : ` signal=${signal}`}`;
      const stderrInfo =
        stderr === '' ? 'stderr=(비어 있음)' : `stderr=${stderr.slice(0, STDERR_SNIPPET_LEN)}`;

      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        resolve({
          ok: false,
          structuredOutput: null,
          model: null,
          error: `claude CLI stdout was not valid JSON (${exitInfo}, ${stderrInfo}) (stdout first ${STDOUT_SNIPPET_LEN} chars): ${stdout.slice(0, STDOUT_SNIPPET_LEN)}`,
          costUsd: null,
        });
        return;
      }

      if (parsed === null || typeof parsed !== 'object') {
        resolve({
          ok: false,
          structuredOutput: null,
          model: null,
          error: `claude CLI stdout parsed but was not a JSON object (${exitInfo}, ${stderrInfo}) (stdout first ${STDOUT_SNIPPET_LEN} chars): ${stdout.slice(0, STDOUT_SNIPPET_LEN)}`,
          costUsd: null,
        });
        return;
      }

      resolve(interpretResponse(parsed as RawClaudeResponse));
    });
  });
}

// D1: success requires is_error===false AND terminal_reason==='completed' AND
// structured_output present AND permission_denials empty — never subtype
// (measured: an auth failure reported subtype:"success" alongside is_error:true).
function interpretResponse(response: RawClaudeResponse): ClaudeCallResult {
  const costUsd = typeof response.total_cost_usd === 'number' ? response.total_cost_usd : null;
  const permissionDenials = Array.isArray(response.permission_denials) ? response.permission_denials : null;
  const resultText = typeof response.result === 'string' ? response.result : null;

  const failures: string[] = [];
  if (response.is_error !== false) {
    failures.push(`is_error=${JSON.stringify(response.is_error)}`);
  }
  if (response.terminal_reason !== 'completed') {
    failures.push(`terminal_reason=${JSON.stringify(response.terminal_reason)}`);
  }
  if (response.structured_output === null || response.structured_output === undefined) {
    failures.push('structured_output missing');
  }
  if (permissionDenials === null || permissionDenials.length > 0) {
    failures.push(`permission_denials=${JSON.stringify(response.permission_denials)}`);
  }

  if (failures.length > 0) {
    const diagnostics = [
      `failed: ${failures.join(', ')}`,
      resultText !== null ? `result=${JSON.stringify(resultText)}` : null,
      costUsd !== null ? `total_cost_usd=${costUsd}` : null,
    ].filter((part): part is string => part !== null);
    return {
      ok: false,
      structuredOutput: null,
      model: null,
      error: diagnostics.join(' | '),
      costUsd,
    };
  }

  const modelUsage = response.modelUsage;
  const model =
    modelUsage !== null && typeof modelUsage === 'object'
      ? (Object.keys(modelUsage as Record<string, unknown>)[0] ?? null)
      : null;

  return {
    ok: true,
    structuredOutput: response.structured_output,
    model,
    error: null,
    costUsd,
  };
}
