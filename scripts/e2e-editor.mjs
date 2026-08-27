#!/usr/bin/env node
// 라이브 검증 하네스. claude CLI 를 부르지 않고(비용 없음) 합성 초안으로 에디터 조작
// 전 구간을 실제 네이버 스마트에디터에 대해 돌린다. 네이버가 UI 를 바꿨을 때 어느 단계가
// 깨졌는지 빠르게 찾기 위한 도구다.
//
//   node scripts/e2e-editor.mjs                 # 미리보기까지만 (발행하지 않음)
//   E2E_PUBLISH=1 node scripts/e2e-editor.mjs   # 실제로 발행까지 한다
//   E2E_CATEGORY='맛집 뿌시기' node scripts/e2e-editor.mjs
//
// 자격증명은 다루지 않는다 — 먼저 `npm run naver:login` 으로 로그인돼 있어야 한다.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[a-zA-Z0-9]+$/.test(specifier)) {
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch {
        // 폴백
      }
    }
    return nextResolve(specifier, context);
  },
});

const { loadConfig } = await import('../lib/config.ts');
const { AsideRepl } = await import('../lib/aside/repl.ts');
const { NaverSession } = await import('../lib/aside/naver-session.ts');
const { NaverPublisher } = await import('../lib/naver/publisher.ts');

/** 저장소에 바이너리를 두지 않으려고 격자 PNG 를 그때그때 만든다. */
async function writeTestPng(destPath) {
  const size = 600;
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(size * 3 + 1);
    for (let x = 0; x < size; x++) {
      const i = 1 + x * 3;
      row[i] = Math.floor((255 * x) / size);
      row[i + 1] = Math.floor((255 * y) / size);
      row[i + 2] = (Math.floor(x / 50) + Math.floor(y / 50)) % 2 === 0 ? 200 : 90;
    }
    rows.push(row);
  }
  const chunk = (tag, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(tag, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  await mkdir(path.dirname(destPath), { recursive: true });
  await writeFile(destPath, png);
  return png.length;
}

const config = loadConfig();
const jobId = 'e2e-editor';
const imageId = 'e2e-image-1';
const imagePath = path.join(config.dataDir, 'e2e', 'test-photo.png');
const bytes = await writeTestPng(imagePath);

const input = {
  jobId,
  category: process.env.E2E_CATEGORY ?? '맛집 뿌시기',
  highlights: 'e2e 자동화 점검용입니다.',
  place: '테스트 장소',
  images: [
    {
      id: imageId,
      originalName: 'test-photo.png',
      path: imagePath,
      mimeType: 'image/png',
      bytes,
      width: 600,
      height: 600,
      order: 0,
    },
  ],
  createdAt: new Date().toISOString(),
};

const draft = {
  title: '[테스트] 자동화 점검용 글입니다',
  intro: '안녕하세요.\n\n이 글은 자동 발행 파이프라인을 점검하려고 올린 테스트 글입니다.\n\n곧 지울 예정이에요.',
  blocks: [{ imageId, caption: '테스트용으로 만든 격자 이미지입니다.', altText: '격자 무늬 테스트 이미지' }],
  outro: '읽어주셔서 감사합니다.\n\n테스트가 끝나면 이 글은 삭제됩니다.',
  tags: ['테스트', '자동화'],
  topic: '일상',
  thumbnailImageId: imageId,
  generatedAt: new Date().toISOString(),
  model: 'e2e-harness',
};

const repl = new AsideRepl(config);
const session = new NaverSession(repl, config);
const publisher = new NaverPublisher(repl, session, config);

try {
  await repl.start();

  const preview = await publisher.fillEditor(draft, input, (message) => console.log('  ' + message));
  console.log(`미리보기: ${preview.screenshotPath}`);

  if (process.env.E2E_PUBLISH === '1') {
    const result = await publisher.publish();
    console.log(`발행 결과: ${JSON.stringify(result)}`);
    if (!result.ok) process.exitCode = 1;
  } else {
    console.log('발행하지 않고 종료합니다 (E2E_PUBLISH=1 이면 실제로 발행합니다).');
    await publisher.abort();
  }
} catch (err) {
  console.error(`실패: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
  try {
    await publisher.abort();
  } catch {
    // 정리 실패는 원인을 가리지 않도록 무시한다
  }
} finally {
  await repl.dispose();
}
