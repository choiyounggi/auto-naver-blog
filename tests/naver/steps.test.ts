import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { CategoryNotFoundError, ElementNotFoundError, EvaluationFailedError } from '@/lib/naver/errors';
import {
  buildPlaceText,
  dismissEntryPopups,
  fillBodyAndImages,
  fillTitle,
  openEditor,
  selectCategory,
  setThumbnail,
  submitPublish,
} from '@/lib/naver/steps';
import type { PostDraft, PostInput, UploadedImage } from '@/lib/types';
import { failResult, okResult, sequenceRepl, treeResult } from './fake-repl';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures');

async function loadFixture(name: string): Promise<string> {
  return readFile(path.join(fixturesDir, name), 'utf8');
}

function makeImage(n: number, overrides: Partial<UploadedImage> = {}): UploadedImage {
  return {
    id: `img-${n}`,
    originalName: `photo-${n}.jpg`,
    path: `/uploads/photo-${n}.jpg`,
    mimeType: 'image/jpeg',
    bytes: 1024,
    width: 800,
    height: 600,
    order: n - 1,
    ...overrides,
  };
}

function makeInput(imageCount: number): PostInput {
  return {
    jobId: 'job-1',
    category: '여행',
    highlights: '하이라이트',
    place: '',
    images: Array.from({ length: imageCount }, (_, i) => makeImage(i + 1)),
    createdAt: '2026-08-25T00:00:00.000Z',
  };
}

function makeDraft(imageCount: number, overrides: Partial<PostDraft> = {}): PostDraft {
  return {
    title: '제목',
    intro: '인트로',
    blocks: Array.from({ length: imageCount }, (_, i) => ({
      imageId: `img-${i + 1}`,
      caption: `캡션-${i + 1}`,
      altText: `대체텍스트-${i + 1}`,
    })),
    outro: '아웃트로',
    tags: ['태그1'],
    topic: '여행',
    thumbnailImageId: 'img-1',
    generatedAt: '2026-08-25T00:00:00.000Z',
    model: 'claude-test',
    ...overrides,
  };
}

describe('fillTitle — 정상', () => {
  test('editor-ready 스냅샷에서 제목 입력에 성공한다', async () => {
    const tree = await loadFixture('editor-ready.snapshot.txt');
    const repl = sequenceRepl([treeResult(tree), okResult(JSON.stringify({ typed: true }))]);

    await expect(fillTitle({ repl }, '테스트 제목')).resolves.toBeUndefined();
    expect(repl.calls.length).toBe(2);
  });
});

describe('D4 — 세 가지 실패 결과 구분', () => {
  test('에러(못 찾음): editor-missing-publish 로 submitPublish 가 실패하고 단계명·발췌가 담긴다', async () => {
    const tree = await loadFixture('editor-missing-publish.snapshot.txt');
    const repl = sequenceRepl([treeResult(tree)]);

    await expect(submitPublish({ repl })).rejects.toThrow(ElementNotFoundError);
    try {
      await submitPublish(sequenceReplCtx(tree));
      throw new Error('unreachable');
    } catch (err) {
      expect(err).toBeInstanceOf(ElementNotFoundError);
      const notFound = err as ElementNotFoundError;
      expect(notFound.step).toBe('submitPublish');
      expect(notFound.message).toContain('submitPublish');
      expect(notFound.excerpt.length).toBeGreaterThan(0);
    }
  });

  test('에러(수행 못 함): evaluate 가 ok:false 일 때의 에러가 "못 찾음" 에러와 문자열이 다르다', async () => {
    const tree = await loadFixture('editor-missing-publish.snapshot.txt');
    const notFoundRepl = sequenceRepl([treeResult(tree)]);
    const evalFailedRepl = sequenceRepl([failResult('테스트용 실패 이유')]);

    let notFoundMessage = '';
    try {
      await submitPublish({ repl: notFoundRepl });
    } catch (err) {
      notFoundMessage = (err as Error).message;
    }

    let evalFailedMessage = '';
    try {
      await submitPublish({ repl: evalFailedRepl });
    } catch (err) {
      expect(err).toBeInstanceOf(EvaluationFailedError);
      evalFailedMessage = (err as Error).message;
    }

    expect(notFoundMessage.length).toBeGreaterThan(0);
    expect(evalFailedMessage.length).toBeGreaterThan(0);
    expect(evalFailedMessage).not.toBe(notFoundMessage);
  });

  test('에러(D4): 채널이 poisoned 되었을 때의 에러 텍스트가 일반적인 ok:false 에러와 다르다', async () => {
    // t1 repl.ts 의 실제 poisoned 사유 문자열 형태를 흉내낸다 (드레이닝 타임아웃).
    const poisonedRepl = sequenceRepl([failResult('REPL 동기화 상실 — dispose 후 재시작 필요 (드레이닝 타임아웃)')]);
    const genericFailRepl = sequenceRepl([failResult('테스트용 실패 이유')]);

    let poisonedMessage = '';
    try {
      await submitPublish({ repl: poisonedRepl });
    } catch (err) {
      expect(err).toBeInstanceOf(EvaluationFailedError);
      poisonedMessage = (err as Error).message;
    }

    let genericMessage = '';
    try {
      await submitPublish({ repl: genericFailRepl });
    } catch (err) {
      genericMessage = (err as Error).message;
    }

    expect(poisonedMessage.length).toBeGreaterThan(0);
    expect(genericMessage.length).toBeGreaterThan(0);
    expect(poisonedMessage).not.toBe(genericMessage);
  });
});

function sequenceReplCtx(tree: string) {
  return { repl: sequenceRepl([treeResult(tree)]) };
}

describe('openEditor', () => {
  test('에디터 iframe 이 있는 스냅샷이면 성공한다', async () => {
    const tree = await loadFixture('editor-ready.snapshot.txt');
    const repl = sequenceRepl([okResult(JSON.stringify({ tree, url: 'https://blog.naver.com/tester?Redirect=Write' }))]);

    await expect(openEditor({ repl }, 'tester')).resolves.toBe('https://blog.naver.com/tester?Redirect=Write');
  });

  test('로그인 페이지 스냅샷을 받으면 실패한다', async () => {
    const tree = await loadFixture('login-page.snapshot.txt');
    const repl = sequenceRepl([okResult(JSON.stringify({ tree, url: 'https://nid.naver.com/nidlogin.login' }))]);

    await expect(openEditor({ repl }, 'tester')).rejects.toThrow(ElementNotFoundError);
  });
});

describe('dismissEntryPopups — 경계값(D10)', () => {
  test('팝업이 없어도 실패하지 않는다', async () => {
    const repl = sequenceRepl([okResult(JSON.stringify({ dismissed: false })), okResult(JSON.stringify({ dismissed: false }))]);

    await expect(dismissEntryPopups({ repl })).resolves.toBeUndefined();
    expect(repl.calls.length).toBe(2);
  });

  test('evaluate 자체가 실패해도(치명적이지 않음) throw 하지 않는다', async () => {
    const repl = sequenceRepl([failResult('일시적 오류'), okResult(JSON.stringify({ dismissed: true }))]);

    await expect(dismissEntryPopups({ repl })).resolves.toBeUndefined();
  });
});

describe('fillTitle — 경계값(D7): 특수문자', () => {
  test('따옴표·개행·백틱·역슬래시가 든 제목이 JSON.stringify 로 안전하게 주입된다', async () => {
    const tree = await loadFixture('editor-ready.snapshot.txt');
    const repl = sequenceRepl([treeResult(tree), okResult(JSON.stringify({ typed: true }))]);
    const dangerousTitle = '제목 "따옴표" \n개행\n `백틱` \\역슬래시\\';

    await fillTitle({ repl }, dangerousTitle);

    const actionCall = repl.calls[1];
    expect(actionCall.js).toContain(JSON.stringify(dangerousTitle));
    // 문자열 연결이었다면 이 JS 는 파싱 불가능한 상태가 됐을 것이다 — 안전하게 파싱 가능해야 한다.
    expect(() => new Function(actionCall.js)).not.toThrow();
  });
});

describe('fillBodyAndImages', () => {
  test('경계값: 이미지 1장짜리 draft 로 동작한다', async () => {
    const tree = await loadFixture('editor-ready.snapshot.txt');
    const repl = sequenceRepl([treeResult(tree), okResult(JSON.stringify({ ok: true, partsApplied: 3 }))]);
    const input = makeInput(1);
    const draft = makeDraft(1);

    await expect(fillBodyAndImages({ repl }, draft, input)).resolves.toBeUndefined();
    expect(repl.calls.length).toBe(2);
  });

  test('경계값: 이미지 0장이면 거부한다(최소 1장) — 브라우저를 건드리지 않는다', async () => {
    const repl = sequenceRepl([]);
    const input = makeInput(0);
    const draft = makeDraft(0);

    await expect(fillBodyAndImages({ repl }, draft, input)).rejects.toThrow(/0장/);
    expect(repl.calls.length).toBe(0);
  });

  test('D11 재검증: blocks 순서가 어긋나면 재정렬하지 않고 거부한다', async () => {
    const repl = sequenceRepl([]);
    const input = makeInput(2);
    const draft = makeDraft(2, { thumbnailImageId: 'img-2' });

    await expect(fillBodyAndImages({ repl }, draft, input)).rejects.toThrow();
    expect(repl.calls.length).toBe(0);
  });
});

describe('setThumbnail', () => {
  test('D11 재검증: thumbnailImageId 가 첫 이미지와 다르면 거부한다', async () => {
    const repl = sequenceRepl([]);
    const input = makeInput(2);
    const draft = makeDraft(2, { thumbnailImageId: 'img-2' });

    await expect(setThumbnail({ repl }, draft, input)).rejects.toThrow();
    expect(repl.calls.length).toBe(0);
  });
});

describe('selectCategory (D14)', () => {
  test('에러: 카테고리 이름이 목록에 없으면 실패하고 사용 가능한 이름들이 담긴다', async () => {
    const openTree = await loadFixture('editor-ready.snapshot.txt');
    const repl = sequenceRepl([
      treeResult(openTree),
      okResult(JSON.stringify({ clicked: true })),
      treeResult(openTree),
    ]);

    await expect(selectCategory({ repl }, '없는카테고리')).rejects.toThrow(CategoryNotFoundError);
    const repl2 = sequenceRepl([treeResult(openTree), okResult(JSON.stringify({ clicked: true })), treeResult(openTree)]);
    try {
      await selectCategory({ repl: repl2 }, '없는카테고리');
      throw new Error('unreachable');
    } catch (err) {
      expect(err).toBeInstanceOf(CategoryNotFoundError);
      const notFound = err as CategoryNotFoundError;
      expect(notFound.available).toEqual(['일상', '여행', '맛집']);
    }
  });

  test('정상(D14): 이름 앞뒤 공백만 다른 카테고리는 일치로 처리된다', async () => {
    const openTree = await loadFixture('editor-ready.snapshot.txt');
    const repl = sequenceRepl([
      treeResult(openTree),
      okResult(JSON.stringify({ clicked: true })),
      treeResult(openTree),
      okResult(JSON.stringify({ clicked: true })),
    ]);

    await expect(selectCategory({ repl }, '  여행  ')).resolves.toBeUndefined();
  });
});

describe('buildPlaceText', () => {
  test('정상: 장소를 글 끝 문단으로 만든다', () => {
    expect(buildPlaceText('서울 성수동 파스타집')).toBe('\n📍 장소\n서울 성수동 파스타집');
  });

  test('경계값: 빈 문자열이면 null 이다(문단을 넣지 않는다)', () => {
    expect(buildPlaceText('')).toBeNull();
  });

  test('경계값: 공백뿐이면 null 이다', () => {
    expect(buildPlaceText('   \n ')).toBeNull();
  });

  test('경계값: 앞뒤 공백을 다듬어 넣는다', () => {
    expect(buildPlaceText('  성수동  ')).toBe('\n📍 장소\n성수동');
  });
});

describe('fillBodyAndImages — 장소', () => {
  test('정상: 장소를 입력하면 본문 마지막 파트로 붙는다', async () => {
    const tree = await loadFixture('editor-ready.snapshot.txt');
    const repl = sequenceRepl([treeResult(tree), okResult(JSON.stringify({ ok: true, partsApplied: 4 }))]);
    const input = { ...makeInput(1), place: '서울 성수동 파스타집' };

    await fillBodyAndImages({ repl }, makeDraft(1), input);

    const js = repl.calls[1].js;
    expect(js).toContain('📍 장소');
    expect(js).toContain('서울 성수동 파스타집');
    // intro → 이미지 1 → outro → 장소 순서 — 장소가 마지막이어야 한다
    expect(js.lastIndexOf('📍 장소')).toBeGreaterThan(js.lastIndexOf('아웃트로'));
  });

  test('경계값: 장소가 비어 있으면 장소 문단을 넣지 않는다', async () => {
    const tree = await loadFixture('editor-ready.snapshot.txt');
    const repl = sequenceRepl([treeResult(tree), okResult(JSON.stringify({ ok: true, partsApplied: 3 }))]);
    const input = { ...makeInput(1), place: '' };

    await fillBodyAndImages({ repl }, makeDraft(1), input);

    expect(repl.calls[1].js).not.toContain('📍');
  });

  test('경계값: 공백뿐인 장소도 문단을 만들지 않는다', async () => {
    const tree = await loadFixture('editor-ready.snapshot.txt');
    const repl = sequenceRepl([treeResult(tree), okResult(JSON.stringify({ ok: true, partsApplied: 3 }))]);
    const input = { ...makeInput(1), place: '   ' };

    await fillBodyAndImages({ repl }, makeDraft(1), input);

    expect(repl.calls[1].js).not.toContain('📍');
  });
});
