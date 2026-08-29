import type { PostDraft } from '../types';

/**
 * 사람이 고친 초안과 에디터에 채워져 있는 초안이 다른지 본다.
 *
 * `generatedAt`·`model` 은 초안을 만든 시점의 기록일 뿐 글의 내용이 아니므로 비교에서 뺀다 —
 * 그것까지 비교하면 아무것도 안 고쳤는데도 매번 다시 채우게 된다.
 */
function comparable(draft: PostDraft): string {
  return JSON.stringify({
    title: draft.title,
    intro: draft.intro,
    blocks: draft.blocks.map((block) => ({
      imageId: block.imageId,
      heading: block.heading,
      caption: block.caption,
      altText: block.altText,
    })),
    outro: draft.outro,
    tags: draft.tags,
    topic: draft.topic,
    thumbnailImageId: draft.thumbnailImageId,
  });
}

/** 에디터를 다시 채워야 하는가. 아직 채운 적이 없으면(null) 다시 채워야 한다. */
export function draftNeedsRefill(edited: PostDraft, inEditor: PostDraft | null): boolean {
  if (inEditor === null) return true;
  return comparable(edited) !== comparable(inEditor);
}
