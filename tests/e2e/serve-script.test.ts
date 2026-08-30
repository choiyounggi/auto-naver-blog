import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { DEFAULT_HOST, readEnvFileValue, resolveBindHost } from '@/scripts/serve.mjs';

const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'serve.mjs');

describe('resolveBindHost — 정상', () => {
  test('아무것도 없으면 루프백에 바인딩한다', () => {
    expect(resolveBindHost({}, null)).toBe(DEFAULT_HOST);
    expect(DEFAULT_HOST).toBe('127.0.0.1');
  });

  test('.env 의 ANB_HOST 를 읽는다 (셸에 export 하지 않아도 반영된다)', () => {
    expect(resolveBindHost({}, 'ANB_HOST=0.0.0.0\n')).toBe('0.0.0.0');
  });

  test('셸 환경변수가 .env 보다 우선한다', () => {
    expect(resolveBindHost({ ANB_HOST: '192.168.0.10' }, 'ANB_HOST=0.0.0.0\n')).toBe('192.168.0.10');
  });
});

describe('resolveBindHost — 경계값', () => {
  test('빈 값·공백은 설정하지 않은 것으로 본다', () => {
    expect(resolveBindHost({ ANB_HOST: '   ' }, null)).toBe(DEFAULT_HOST);
    expect(resolveBindHost({}, 'ANB_HOST=\n')).toBe(DEFAULT_HOST);
    expect(resolveBindHost({}, 'ANB_HOST="  "\n')).toBe(DEFAULT_HOST);
  });

  test('다른 키·주석은 무시한다', () => {
    expect(resolveBindHost({}, '# ANB_HOST=0.0.0.0\nANB_DATA_DIR=/tmp/x\n')).toBe(DEFAULT_HOST);
  });

  test('readEnvFileValue 는 없는 키에 null 을 준다', () => {
    expect(readEnvFileValue('A=1\n', 'ANB_HOST')).toBeNull();
    expect(readEnvFileValue('', 'ANB_HOST')).toBeNull();
    expect(readEnvFileValue('ANB_HOST="0.0.0.0"', 'ANB_HOST')).toBe('0.0.0.0');
  });
});

// 안전 계약: 이 스크립트는 바인딩 주소만 정한다. 인증 판정은 lib/auth/config.ts 한 곳에만
// 있어야 하므로, 여기서 비밀번호를 읽거나 검사를 흉내 내면 규칙이 두 곳으로 갈라진다.
describe('serve.mjs — 자격증명 미참조', () => {
  test('비밀번호·서명 키 환경변수를 읽지 않는다', async () => {
    const source = await readFile(scriptPath, 'utf8');
    expect(source).not.toMatch(/ANB_ACCESS_PASSWORD|ANB_ADMIN_PASSWORD|ANB_SESSION_SECRET/);
  });

  test('바인딩 주소를 자식 프로세스에 그대로 넘긴다 (부팅 검사가 같은 값을 본다)', async () => {
    const source = await readFile(scriptPath, 'utf8');
    expect(source).toMatch(/ANB_HOST: host/);
    expect(source).toMatch(/'-H', host/);
  });
});
