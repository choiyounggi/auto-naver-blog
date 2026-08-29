import { describe, expect, test } from 'vitest';
import { draftNeedsRefill } from '@/lib/job/draft-diff';
import type { PostDraft } from '@/lib/types';

function makeDraft(overrides: Partial<PostDraft> = {}): PostDraft {
  return {
    title: '제목',
    intro: '인트로',
    blocks: [
      { imageId: 'img-1', heading: '소제목', caption: '캡션1', altText: '대체1' },
      { imageId: 'img-2', heading: '', caption: '캡션2', altText: '대체2' },
    ],
    outro: '아웃트로',
    tags: ['태그1', '태그2'],
    topic: '맛집',
    thumbnailImageId: 'img-1',
    generatedAt: '2026-08-29T00:00:00.000Z',
    model: 'claude-test',
    ...overrides,
  };
}

describe('draftNeedsRefill — 다시 채워야 하는 경우', () => {
  test('에디터에 채운 적이 없으면 다시 채운다', () => {
    expect(draftNeedsRefill(makeDraft(), null)).toBe(true);
  });

  test('제목이 바뀌면 다시 채운다', () => {
    expect(draftNeedsRefill(makeDraft({ title: '고친 제목' }), makeDraft())).toBe(true);
  });

  test('본문(캡션)이 바뀌면 다시 채운다', () => {
    const edited = makeDraft();
    edited.blocks[1].caption = '고친 캡션';
    expect(draftNeedsRefill(edited, makeDraft())).toBe(true);
  });

  test('소제목이 바뀌면 다시 채운다', () => {
    const edited = makeDraft();
    edited.blocks[0].heading = '';
    expect(draftNeedsRefill(edited, makeDraft())).toBe(true);
  });

  test('사진 순서가 바뀌면 다시 채운다', () => {
    const edited = makeDraft();
    edited.blocks = [edited.blocks[1], edited.blocks[0]];
    edited.thumbnailImageId = 'img-2';
    expect(draftNeedsRefill(edited, makeDraft())).toBe(true);
  });

  test('사진을 빼면 다시 채운다', () => {
    const edited = makeDraft();
    edited.blocks = [edited.blocks[0]];
    expect(draftNeedsRefill(edited, makeDraft())).toBe(true);
  });

  test('태그가 바뀌면 다시 채운다', () => {
    expect(draftNeedsRefill(makeDraft({ tags: ['태그1'] }), makeDraft())).toBe(true);
  });
});

describe('draftNeedsRefill — 다시 채우지 않는 경우', () => {
  test('완전히 같으면 다시 채우지 않는다', () => {
    expect(draftNeedsRefill(makeDraft(), makeDraft())).toBe(false);
  });

  // generatedAt·model 은 글의 내용이 아니라 초안을 만든 기록이다 — 이것 때문에 매번
  // 다시 채우면 사진을 쓸데없이 재업로드하게 된다.
  test('경계값: generatedAt 과 model 만 다르면 다시 채우지 않는다', () => {
    const inEditor = makeDraft({ generatedAt: '2020-01-01T00:00:00.000Z', model: 'other-model' });
    expect(draftNeedsRefill(makeDraft(), inEditor)).toBe(false);
  });

  test('경계값: 빈 초안끼리도 같으면 다시 채우지 않는다', () => {
    const empty = makeDraft({ title: '', intro: '', outro: '', tags: [] });
    expect(draftNeedsRefill(empty, { ...empty })).toBe(false);
  });
});
