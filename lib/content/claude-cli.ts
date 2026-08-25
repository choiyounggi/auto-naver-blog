import { spawn } from 'node:child_process';
import type { AppConfig } from '../config';

const CLAUDE_MODEL_ALIAS = 'sonnet';
const STDOUT_SNIPPET_LEN = 300;

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
    prompt,
  ];

  return new Promise((resolve) => {
    let settled = false;
    const stdoutChunks: Buffer[] = [];

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
    // stderr is not collected into the result; the CLI's JSON stdout is the
    // only channel this layer trusts (D9).
    child.stderr.resume();

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

    child.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      const stdout = Buffer.concat(stdoutChunks).toString('utf8');

      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        resolve({
          ok: false,
          structuredOutput: null,
          model: null,
          error: `claude CLI stdout was not valid JSON (first ${STDOUT_SNIPPET_LEN} chars): ${stdout.slice(0, STDOUT_SNIPPET_LEN)}`,
          costUsd: null,
        });
        return;
      }

      if (parsed === null || typeof parsed !== 'object') {
        resolve({
          ok: false,
          structuredOutput: null,
          model: null,
          error: `claude CLI stdout parsed but was not a JSON object (first ${STDOUT_SNIPPET_LEN} chars): ${stdout.slice(0, STDOUT_SNIPPET_LEN)}`,
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
