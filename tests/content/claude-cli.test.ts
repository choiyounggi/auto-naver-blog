import { execSync } from 'node:child_process';
import { chmodSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, test } from 'vitest';
import type { AppConfig } from '@/lib/config';
import { callClaude } from '@/lib/content/claude-cli';
import authFailureFixture from './fixtures/auth-failure.json';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE_PATH = path.join(here, 'fake-claude.mjs');

// Grants exec permission programmatically (no shell `chmod +x` invocation) so
// the double can be spawned directly via its `#!/usr/bin/env node` shebang.
beforeAll(() => {
  chmodSync(FAKE_CLAUDE_PATH, 0o755);
});

function fakeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    dataDir: '/tmp/unused-in-this-test',
    claudeBin: FAKE_CLAUDE_PATH,
    asideBin: 'aside',
    naverBlogId: null,
    cookieFile: '/tmp/unused-in-this-test/cookies.json',
    claudeTimeoutMs: 5000,
    asideStepTimeoutMs: 60000,
    ...overrides,
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('callClaude — 정상', () => {
  test('success.json 픽스처: ok===true, 실제 모델명, structuredOutput 객체', async () => {
    const result = await callClaude({
      config: fakeConfig(),
      prompt: 'FAKE_MODE:success',
      jsonSchema: {},
    });

    expect(result.ok).toBe(true);
    expect(result.model).toBe('claude-sonnet-5');
    expect(typeof result.structuredOutput).toBe('object');
    expect(result.structuredOutput).not.toBeNull();
    expect(result.error).toBeNull();
  });
});

describe('callClaude — 에러', () => {
  test('auth-failure.json: subtype이 "success"여도 is_error:true면 ok===false다 (D1 회귀 방어)', async () => {
    // 이 단언이 무너지면(픽스처가 더 이상 subtype:"success"를 갖지 않으면) 아래
    // ok===false 검증도 D1을 더 이상 방어하지 못한다는 뜻이므로 픽스처를 고쳐야 한다.
    expect(authFailureFixture.subtype).toBe('success');
    expect(authFailureFixture.is_error).toBe(true);

    const result = await callClaude({
      config: fakeConfig(),
      prompt: 'FAKE_MODE:auth-failure',
      jsonSchema: {},
    });

    expect(result.ok).toBe(false);
    expect(result.structuredOutput).toBeNull();
  });

  test('no-structured-output.json: structured_output 누락이면 ok===false이고 사유가 드러난다', async () => {
    const result = await callClaude({
      config: fakeConfig(),
      prompt: 'FAKE_MODE:no-structured-output',
      jsonSchema: {},
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('structured_output');
    expect(result.error).not.toContain('permission_denials');
  });

  test('denied.json: permission_denials가 비어 있지 않으면 ok===false이고 사유가 드러난다', async () => {
    const result = await callClaude({
      config: fakeConfig(),
      prompt: 'FAKE_MODE:denied',
      jsonSchema: {},
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('permission_denials');
    expect(result.error).not.toContain('structured_output missing');
  });

  test('비-JSON 출력: ok===false이고 사유가 파싱 실패를 가리키며 다른 사유들과 다르다', async () => {
    const result = await callClaude({
      config: fakeConfig(),
      prompt: 'FAKE_MODE:garbage',
      jsonSchema: {},
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('not valid JSON');
    expect(result.error).not.toContain('structured_output');
    expect(result.error).not.toContain('permission_denials');
  });
});

describe('callClaude — 경계값/타임아웃', () => {
  test('오래 자는 모드 + 짧은 timeoutMs: ok===false이고 사유가 타임아웃을 가리키며 다른 사유들과 다르다', async () => {
    const result = await callClaude({
      config: fakeConfig(),
      prompt: 'FAKE_MODE:sleep',
      jsonSchema: {},
      timeoutMs: 200,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('timed out');
    expect(result.error).not.toContain('not valid JSON');
    expect(result.error).not.toContain('permission_denials');
  });

  test('타임아웃 후 자식 프로세스가 남아 있지 않다', async () => {
    await callClaude({
      config: fakeConfig(),
      prompt: 'FAKE_MODE:sleep',
      jsonSchema: {},
      timeoutMs: 200,
    });

    // SIGTERM 처리가 끝날 시간을 준 뒤, 프로세스 목록에 fake-claude.mjs가 없는지 확인한다.
    await wait(300);
    const psOutput = execSync('ps -ax -o command').toString();
    expect(psOutput).not.toContain('fake-claude.mjs');
  });
});
