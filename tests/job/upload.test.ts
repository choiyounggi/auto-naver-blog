import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { resolveImagePathWithin, sniffImageType } from '@/lib/job/upload';

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

describe('sniffImageType', () => {
  test('정상: 유효한 PNG 매직바이트는 png로 판정된다', () => {
    const png = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00);
    expect(sniffImageType(png)).toBe('png');
  });

  test('정상: 유효한 JPEG 매직바이트는 jpeg로 판정된다', () => {
    const jpeg = bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10);
    expect(sniffImageType(jpeg)).toBe('jpeg');
  });

  test('정상: 유효한 GIF 매직바이트는 gif로 판정된다', () => {
    const gif = bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61);
    expect(sniffImageType(gif)).toBe('gif');
  });

  test('정상: 유효한 WEBP(RIFF 컨테이너) 매직바이트는 webp로 판정된다', () => {
    // RIFF <4바이트 크기> WEBP
    const webp = bytes(0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50);
    expect(sniffImageType(webp)).toBe('webp');
  });

  test('에러: 확장자는 .png인데 내용이 텍스트면 null (확장자 신뢰 금지 회귀)', () => {
    const fakePng = new TextEncoder().encode('this is not a real png file at all');
    expect(sniffImageType(fakePng)).toBeNull();
  });

  test('에러: RIFF 컨테이너지만 WEBP가 아니면 null (예: WAVE)', () => {
    const wav = bytes(0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45);
    expect(sniffImageType(wav)).toBeNull();
  });

  test('경계값: 빈 버퍼는 null', () => {
    expect(sniffImageType(new Uint8Array())).toBeNull();
  });

  test('경계값: 매직바이트보다 짧은 버퍼는 인덱스 초과로 죽지 않고 null', () => {
    expect(sniffImageType(bytes(0x89, 0x50))).toBeNull();
    expect(sniffImageType(bytes(0xff))).toBeNull();
  });
});

describe('resolveImagePathWithin', () => {
  const base = path.join(process.cwd(), '.dev-loop', 'test-tmp', 'upload-base');

  test('정상: 정상적인 imageId는 images 디렉토리 하위 경로로 해석된다', () => {
    const resolved = resolveImagePathWithin(base, 'job-1', 'img-abc.png');
    expect(resolved).toBe(path.join(base, 'jobs', 'job-1', 'images', 'img-abc.png'));
  });

  test('에러: ../../etc/passwd 형태의 imageId는 throw한다', () => {
    expect(() => resolveImagePathWithin(base, 'job-1', '../../etc/passwd')).toThrow();
  });

  test('에러: 절대경로 imageId는 throw한다', () => {
    expect(() => resolveImagePathWithin(base, 'job-1', '/etc/passwd')).toThrow();
  });

  test('에러: 단순 ..만으로도 throw한다', () => {
    expect(() => resolveImagePathWithin(base, 'job-1', '..')).toThrow();
  });

  test('경계값: 빈 문자열 imageId는 throw한다 (images 디렉토리 자체를 가리키므로 파일이 아님)', () => {
    expect(() => resolveImagePathWithin(base, 'job-1', '')).toThrow();
  });
});
