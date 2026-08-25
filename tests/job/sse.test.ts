import { describe, expect, test } from 'vitest';
import { eventsSince, formatEvent, parseLastEventId } from '@/lib/job/sse';
import type { JobLogEntry } from '@/lib/types';

function makeLog(count: number): JobLogEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    at: new Date(2026, 0, 1, 0, 0, i).toISOString(),
    phase: 'analyzing' as const,
    message: `step ${i}`,
  }));
}

describe('formatEvent', () => {
  test('정상: 출력에 id: 3 과 data: 가 각각 한 줄로 존재한다', () => {
    const output = formatEvent(3, { message: 'hello' });
    const lines = output.split('\n');
    expect(lines).toContain('id: 3');
    expect(lines.some((line) => line.startsWith('data: '))).toBe(true);
  });

  test('정상: 문자열 데이터를 JSON으로 다시 감싸지 않고 그대로 실어보낸다', () => {
    const output = formatEvent(0, 'plain text');
    expect(output).toContain('data: plain text');
  });

  test('경계값: 데이터에 개행이 있으면 data: 줄이 여러 개로 쪼개진다', () => {
    const output = formatEvent(1, 'line one\nline two\nline three');
    const dataLines = output.split('\n').filter((line) => line.startsWith('data: '));
    expect(dataLines).toEqual(['data: line one', 'data: line two', 'data: line three']);
  });

  test('경계값: 이벤트는 빈 줄로 끝난다 (SSE 이벤트 구분자)', () => {
    const output = formatEvent(0, 'x');
    expect(output.endsWith('\n\n')).toBe(true);
  });
});

describe('parseLastEventId', () => {
  test('에러: 숫자가 아닌 문자열은 -1을 반환한다', () => {
    expect(parseLastEventId('abc')).toBe(-1);
  });

  test('에러: null이면 -1을 반환한다', () => {
    expect(parseLastEventId(null)).toBe(-1);
  });

  test('정상: 유효한 숫자 문자열은 해당 정수로 파싱된다', () => {
    expect(parseLastEventId('5')).toBe(5);
  });

  test('경계값: 0은 유효한 값으로 파싱된다 (falsy이지만 -1이 아니다)', () => {
    expect(parseLastEventId('0')).toBe(0);
  });
});

describe('eventsSince', () => {
  test('정상: lastId가 -1이면 전부를 돌려준다', () => {
    const log = makeLog(4);
    const result = eventsSince(log, -1);
    expect(result).toHaveLength(4);
    expect(result.map((e) => e.id)).toEqual([0, 1, 2, 3]);
  });

  test('재개(핵심): lastId가 2이면 인덱스 3부터만 돌려주고, 2 이하는 결과에 없다', () => {
    const log = makeLog(5);
    const result = eventsSince(log, 2);
    expect(result.map((e) => e.id)).toEqual([3, 4]);
    expect(result.some((e) => e.id <= 2)).toBe(false);
  });

  test('경계값: lastId가 log.length-1이면 빈 배열을 돌려준다', () => {
    const log = makeLog(3);
    const result = eventsSince(log, 2);
    expect(result).toEqual([]);
  });

  test('경계값: 빈 로그면 빈 배열을 돌려준다', () => {
    expect(eventsSince([], -1)).toEqual([]);
  });

  test('정상: 반환된 각 항목의 entry가 원본 로그 항목과 동일하다', () => {
    const log = makeLog(2);
    const result = eventsSince(log, -1);
    expect(result[0].entry.message).toBe('step 0');
    expect(result[1].entry.message).toBe('step 1');
  });
});
