import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { assertSafeJobDir } from '@/lib/job/paths';

describe('assertSafeJobDir', () => {
  const dataDir = path.join(process.cwd(), '.dev-loop', 'test-tmp', 'paths-base');

  test('정상: 평범한 UUID 형태 jobId는 <dataDir>/jobs/<id>를 반환한다', () => {
    const id = '04491a21-2909-49c6-9178-62e7f197e15d';
    expect(assertSafeJobDir(dataDir, id)).toBe(path.join(dataDir, 'jobs', id));
  });

  test('에러: ../../../../etc 형태의 jobId는 throw한다', () => {
    expect(() => assertSafeJobDir(dataDir, '../../../../etc')).toThrow();
  });

  test('에러: 절대경로 jobId는 throw한다', () => {
    expect(() => assertSafeJobDir(dataDir, '/etc')).toThrow();
  });

  test('경계값: jobId가 ..이면 dataDir 안이지만 jobs/ 밖이므로 throw한다 (r1 이후 남았던 틈)', () => {
    expect(() => assertSafeJobDir(dataDir, '..')).toThrow();
  });

  test('경계값: 정상 jobId는 항상 <dataDir>/jobs/ 접두사를 갖는다', () => {
    const result = assertSafeJobDir(dataDir, 'ok');
    expect(result.startsWith(path.join(dataDir, 'jobs') + path.sep)).toBe(true);
  });

  test('에러: 에러 메시지에 받은 jobId가 그대로 담긴다', () => {
    expect(() => assertSafeJobDir(dataDir, '../../etc')).toThrow(/\.\.\/\.\.\/etc/);
  });
});
