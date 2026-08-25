import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const AppConfigSchema = z.object({
  dataDir: z.string(),
  claudeBin: z.string(),
  asideBin: z.string(),
  naverBlogId: z.string().nullable(),
  cookieFile: z.string(),
  claudeTimeoutMs: z.number().int().positive(),
  asideStepTimeoutMs: z.number().int().positive(),
});
export type AppConfig = z.infer<typeof AppConfigSchema>;

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(moduleDir);

// F2: repoRoot is derived from import.meta.url, which would silently point inside a
// bundled output dir (e.g. .next/server/...) if a future bundler ever relocates this
// module. Fail loudly at startup instead of writing data under the wrong root.
function assertRepoRootSane(): void {
  const marker = path.join(repoRoot, 'package.json');
  if (!existsSync(marker)) {
    throw new Error(
      `Could not confirm repoRoot: no package.json found at '${repoRoot}' ` +
        `(derived from the config module's location, expected '${marker}'). ` +
        'Set ANB_DATA_DIR (and ANB_COOKIE_FILE, if used) to an explicit absolute path to bypass repo-root inference.',
    );
  }
}

// D5a: 원시값 → `~` 확장 → 절대경로 검사 → 아니면 throw (에러 메시지에는 원시값 그대로)
function resolvePathValue(raw: string, envVarName: string): string {
  const expanded = raw.startsWith('~') ? path.join(os.homedir(), raw.slice(1)) : raw;
  if (!path.isAbsolute(expanded)) {
    throw new Error(`${envVarName} must be an absolute path, got: '${raw}'`);
  }
  return path.normalize(expanded);
}

// 양의 정수만 허용 (0, 음수, 비숫자, 빈 문자열 모두 거부)
function parsePositiveIntMs(raw: string, envVarName: string): number {
  if (!/^[0-9]+$/.test(raw) || Number(raw) <= 0) {
    throw new Error(`${envVarName} must be a positive integer, got: '${raw}'`);
  }
  return Number(raw);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // F5: only require a sane repoRoot when it is actually about to be consumed — an
  // explicit ANB_DATA_DIR bypasses repo-root inference entirely, and defaultCookieFile
  // below derives from the resolved dataDir (not repoRoot directly), so it needs no
  // separate check.
  if (env.ANB_DATA_DIR === undefined) {
    assertRepoRootSane();
  }

  const defaultDataDir = path.join(repoRoot, 'data');
  const dataDir = resolvePathValue(env.ANB_DATA_DIR ?? defaultDataDir, 'ANB_DATA_DIR');

  const claudeBin = env.ANB_CLAUDE_BIN ?? 'claude';
  const asideBin = env.ANB_ASIDE_BIN ?? 'aside';
  const naverBlogId = env.NAVER_BLOG_ID ?? null;

  const defaultCookieFile = path.join(dataDir, 'naver-cookies.json');
  const cookieFile = resolvePathValue(env.ANB_COOKIE_FILE ?? defaultCookieFile, 'ANB_COOKIE_FILE');

  const claudeTimeoutMs = parsePositiveIntMs(env.ANB_CLAUDE_TIMEOUT_MS ?? '600000', 'ANB_CLAUDE_TIMEOUT_MS');
  const asideStepTimeoutMs = parsePositiveIntMs(
    env.ANB_ASIDE_STEP_TIMEOUT_MS ?? '60000',
    'ANB_ASIDE_STEP_TIMEOUT_MS',
  );

  return AppConfigSchema.parse({
    dataDir,
    claudeBin,
    asideBin,
    naverBlogId,
    cookieFile,
    claudeTimeoutMs,
    asideStepTimeoutMs,
  });
}
