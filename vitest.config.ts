import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // 보안 정책: 임시/캐시 파일은 /tmp·$TMPDIR 이 아니라 프로젝트 내부에만 만든다
  cacheDir: './.vitest-tmp/',
  resolve: {
    alias: {
      '@': rootDir,
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
