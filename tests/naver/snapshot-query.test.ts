import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { excerptAround, findEntriesByRole, findRefByRoleAndName, findRefsByRole } from '@/lib/naver/snapshot-query';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures');

async function loadFixture(name: string): Promise<string> {
  return readFile(path.join(fixturesDir, name), 'utf8');
}

describe('findRefByRoleAndName — 정상', () => {
  test('editor-ready 에서 발행 버튼 ref 를 찾아낸다', async () => {
    const tree = await loadFixture('editor-ready.snapshot.txt');
    const ref = findRefByRoleAndName(tree, 'button', ['발행']);
    expect(ref).toBe('f1e12');
  });

  test('iframe 안 요소의 f1e1 형태 ref 를 정확히 돌려준다', async () => {
    const tree = await loadFixture('editor-ready.snapshot.txt');
    const ref = findRefByRoleAndName(tree, 'textbox', ['제목을 입력하세요']);
    expect(ref).toBe('f1e7');
  });

  test('후보 이름 배열의 두 번째가 맞을 때 그것을 찾는다', () => {
    const tree = '- button "두 번째 이름" [ref=e5]';
    const ref = findRefByRoleAndName(tree, 'button', ['첫 번째 이름', '두 번째 이름']);
    expect(ref).toBe('e5');
  });

  test('팝업 노드가 앞에 섞여 있어도 iframe 안 필수 요소를 정확히 찾는다', async () => {
    const tree = await loadFixture('editor-with-popups.snapshot.txt');
    const ref = findRefByRoleAndName(tree, 'button', ['발행']);
    expect(ref).toBe('f1e12');
  });
});

describe('findRefByRoleAndName — 음성 대조 (D3)', () => {
  test('editor-missing-publish 에서 발행 버튼 조회는 null 을 돌려준다', async () => {
    const tree = await loadFixture('editor-missing-publish.snapshot.txt');
    const ref = findRefByRoleAndName(tree, 'button', ['발행', '발행하기']);
    expect(ref).toBeNull();
  });
});

describe('findRefByRoleAndName — 경계값', () => {
  test('빈 트리는 null 을 돌려준다', () => {
    expect(findRefByRoleAndName('', 'button', ['발행'])).toBeNull();
  });

  test('이름에 큰따옴표가 포함된 요소도 정확히 매칭한다', () => {
    const tree = '- text "길동 "테스트"" [ref=e5]';
    const ref = findRefByRoleAndName(tree, 'text', ['길동 "테스트"']);
    expect(ref).toBe('e5');
  });
});

describe('findRefsByRole', () => {
  test('editor-ready 의 카테고리 후보 3개를 모두 찾는다', async () => {
    const tree = await loadFixture('editor-ready.snapshot.txt');
    const refs = findRefsByRole(tree, 'listitem');
    expect(refs).toEqual(['f1e4', 'f1e5', 'f1e6']);
  });

  test('해당 role 이 없으면 빈 배열을 돌려준다', () => {
    expect(findRefsByRole('- button "발행" [ref=e1]', 'listitem')).toEqual([]);
  });
});

describe('findEntriesByRole (D14)', () => {
  test('editor-ready 의 카테고리 이름·ref 쌍을 모두 돌려준다', async () => {
    const tree = await loadFixture('editor-ready.snapshot.txt');
    const entries = findEntriesByRole(tree, 'listitem');
    expect(entries).toEqual([
      { name: '일상', ref: 'f1e4' },
      { name: '여행', ref: 'f1e5' },
      { name: '맛집', ref: 'f1e6' },
    ]);
  });

  test('해당 role 이 없으면 빈 배열을 돌려준다', () => {
    expect(findEntriesByRole('- button "발행" [ref=e1]', 'listitem')).toEqual([]);
  });
});

describe('excerptAround', () => {
  test('전체가 아니라 지정 줄 수만 돌려준다', async () => {
    const tree = await loadFixture('editor-ready.snapshot.txt');
    const fullLineCount = tree.split('\n').length;
    const excerpt = excerptAround(tree, 'button "발행"', 1);
    const excerptLineCount = excerpt.split('\n').length;
    expect(excerptLineCount).toBeLessThan(fullLineCount);
    expect(excerpt).toContain('발행');
  });

  test('needle 을 찾지 못하면 트리 앞부분을 대신 돌려준다(빈 문자열이 아니다)', async () => {
    const tree = await loadFixture('editor-ready.snapshot.txt');
    const excerpt = excerptAround(tree, '존재하지-않는-문자열', 2);
    expect(excerpt.length).toBeGreaterThan(0);
  });
});
