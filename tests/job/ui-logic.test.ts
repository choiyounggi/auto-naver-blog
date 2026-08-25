import { describe, expect, test } from 'vitest';
import {
  formatBytes,
  imageOrderLabel,
  isTerminalPhase,
  phaseLabel,
  safeHref,
  validateClientUpload,
} from '@/lib/job/ui-logic';

describe('phaseLabel', () => {
  test('정상: 각 phase가 고유한 한글 문구로 매핑된다', () => {
    expect(phaseLabel('created')).toBe('준비 중');
    expect(phaseLabel('awaiting_approval')).toBe('승인 대기 중');
    expect(phaseLabel('published')).toBe('발행 완료');
    expect(phaseLabel('failed')).toBe('실패');
  });

  test('경계값: 서로 다른 phase는 서로 다른 문구를 반환한다 (매핑 누락/중복 회귀)', () => {
    const phases = [
      'created',
      'analyzing',
      'drafting',
      'draft_ready',
      'filling_editor',
      'awaiting_approval',
      'publishing',
      'published',
      'failed',
      'cancelled',
    ] as const;
    const labels = phases.map((p) => phaseLabel(p));
    expect(new Set(labels).size).toBe(phases.length);
  });
});

describe('imageOrderLabel', () => {
  test('정상: order 0은 대표 이미지로 표시된다', () => {
    expect(imageOrderLabel(0, 3)).toBe('대표 (1/3)');
  });

  test('정상: order 0이 아니면 순번만 표시된다', () => {
    expect(imageOrderLabel(2, 3)).toBe('3/3');
  });

  test('경계값: 이미지가 한 장뿐이면 대표만 표시된다', () => {
    expect(imageOrderLabel(0, 1)).toBe('대표 (1/1)');
  });
});

describe('formatBytes', () => {
  test('정상: 1024 미만은 바이트 단위로 표시된다', () => {
    expect(formatBytes(500)).toBe('500B');
  });

  test('경계값: 0바이트는 0B로 표시된다', () => {
    expect(formatBytes(0)).toBe('0B');
  });

  test('경계값: 정확히 1024바이트는 1.0KB로 표시된다', () => {
    expect(formatBytes(1024)).toBe('1.0KB');
  });

  test('정상: 1MB 이상은 MB 단위로 표시된다', () => {
    expect(formatBytes(10 * 1024 * 1024)).toBe('10.0MB');
  });
});

describe('isTerminalPhase', () => {
  test('정상: published/failed/cancelled는 터미널 상태다', () => {
    expect(isTerminalPhase('published')).toBe(true);
    expect(isTerminalPhase('failed')).toBe(true);
    expect(isTerminalPhase('cancelled')).toBe(true);
  });

  test('에러: 진행 중인 phase는 터미널이 아니다', () => {
    expect(isTerminalPhase('awaiting_approval')).toBe(false);
    expect(isTerminalPhase('created')).toBe(false);
  });
});

describe('safeHref', () => {
  test('정상: https URL은 그대로 반환된다', () => {
    expect(safeHref('https://blog.naver.com/x/1')).toBe('https://blog.naver.com/x/1');
  });

  test('에러: javascript: 프로토콜은 null을 반환한다 (XSS 방지)', () => {
    expect(safeHref('javascript:alert(1)')).toBeNull();
  });

  test('에러: 파싱할 수 없는 문자열은 null을 반환한다', () => {
    expect(safeHref('not a url')).toBeNull();
  });

  test('경계값: null 입력은 null을 반환한다', () => {
    expect(safeHref(null)).toBeNull();
  });
});

describe('validateClientUpload', () => {
  const limits = { maxCount: 20, maxBytesPerImage: 10 * 1024 * 1024 };

  test('정상: 상한 내의 파일들은 통과한다 (null 반환)', () => {
    const files = [{ size: 100 }, { size: 200 }];
    expect(validateClientUpload(files, limits)).toBeNull();
  });

  test('에러: 파일이 없으면 에러 메시지를 반환한다', () => {
    expect(validateClientUpload([], limits)).not.toBeNull();
  });

  test('에러: 장당 크기를 초과하는 파일이 있으면 에러 메시지를 반환한다', () => {
    const files = [{ size: 11 * 1024 * 1024 }];
    const result = validateClientUpload(files, limits);
    expect(result).not.toBeNull();
    expect(result).toContain('10.0MB');
  });

  test('경계값: 정확히 상한 장수면 통과한다', () => {
    const files = Array.from({ length: 20 }, () => ({ size: 100 }));
    expect(validateClientUpload(files, limits)).toBeNull();
  });

  test('경계값: 상한 장수를 1장 초과하면 에러 메시지를 반환한다', () => {
    const files = Array.from({ length: 21 }, () => ({ size: 100 }));
    expect(validateClientUpload(files, limits)).not.toBeNull();
  });
});
