import type { JobLogEntry } from '../types';

// D6: SSE 규격 — 데이터에 개행이 있으면 data: 를 여러 줄로 쪼갠다.
// D7: id는 JobState.log 배열의 인덱스다.
export function formatEvent(id: number, data: unknown): string {
  const serialized = typeof data === 'string' ? data : JSON.stringify(data);
  const dataLines = serialized
    .split('\n')
    .map((line) => `data: ${line}`)
    .join('\n');
  return `id: ${id}\n${dataLines}\n\n`;
}

// D6: Last-Event-ID 헤더가 없거나 숫자가 아니면 -1(처음부터)로 취급한다.
export function parseLastEventId(header: string | null): number {
  if (header === null) return -1;
  const trimmed = header.trim();
  if (!/^\d+$/.test(trimmed)) return -1;
  return Number(trimmed);
}

// D7: 재개 지점(lastId) 다음 인덱스부터만 돌려준다 — 로그는 append-only이므로
// 인덱스가 곧 안정적인 이벤트 id다.
export function eventsSince(
  log: readonly JobLogEntry[],
  lastId: number,
): { id: number; entry: JobLogEntry }[] {
  const result: { id: number; entry: JobLogEntry }[] = [];
  for (let id = lastId + 1; id < log.length; id++) {
    result.push({ id, entry: log[id] });
  }
  return result;
}
