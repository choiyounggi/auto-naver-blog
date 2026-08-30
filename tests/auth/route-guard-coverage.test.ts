import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const apiRoot = path.join(repoRoot, 'app', 'api');

/**
 * 로그인하지 않은 사람도 부를 수 있어야 하는 경로. 여기 있는 것 말고는 전부 가드를 거쳐야 한다 —
 * 라우트를 새로 만들면서 가드를 빠뜨리는 것이 이 앱에서 가장 조용하고 위험한 실수다.
 */
const UNGUARDED_BY_DESIGN = new Set([
  'auth/login/route.ts', // 로그인하는 곳이므로 세션이 있을 리 없다 (속도 제한으로 보호한다)
  'auth/logout/route.ts', // 쿠키를 지우기만 한다
  'auth/session/route.ts', // 비밀번호 화면을 띄울지 정하는 곳. 비밀을 주지 않는다
]);

async function findRouteFiles(dir: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...(await findRouteFiles(path.join(dir, entry.name), relative)));
    else if (entry.name === 'route.ts') found.push(relative);
  }
  return found.sort();
}

describe('API 라우트 가드 누락 방지', () => {
  test('route.ts 를 실제로 찾는다 (이 테스트가 헛돌지 않는지 확인)', async () => {
    const files = await findRouteFiles(apiRoot);
    expect(files.length).toBeGreaterThanOrEqual(10);
    expect(files).toContain('jobs/route.ts');
  });

  test('모든 라우트가 requireUser/requireAdmin 을 거친다', async () => {
    const files = await findRouteFiles(apiRoot);
    const unguarded: string[] = [];
    for (const file of files) {
      if (UNGUARDED_BY_DESIGN.has(file)) continue;
      const source = await readFile(path.join(apiRoot, file), 'utf8');
      if (!/require(User|Admin)\(/.test(source)) unguarded.push(file);
    }
    expect(unguarded).toEqual([]);
  });

  test('네이버 계정을 건드리는 경로는 관리자 전용이다', async () => {
    for (const file of ['setup/login/route.ts', 'setup/relogin/route.ts']) {
      const source = await readFile(path.join(apiRoot, file), 'utf8');
      expect(source).toMatch(/requireAdmin\(/);
    }
  });

  test('예외 목록에 없는 파일이 목록에 남아 있지 않다 (경계값)', async () => {
    const files = new Set(await findRouteFiles(apiRoot));
    for (const allowed of UNGUARDED_BY_DESIGN) {
      expect(files.has(allowed)).toBe(true);
    }
  });
});
