import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(testDir, '..', '..', 'scripts', 'setup.mjs');

async function readScript(): Promise<string> {
  return readFile(scriptPath, 'utf8');
}

// 방어적 가드: t5 D9 — 이 스크립트는 점검과 안내만 한다. 자격증명을 받지 않고 로그인을
// 자동으로 하지 않으며, 실패해도 파괴적 동작(삭제·덮어쓰기)을 하지 않는다. 실제 실행은
// tests/aside/naver-login-args.test.ts 와 같은 이유로 여기서 하지 않는다 — aside/claude
// 바이너리 유무에 좌우되지 않는 안정적인 텍스트 검사만 한다(도달 가능한 seam 이 없는 경우,
// wiki:testing-quality-source-text-wiring-assertions 는 이를 정당한 예외로 인정한다).

describe('setup.mjs — 자격증명 미참조', () => {
  test('비밀번호 관련 환경변수를 참조하지 않는다', async () => {
    const source = await readScript();
    expect(source).not.toMatch(/NAVER_PW|NAVER_PASSWORD|NAVER_PASS\b/i);
  });

  test('process.argv 로 비밀번호나 자격증명을 읽지 않는다', async () => {
    const source = await readScript();
    expect(source).not.toMatch(/process\.argv/);
  });

  test('표준입력으로 자격증명을 입력받지 않는다 (readline·stdin 미사용)', async () => {
    const source = await readScript();
    expect(source).not.toMatch(/readline|process\.stdin/);
  });
});

describe('setup.mjs — 자동 로그인·자동 입력 금지', () => {
  test('.fill( 로 어떤 필드도 자동으로 채우지 않는다', async () => {
    const source = await readScript();
    expect(source).not.toMatch(/\.fill\(/);
  });

  test('로그인 폼을 제출하는 evaluate 호출이 없다 (브라우저를 건드리지 않는다)', async () => {
    const source = await readScript();
    expect(source).not.toMatch(/\.evaluate\(|nidlogin/);
  });
});

describe('setup.mjs — 파괴적 동작 금지', () => {
  test('파일·디렉터리를 삭제하는 호출이 없다 (rm·unlink·rmdir)', async () => {
    const source = await readScript();
    expect(source).not.toMatch(/\brm\(|\bunlink\(|\brmdir\(|\brmSync\(|\bunlinkSync\(|\brmdirSync\(/);
  });

  test('디렉터리 생성은 재귀·비파괴적으로만 한다 (mkdir 은 있지만 { recursive: true } 없이 쓰지 않는다)', async () => {
    const source = await readScript();
    const mkdirCalls = source.match(/mkdir\([^)]*\)/g) ?? [];
    expect(mkdirCalls.length).toBeGreaterThan(0);
    for (const call of mkdirCalls) {
      expect(call).toMatch(/recursive:\s*true/);
    }
  });

  // 이 테스트 파일 자체도 grep -r 검사 대상이므로, 금지 문자열을 리터럴로 쓰지 않고
  // 조립해서 비교한다 (definition_of_done: 코드베이스 어디에도 해당 문자열이 없어야 한다).
  test('쿠키 저장소를 통째로 비우는 CDP 호출을 포함하지 않는다', async () => {
    const source = await readScript();
    const forbiddenCookieClearApi = ['clear', 'Cookies'].join('');
    expect(source.includes(forbiddenCookieClearApi)).toBe(false);
  });
});

describe('setup.mjs — npm install 을 대신 실행하지 않는다', () => {
  test('npm install 을 자동으로 실행하는 호출이 없다', async () => {
    const source = await readScript();
    expect(source).not.toMatch(/npm\s+(ci|install)/);
  });
});
