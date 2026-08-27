import { chmodSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, test } from 'vitest';
import type { AppConfig } from '@/lib/config';
import { POST_DRAFT_JSON_SCHEMA, buildPrompt, ContentGenerator } from '@/lib/content/generator';
import type { PostInput, UploadedImage } from '@/lib/types';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE_PATH = path.join(here, 'fake-claude.mjs');

beforeAll(() => {
  chmodSync(FAKE_CLAUDE_PATH, 0o755);
});

function fakeConfig(): AppConfig {
  return {
    dataDir: '/tmp/unused-in-this-test',
    claudeBin: FAKE_CLAUDE_PATH,
    asideBin: 'aside',
    naverBlogId: null,
    cookieFile: '/tmp/unused-in-this-test/cookies.json',
    claudeTimeoutMs: 5000,
    asideStepTimeoutMs: 60000,
  };
}

function makeImage(n: number): UploadedImage {
  return {
    id: `img-${n}`,
    originalName: `photo-${n}.jpg`,
    path: `/uploads/photo-${n}.jpg`,
    mimeType: 'image/jpeg',
    bytes: 1024,
    width: 800,
    height: 600,
    order: n - 1,
  };
}

function makeInput(opts: { imageCount: number; fakeMode: string }): PostInput {
  return {
    jobId: 'job-1',
    category: '카페',
    highlights: `FAKE_MODE:${opts.fakeMode}`,
    place: '',
    images: Array.from({ length: opts.imageCount }, (_, i) => makeImage(i + 1)),
    createdAt: '2026-08-25T00:00:00.000Z',
  };
}

// review r1 F1: order를 배열 위치와 독립적으로 지정할 수 있게 하는 헬퍼 — 배열 순서와
// order 필드가 어긋난 입력을 재현한다.
function makeInputWithOrders(orders: number[], fakeMode: string): PostInput {
  return {
    jobId: 'job-1',
    category: '카페',
    highlights: `FAKE_MODE:${fakeMode}`,
    place: '',
    images: orders.map((order, i) => ({ ...makeImage(i + 1), order })),
    createdAt: '2026-08-25T00:00:00.000Z',
  };
}

describe('ContentGenerator.generate — 정상', () => {
  test('이미지 2장: blocks가 1:1로 대응하고 실제 모델명이 기록된다', async () => {
    const generator = new ContentGenerator(fakeConfig());
    const input = makeInput({ imageCount: 2, fakeMode: 'success' });

    const draft = await generator.generate(input);

    expect(draft.blocks.length).toBe(2);
    expect(draft.blocks[0].imageId).toBe(input.images[0].id);
    expect(draft.blocks[1].imageId).toBe(input.images[1].id);
    expect(draft.thumbnailImageId).toBe(input.images[0].id);
    expect(draft.model).toBe('claude-sonnet-5');
  });
});

describe('ContentGenerator.generate — 에러', () => {
  test('blocks가 1개만 온 응답(2장 입력): throw, 메시지가 개수 불일치를 가리킨다', async () => {
    const generator = new ContentGenerator(fakeConfig());
    const input = makeInput({ imageCount: 2, fakeMode: 'generator-success-1' });

    await expect(generator.generate(input)).rejects.toThrow(/blocks.*images|개수/);
  });

  test('blocks[1].imageId가 뒤바뀐 응답: throw, 메시지가 순서/id 불일치를 가리킨다', async () => {
    const generator = new ContentGenerator(fakeConfig());
    const input = makeInput({ imageCount: 2, fakeMode: 'generator-blocks-id-swapped' });

    await expect(generator.generate(input)).rejects.toThrow(/blocks\[1\]\.imageId/);
  });

  test('thumbnailImageId가 두 번째 이미지 id인 응답: throw', async () => {
    const generator = new ContentGenerator(fakeConfig());
    const input = makeInput({ imageCount: 2, fakeMode: 'generator-thumbnail-mismatch' });

    await expect(generator.generate(input)).rejects.toThrow(/thumbnailImageId/);
  });

  test('스키마에 안 맞는 응답(tags가 문자열): throw', async () => {
    const generator = new ContentGenerator(fakeConfig());
    const input = makeInput({ imageCount: 2, fakeMode: 'generator-schema-invalid' });

    await expect(generator.generate(input)).rejects.toThrow(/PostDraft 스키마/);
  });

  test('callClaude가 ok:false(auth-failure): throw, 사유가 전달된다', async () => {
    const generator = new ContentGenerator(fakeConfig());
    const input = makeInput({ imageCount: 2, fakeMode: 'auth-failure' });

    await expect(generator.generate(input)).rejects.toThrow(/is_error/);
  });

  test('order가 [1,0]인 2장짜리 입력(배열 순서와 order가 어긋남): throw, 메시지가 순서 문제를 가리킨다 (F1)', async () => {
    const generator = new ContentGenerator(fakeConfig());
    const input = makeInputWithOrders([1, 0], 'success');

    await expect(generator.generate(input)).rejects.toThrow(/order/);
  });

  test('order가 [0,2]로 연속이 아닌 입력: throw (F1)', async () => {
    const generator = new ContentGenerator(fakeConfig());
    const input = makeInputWithOrders([0, 2], 'success');

    await expect(generator.generate(input)).rejects.toThrow(/order/);
  });
});

describe('ContentGenerator.generate — 경계값', () => {
  test('이미지 1장: 정상 동작하고 blocks.length===1이다', async () => {
    const generator = new ContentGenerator(fakeConfig());
    const input = makeInput({ imageCount: 1, fakeMode: 'generator-success-1' });

    const draft = await generator.generate(input);

    expect(draft.blocks.length).toBe(1);
    expect(draft.blocks[0].imageId).toBe(input.images[0].id);
    expect(draft.thumbnailImageId).toBe(input.images[0].id);
  });

  test('이미지 20장: 정상 동작한다', async () => {
    const generator = new ContentGenerator(fakeConfig());
    const input = makeInput({ imageCount: 20, fakeMode: 'generator-success-20' });

    const draft = await generator.generate(input);

    expect(draft.blocks.length).toBe(20);
    expect(draft.blocks[19].imageId).toBe(input.images[19].id);
  });

  test('이미지 21장: 즉시 throw하고 메시지에 장수가 담긴다 (claude CLI 호출 전)', async () => {
    const generator = new ContentGenerator(fakeConfig());
    const input = makeInput({ imageCount: 21, fakeMode: 'generator-success-20' });

    await expect(generator.generate(input)).rejects.toThrow(/21/);
  });

  test('tags가 빈 배열인 응답: throw', async () => {
    const generator = new ContentGenerator(fakeConfig());
    const input = makeInput({ imageCount: 2, fakeMode: 'generator-tags-empty' });

    await expect(generator.generate(input)).rejects.toThrow(/tags/);
  });
});

describe('buildPrompt — 장소 주입', () => {
  test('정상: 입력한 장소가 프롬프트에 그대로 들어간다', async () => {
    const prompt = await buildPrompt({ ...makeInput({ imageCount: 1, fakeMode: 'success' }), place: '서울 성수동 파스타집' });
    expect(prompt).toContain('서울 성수동 파스타집');
    expect(prompt).not.toContain('{{PLACE}}');
  });

  test('경계값: 장소가 비어 있으면 "(입력 없음)" 으로 치환된다', async () => {
    const prompt = await buildPrompt({ ...makeInput({ imageCount: 1, fakeMode: 'success' }), place: '' });
    expect(prompt).toContain('(입력 없음)');
    expect(prompt).not.toContain('{{PLACE}}');
  });

  test('경계값: 공백뿐인 장소도 "(입력 없음)" 이다', async () => {
    const prompt = await buildPrompt({ ...makeInput({ imageCount: 1, fakeMode: 'success' }), place: '   ' });
    expect(prompt).toContain('(입력 없음)');
  });

  test('정상: 카테고리·강조 내용도 함께 치환된다 (치환 누락 회귀)', async () => {
    const prompt = await buildPrompt({ ...makeInput({ imageCount: 1, fakeMode: 'success' }), category: '맛집 뿌시기', highlights: '면이 좋았다' });
    expect(prompt).toContain('맛집 뿌시기');
    expect(prompt).toContain('면이 좋았다');
    expect(prompt).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });
});

// 실측 회귀(2026-08-25): z.toJSONSchema() 가 붙이는 `$schema` 키 때문에 claude CLI 가
// 스키마를 통째로 거부했다(exit=1, stdout 없음). 그 키가 다시 들어오면 여기서 잡힌다.
describe('claude 에 넘기는 JSON 스키마', () => {
  test('에러 방지: $schema 키를 넘기지 않는다', () => {
    expect(POST_DRAFT_JSON_SCHEMA).not.toHaveProperty('$schema');
  });

  test('정상: 스키마 본문은 그대로 남아 있다', () => {
    expect(POST_DRAFT_JSON_SCHEMA).toMatchObject({ type: 'object' });
    expect(Object.keys((POST_DRAFT_JSON_SCHEMA as { properties: object }).properties)).toEqual(
      expect.arrayContaining(['title', 'intro', 'blocks', 'outro', 'tags', 'thumbnailImageId']),
    );
  });

  test('경계값: 중첩된 스키마 안에는 $schema 가 애초에 없다 (문자열 전체에 등장하지 않는다)', () => {
    expect(JSON.stringify(POST_DRAFT_JSON_SCHEMA)).not.toContain('$schema');
  });
});
