// D1: 센티넬은 정규식이 아니라 고정 문자열 부분일치로 찾는다. `[ok | ...]`를 정규식으로 쓰면
// POSIX 브래킷 표현식이 되어 'o'/'k' 한 글자에도 매치되므로 절대 쓰지 않는다.

const ANSI_ESCAPE = /\x1b\[[0-9;]*m/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_ESCAPE, '');
}

export function stripPrompt(s: string): string {
  return s.split('repl > ').join('');
}

const OK_MARKER = '[ok | ';
const ERROR_MARKER = '[error | ';
const DURATION_SUFFIX = 'ms]';

function findMarker(
  text: string,
  marker: string,
  kind: 'ok' | 'error',
): { kind: 'ok' | 'error'; durationMs: number; index: number; end: number } | null {
  const start = text.indexOf(marker);
  if (start === -1) return null;
  const durationStart = start + marker.length;
  const suffixIndex = text.indexOf(DURATION_SUFFIX, durationStart);
  if (suffixIndex === -1) return null;
  const durationText = text.slice(durationStart, suffixIndex);
  if (!/^[0-9]+$/.test(durationText)) return null;
  return {
    kind,
    durationMs: Number(durationText),
    index: start,
    end: suffixIndex + DURATION_SUFFIX.length,
  };
}

export function findSentinel(
  text: string,
): { kind: 'ok' | 'error'; durationMs: number; index: number; end: number } | null {
  const clean = stripAnsi(text);
  const ok = findMarker(clean, OK_MARKER, 'ok');
  const error = findMarker(clean, ERROR_MARKER, 'error');
  if (ok && error) return ok.index <= error.index ? ok : error;
  return ok ?? error;
}

// aside repl 은 일부 헬퍼(openTab 등)에서 사람이 읽는 배너를 stdout 에 먼저 찍는다
// (예: "✔︎ Opened a new tab and set it active: ..."). 그래서 stdout 전체를 JSON.parse 하면
// 실패한다 — 스텝이 마지막에 찍은 JSON 한 줄만 골라낸다.
export function parseLastJson<T>(stdout: string): T | null {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.startsWith('{') && !line.startsWith('[')) continue;
    try {
      return JSON.parse(line) as T;
    } catch {
      // 이 줄은 JSON 이 아니다 — 앞줄로 계속 올라간다
    }
  }
  return null;
}
