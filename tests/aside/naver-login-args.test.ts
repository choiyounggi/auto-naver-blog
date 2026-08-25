import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(testDir, '..', '..', 'scripts', 'naver-login.mjs');

async function readScript(): Promise<string> {
  return readFile(scriptPath, 'utf8');
}

// 방어적 가드: 이 스크립트는 사람이 직접 로그인해야 하며, 자격증명을 절대 자동으로
// 다루지 않는다(브리프 danger_zone·definition_of_done). 실제 실행은 사람이 한다.

describe('naver-login.mjs — 자격증명 미참조', () => {
  test('비밀번호 관련 환경변수를 참조하지 않는다', async () => {
    const source = await readScript();
    expect(source).not.toMatch(/NAVER_PW|NAVER_PASSWORD|NAVER_PASS\b/i);
  });

  test('process.argv 로 비밀번호를 읽지 않는다', async () => {
    const source = await readScript();
    expect(source).not.toMatch(/process\.argv/);
  });
});

describe('naver-login.mjs — 자동 입력 금지', () => {
  test('.fill(  로 비밀번호(또는 어떤) 필드도 자동으로 채우지 않는다', async () => {
    const source = await readScript();
    expect(source).not.toMatch(/\.fill\(/);
  });
});

describe('naver-login.mjs — 쿠키 삭제 API 미포함', () => {
  // 이 테스트 파일 자체도 grep -r 검사 대상이므로, 금지 문자열을 리터럴로 쓰지 않고
  // 조립해서 비교한다 (definition_of_done: 코드베이스 어디에도 해당 문자열이 없어야 한다).
  const forbiddenCookieClearApi = ['clear', 'Cookies'].join('');

  test('쿠키 저장소를 통째로 비우는 CDP 호출을 포함하지 않는다', async () => {
    const source = await readScript();
    expect(source.includes(forbiddenCookieClearApi)).toBe(false);
  });
});
