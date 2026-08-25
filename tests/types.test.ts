import { describe, expect, test } from 'vitest';
import { NaverSessionStatusSchema, PostDraftSchema, PostInputSchema, UploadedImageSchema } from '@/lib/types';

function makeImage(order: number) {
  return {
    id: `img-${order}`,
    originalName: `photo-${order}.jpg`,
    path: `/data/jobs/job-1/images/img-${order}.jpg`,
    mimeType: 'image/jpeg',
    bytes: 12345,
    width: 800,
    height: 600,
    order,
  };
}

describe('PostInputSchema', () => {
  test('정상: 이미지 2장짜리 유효한 PostInput은 safeParse에 성공한다', () => {
    const result = PostInputSchema.safeParse({
      jobId: 'job-1',
      category: '일상',
      highlights: '오늘 다녀온 카페',
      images: [makeImage(0), makeImage(1)],
      createdAt: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.images[0].order).toBe(0);
    }
  });

  test('에러: images가 빈 배열이면 safeParse에 실패한다 (최소 1장 규칙)', () => {
    const result = PostInputSchema.safeParse({
      jobId: 'job-1',
      category: '일상',
      highlights: '오늘 다녀온 카페',
      images: [],
      createdAt: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });
});

describe('NaverSessionStatusSchema', () => {
  test('에러: reason이 허용 목록 밖이면 safeParse에 실패한다', () => {
    const result = NaverSessionStatusSchema.safeParse({
      loggedIn: false,
      reason: 'something-else',
      checkedAt: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });

  test('정상: loggedIn:true 상태는 safeParse에 성공한다', () => {
    const result = NaverSessionStatusSchema.safeParse({
      loggedIn: true,
      blogId: 'my-blog',
      checkedAt: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });
});

describe('PostDraftSchema.tags 경계값', () => {
  const base = {
    title: '제목',
    intro: '인트로',
    blocks: [],
    outro: '아웃트로',
    topic: '일상',
    thumbnailImageId: 'img-0',
    generatedAt: new Date().toISOString(),
    model: 'claude',
  };

  test('경계값: tags가 정확히 30개면 성공한다', () => {
    const result = PostDraftSchema.safeParse({ ...base, tags: Array.from({ length: 30 }, (_, i) => `tag${i}`) });
    expect(result.success).toBe(true);
  });

  test('경계값: tags가 31개면 실패한다', () => {
    const result = PostDraftSchema.safeParse({ ...base, tags: Array.from({ length: 31 }, (_, i) => `tag${i}`) });
    expect(result.success).toBe(false);
  });
});

describe('UploadedImageSchema.order 경계값', () => {
  test('경계값: order 0은 성공한다', () => {
    expect(UploadedImageSchema.safeParse(makeImage(0)).success).toBe(true);
  });

  test('경계값: order -1은 실패한다', () => {
    const image = { ...makeImage(0), order: -1 };
    expect(UploadedImageSchema.safeParse(image).success).toBe(false);
  });
});
