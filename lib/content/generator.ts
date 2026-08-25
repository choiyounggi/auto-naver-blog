import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { AppConfig } from '../config';
import type { ContentGeneratorApi, PostDraft, PostInput, ProgressFn } from '../types';
import { PostDraftSchema } from '../types';
import { callClaude } from './claude-cli';

// D4: a bound on a single-call, whole-image-set request — see D3. Without a
// cap, a large upload silently overflows the model's context window instead
// of failing loudly.
const MAX_IMAGES = 20;

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const PROMPT_TEMPLATE_PATH = path.join(moduleDir, '..', '..', 'prompts', 'post-draft.md');

const POST_DRAFT_JSON_SCHEMA = z.toJSONSchema(PostDraftSchema);

export class ContentGenerator implements ContentGeneratorApi {
  constructor(private readonly config: AppConfig) {}

  async generate(input: PostInput, onProgress?: ProgressFn): Promise<PostDraft> {
    if (input.images.length > MAX_IMAGES) {
      throw new Error(
        `이미지가 너무 많습니다: 최대 ${MAX_IMAGES}장까지 지원하는데 ${input.images.length}장이 입력되었습니다.`,
      );
    }

    onProgress?.('프롬프트 준비 중');
    const prompt = await buildPrompt(input);
    const allowDirs = Array.from(new Set(input.images.map((image) => path.dirname(image.path))));

    onProgress?.('claude CLI 호출 중');
    const result = await callClaude({
      config: this.config,
      prompt,
      jsonSchema: POST_DRAFT_JSON_SCHEMA,
      allowDirs,
    });

    if (!result.ok) {
      throw new Error(`claude CLI 호출이 실패했습니다: ${result.error}`);
    }
    if (result.model === null) {
      throw new Error('claude CLI 응답에 modelUsage가 없어 실제로 사용된 모델명을 확인할 수 없습니다.');
    }

    onProgress?.('응답 검증 중');
    const parsed = PostDraftSchema.safeParse(result.structuredOutput);
    if (!parsed.success) {
      throw new Error(`claude CLI 응답이 PostDraft 스키마와 맞지 않습니다: ${JSON.stringify(parsed.error.issues)}`);
    }

    const draft = parsed.data;
    assertStructuralInvariants(draft, input);

    return {
      ...draft,
      model: result.model,
      generatedAt: new Date().toISOString(),
    };
  }
}

// D12: invariants a zod schema cannot express because they compare the
// response against the request (image count/order/thumbnail), not just the
// response's own shape.
function assertStructuralInvariants(draft: PostDraft, input: PostInput): void {
  assertInputOrderInvariant(input);

  if (draft.blocks.length !== input.images.length) {
    throw new Error(
      `blocks 개수가 이미지 수와 다릅니다: blocks=${draft.blocks.length}, images=${input.images.length}`,
    );
  }

  for (let i = 0; i < input.images.length; i++) {
    if (draft.blocks[i].imageId !== input.images[i].id) {
      throw new Error(
        `blocks[${i}].imageId가 images[${i}].id와 다릅니다: blocks[${i}].imageId=${draft.blocks[i].imageId}, images[${i}].id=${input.images[i].id}`,
      );
    }
  }

  if (draft.thumbnailImageId !== input.images[0].id) {
    throw new Error(
      `thumbnailImageId가 첫 번째 이미지 id와 다릅니다: thumbnailImageId=${draft.thumbnailImageId}, images[0].id=${input.images[0].id}`,
    );
  }

  if (draft.tags.length < 1) {
    throw new Error('tags가 비어 있습니다: 최소 1개 이상이어야 합니다.');
  }
}

// review r1 F1: order는 배열 순서와 별개로 저장되는 진실이다. 배열 위치만 보고 썸네일/블록
// 순서를 판정하면, 배열이 order와 다른 순서로 전달될 때(재구성·직렬화 왕복 등) 조용히
// 엉뚱한 이미지가 썸네일로 통과한다. 배열 위치 기반 검사를 신뢰하기 전에 이 둘이 같은
// 뜻임을 먼저 확인한다. 어긋난 입력은 정렬해서 고쳐 넣지 않고 거부한다.
function assertInputOrderInvariant(input: PostInput): void {
  for (let i = 0; i < input.images.length; i++) {
    if (input.images[i].order !== i) {
      throw new Error(
        `input.images의 order가 배열 순서와 다릅니다: images[${i}].order=${input.images[i].order}, 기대값=${i} ` +
          `(order는 0부터 오름차순으로 연속이어야 합니다).`,
      );
    }
  }
}

// 템플릿 치환은 프롬프트 계약의 일부라 직접 테스트한다 — 그래서 export 한다.
export async function buildPrompt(input: PostInput): Promise<string> {
  const template = await readFile(PROMPT_TEMPLATE_PATH, 'utf8');
  const imageList = input.images
    .map((image, index) => {
      const marker = index === 0 ? ' (대표/썸네일)' : '';
      return `${index + 1}. id=${image.id} path=${image.path}${marker}`;
    })
    .join('\n');

  return template
    .replaceAll('{{CATEGORY}}', input.category)
    .replaceAll('{{PLACE}}', input.place.trim() === '' ? '(입력 없음)' : input.place.trim())
    .replaceAll('{{HIGHLIGHTS}}', input.highlights)
    .replaceAll('{{IMAGE_LIST}}', imageList)
    .replaceAll('{{IMAGE_COUNT}}', String(input.images.length));
}
