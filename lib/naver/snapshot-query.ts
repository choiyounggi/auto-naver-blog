// D5/D6: aside `snapshot(page, {...})` 가 돌려주는 접근성 트리 텍스트(`tree` 필드)에서
// role + 접근성 이름으로 요소의 ref 를 찾는 순수 함수 모음. 브라우저 접근이 전혀 없다 —
// 트리는 이미 문자열로 주어졌다고 가정한다. 트리 줄 형식은 t4/plan.md D6 가 명시한
// `- <role> "<name>" [ref=<id>]` 이며, iframe 안 요소는 `f1e1` 같은 ref 를 받는다
// (t1 measured_facts 3).
//
// 이름에 큰따옴표가 포함된 경우: `"..." [ref=` 시퀀스가 이름 안에 그대로 다시 나타나지 않는
// 한, non-greedy 매칭이 이름 전체(내부 따옴표 포함)를 올바르게 캡처한다 —
// snapshot-query.test.ts 의 경계값 테스트가 이를 고정한다.

const LINE_PATTERN = /^\s*-\s*(\S+)\s+"(.*?)"\s*\[ref=([A-Za-z0-9]+)\]\s*$/;

interface TreeEntry {
  role: string;
  name: string;
  ref: string;
}

function parseEntries(tree: string): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const line of tree.split('\n')) {
    const match = LINE_PATTERN.exec(line);
    if (!match) continue;
    const [, role, name, ref] = match;
    entries.push({ role, name, ref });
  }
  return entries;
}

/**
 * role 과 접근성 이름으로 ref 를 찾는다. `names` 는 후보 배열이며 앞에서부터 시도한다 —
 * 트리 안의 등장 순서가 아니라 `names` 배열의 순서를 우선한다. 못 찾으면 `null`.
 */
export function findRefByRoleAndName(tree: string, role: string, names: string[]): string | null {
  const entries = parseEntries(tree);
  for (const name of names) {
    const found = entries.find((entry) => entry.role === role && entry.name === name);
    if (found) return found.ref;
  }
  return null;
}

/** 주어진 role 을 가진 모든 요소의 ref 를 트리 등장 순서대로 돌려준다. */
export function findRefsByRole(tree: string, role: string): string[] {
  return parseEntries(tree)
    .filter((entry) => entry.role === role)
    .map((entry) => entry.ref);
}

/**
 * 주어진 role 을 가진 모든 요소의 { name, ref } 쌍을 트리 등장 순서대로 돌려준다.
 * D14: 카테고리 목록처럼 "이름으로 정확 일치시키고, 실패하면 가능한 이름 전체를 에러에
 * 담아야" 하는 경우에 쓴다 — ref 만으로는 어떤 이름이었는지 알 수 없다.
 */
export function findEntriesByRole(tree: string, role: string): Array<{ name: string; ref: string }> {
  return parseEntries(tree)
    .filter((entry) => entry.role === role)
    .map((entry) => ({ name: entry.name, ref: entry.ref }));
}

const DEFAULT_EXCERPT_CONTEXT_LINES = 5;

/**
 * 실패 메시지에 넣을 스냅샷 발췌. `needle` 을 포함하는 첫 줄 주변 `lines`줄(앞/뒤 각각)을
 * 돌려준다. `needle` 을 찾지 못하면 — 찾으려던 대상이 애초에 트리에 없다는 뜻이므로 —
 * 트리 맨 앞 `2*lines+1`줄을 대신 돌려준다(빈 문자열보다 사람이 판단할 근거가 된다).
 */
export function excerptAround(tree: string, needle: string, lines: number = DEFAULT_EXCERPT_CONTEXT_LINES): string {
  const allLines = tree.split('\n');
  const matchIndex = allLines.findIndex((line) => line.includes(needle));

  if (matchIndex === -1) {
    return allLines.slice(0, 2 * lines + 1).join('\n');
  }

  const start = Math.max(0, matchIndex - lines);
  const end = Math.min(allLines.length, matchIndex + lines + 1);
  return allLines.slice(start, end).join('\n');
}
