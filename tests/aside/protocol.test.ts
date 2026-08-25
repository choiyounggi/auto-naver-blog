import { describe, expect, test } from 'vitest';
import { findSentinel, parseLastJson, stripAnsi, stripPrompt } from '@/lib/aside/protocol';

// 실측 바이트 그대로 (브리프 measured_facts 2)
const OK_SENTINEL = '\x1b[2m[ok | 87ms]\x1b[0m';
const OK_SENTINEL_447 = '\x1b[2m[ok | 447ms]\x1b[0m';
const ERROR_SENTINEL = '\x1b[31m[error | 15ms]\x1b[0m';
const PROMPT_RAW = '\x1b[32mrepl\x1b[0m \x1b[33m>\x1b[0m ';

describe('findSentinel — 정상', () => {
  test('ANSI 포함 성공 센티넬에서 kind==="ok", durationMs===447 을 검출한다', () => {
    const result = findSentinel(OK_SENTINEL_447);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('ok');
    expect(result?.durationMs).toBe(447);
  });

  test('ANSI 포함 실패 센티넬에서 kind==="error" 를 검출한다', () => {
    const result = findSentinel(ERROR_SENTINEL);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('error');
    expect(result?.durationMs).toBe(15);
  });
});

describe('findSentinel — 음성 대조 (D2)', () => {
  // 이 스위트가 없으면 정규식 브래킷 표현식 실수(POSIX bracket expression)를 잡을 수 없다.
  test.each(['ok', '[completed]', 'STEP1 target= ok', 'k', 'o'])(
    '평범한 출력 %j 에서는 null 을 반환한다',
    (text) => {
      expect(findSentinel(text)).toBeNull();
    },
  );
});

describe('findSentinel — 경계값', () => {
  test('빈 문자열은 null 을 반환한다', () => {
    expect(findSentinel('')).toBeNull();
  });

  test('센티넬 뒤에 프롬프트가 따라오면 index/end 가 센티넬 구간만 정확히 가리킨다', () => {
    const before = 'STEP1 target= 38C32FC4F85010C35F75F1C874B007F5\n';
    const text = `${before}${OK_SENTINEL}${PROMPT_RAW}`;
    const clean = stripAnsi(text);
    const result = findSentinel(text);
    expect(result).not.toBeNull();
    expect(clean.slice(0, result!.index)).toBe(before);
    expect(clean.slice(result!.index, result!.end)).toBe('[ok | 87ms]');
    expect(stripPrompt(clean.slice(result!.end))).toBe('');
  });

  test('센티넬이 청크로 쪼개져 도착하면 앞부분만으로는 null, 이어붙이면 검출된다', () => {
    const full = `hello\n${OK_SENTINEL}`;
    const splitPoint = full.indexOf('[ok');
    const firstChunk = full.slice(0, splitPoint + 2); // '[o' 까지만 도착
    const secondChunk = full.slice(splitPoint + 2);

    expect(findSentinel(firstChunk)).toBeNull();
    expect(findSentinel(firstChunk + secondChunk)).not.toBeNull();
  });
});

describe('stripAnsi', () => {
  test('ANSI 이스케이프 시퀀스를 제거한다', () => {
    expect(stripAnsi(PROMPT_RAW)).toBe('repl > ');
  });
});

describe('stripPrompt', () => {
  test('repl > 프롬프트 조각을 제거한다', () => {
    expect(stripPrompt('repl > hello')).toBe('hello');
  });
});

describe('parseLastJson', () => {
  test('정상: JSON 한 줄만 있으면 그것을 파싱한다', () => {
    expect(parseLastJson('{"url":"https://blog.naver.com/dev_king"}')).toEqual({
      url: 'https://blog.naver.com/dev_king',
    });
  });

  test('정상: openTab 배너가 앞에 붙어도 마지막 JSON 줄을 골라낸다', () => {
    const stdout = '✔︎ Opened a new tab and set it active: tabs[0], page → NAVER (https://naver.com)\n{"opened":true}';
    expect(parseLastJson(stdout)).toEqual({ opened: true });
  });

  test('정상: 배열도 파싱한다', () => {
    expect(parseLastJson('배너\n[1,2]')).toEqual([1, 2]);
  });

  test('경계값: 빈 문자열은 null 이다', () => {
    expect(parseLastJson('')).toBeNull();
  });

  test('경계값: 공백·개행뿐이면 null 이다', () => {
    expect(parseLastJson('\n  \n')).toBeNull();
  });

  test('에러: JSON 줄이 하나도 없으면 null 이다', () => {
    expect(parseLastJson('그냥 로그\n또 다른 로그')).toBeNull();
  });

  test('에러: 깨진 JSON 줄만 있으면 null 이다', () => {
    expect(parseLastJson('{"a":')).toBeNull();
  });

  test('경계값: 뒤쪽 줄이 깨졌으면 앞쪽의 온전한 JSON 을 쓴다', () => {
    expect(parseLastJson('{"a":1}\n{"b":')).toEqual({ a: 1 });
  });
});
