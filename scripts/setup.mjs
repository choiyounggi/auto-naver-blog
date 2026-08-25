#!/usr/bin/env node
// 최초 설정 점검 스크립트. t5 D9: 점검과 안내만 한다 — 자격증명을 받지 않고 로그인을
// 자동으로 하지 않는다. 실패해도 파괴적 동작(삭제·덮어쓰기)을 하지 않는다.

import { registerHooks } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';

// lib/*.ts 는 tsc(bundler moduleResolution)에 맞춰 확장자 없이 상대경로를 import 한다.
// Node 의 네이티브 TypeScript 실행기는 확장자가 정확히 일치하는 파일만 찾으므로, 이 스크립트
// 안에서만 상대경로 뒤에 .ts 를 붙여 재시도하는 resolve 훅을 등록해 그 간극을 메운다.
// scripts/naver-login.mjs 와 같은 패턴이다. 공유 tsconfig.json 은 건드리지 않는다.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[a-zA-Z0-9]+$/.test(specifier)) {
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch {
        // 폴백: 기본 동작으로 넘긴다
      }
    }
    return nextResolve(specifier, context);
  },
});

const { loadConfig } = await import('../lib/config.ts');

// 읽기 전용 호출만 한다 — 실행 가능 여부만 확인하고, 어떤 인자도 브라우저나 LLM 을
// 움직이지 않는다.
function isBinaryAvailable(bin) {
  try {
    execFileSync(bin, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function printCheck(ok, label) {
  console.log(`${ok ? '✓' : '✗'} ${label}`);
}

async function main() {
  console.log('=== auto-naver-blog 최초 설정 점검 ===\n');

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`✗ 설정을 불러오지 못했습니다: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }
  printCheck(true, '설정을 불러왔습니다.');

  const asideOk = isBinaryAvailable(config.asideBin);
  printCheck(asideOk, `aside 실행 파일(${config.asideBin})을 ${asideOk ? '찾았습니다' : '찾지 못했습니다'}.`);

  const claudeOk = isBinaryAvailable(config.claudeBin);
  printCheck(claudeOk, `claude 실행 파일(${config.claudeBin})을 ${claudeOk ? '찾았습니다' : '찾지 못했습니다'}.`);

  // 없으면 생성, 있으면 그대로 둔다 — 삭제·덮어쓰기 없음.
  await mkdir(config.dataDir, { recursive: true });
  printCheck(true, `데이터 디렉터리를 준비했습니다: ${config.dataDir}`);

  const cookieOk = existsSync(config.cookieFile);
  printCheck(cookieOk, `네이버 로그인 쿠키를 ${cookieOk ? '찾았습니다' : '찾지 못했습니다'}.`);

  console.log('\n=== 다음에 할 일 ===');
  const nextSteps = [];
  if (!asideOk) {
    nextSteps.push('aside CLI 를 설치하고 PATH 에 추가하세요.');
  }
  if (!claudeOk) {
    nextSteps.push('claude CLI 를 설치하고 PATH 에 추가하세요.');
  }
  if (!cookieOk) {
    nextSteps.push('npm run naver:login 을 실행해 네이버에 로그인하세요 (자동 로그인이 아니라 사람이 직접 로그인합니다).');
  }
  nextSteps.push(
    '⚠️ lib/naver/** 의 스마트에디터 조작은 아직 실제 네이버 화면에 대해 검증된 적이 없습니다 — docs/naver-live-validation.md 를 읽어보세요.',
  );
  nextSteps.push('npm run dev 로 로컬 서버를 시작하세요 (http://127.0.0.1:3000).');

  nextSteps.forEach((step, i) => console.log(`${i + 1}. ${step}`));

  if (!asideOk || !claudeOk) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`setup 실행 중 오류: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
