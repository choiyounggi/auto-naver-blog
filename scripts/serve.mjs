#!/usr/bin/env node
// 개발/운영 서버를 띄운다. 하는 일은 하나뿐이다 — **어느 주소에 바인딩할지** 정해서
// `next dev|start -H <host>` 로 넘긴다.
//
// 왜 npm 스크립트에서 바로 `next dev -H ...` 하지 않는가:
// 바인딩 주소를 `.env` 에도 적을 수 있어야 하는데, npm 이 스크립트를 실행하는 셸은 `.env` 를
// 읽지 않는다(그건 Next 가 자기 프로세스 안에서 하는 일이다). 그러면 "`.env` 에 0.0.0.0 을
// 적었는데 여전히 루프백에만 열린다" 는 어긋남이 생긴다. 여기서 한 번 정해 자식 프로세스의
// 환경변수로도 그대로 넘기면, 바인딩 주소와 부팅 검사(instrumentation-node.ts)가 항상 같은
// 값을 본다.
//
// 인증 설정 검사는 여기서 하지 않는다 — 규칙이 두 곳에 흩어지지 않도록 lib/auth/config.ts
// 한 곳에만 두고, 서버 부팅 훅이 거부하면 이 프로세스도 그 종료 코드를 그대로 물려받는다.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const DEFAULT_HOST = '127.0.0.1';

// lib/aside/blog-meta.ts 의 parseEnvFile 과 같은 최소 규칙이다. 그쪽을 그대로 쓰지 못하는
// 이유는 이 스크립트가 TypeScript 빌드 이전에, 번들러 없이 도는 순수 Node 스크립트이기
// 때문이다. 다루는 규칙이 `KEY=VALUE` 와 주석뿐이라 옮겨 적는 비용이 더 싸다.
export function readEnvFileValue(content, key) {
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match === null || match[1] !== key) continue;
    const value = match[2].trim();
    return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
  }
  return null;
}

/** 셸 환경변수가 `.env` 보다 우선한다 — 한 번만 다르게 띄우고 싶을 때 앞에 붙여 쓸 수 있게. */
export function resolveBindHost(env, envFileContent) {
  const fromEnv = env.ANB_HOST?.trim();
  if (fromEnv) return fromEnv;
  const fromFile = envFileContent === null ? null : readEnvFileValue(envFileContent, 'ANB_HOST')?.trim();
  return fromFile ? fromFile : DEFAULT_HOST;
}

function main() {
  const [mode, ...extraArgs] = process.argv.slice(2);
  if (mode !== 'dev' && mode !== 'start') {
    console.error("사용법: node scripts/serve.mjs <dev|start> [next 에 넘길 추가 인자...]");
    process.exit(2);
  }

  const envPath = path.join(repoRoot, '.env');
  const host = resolveBindHost(process.env, existsSync(envPath) ? readFileSync(envPath, 'utf8') : null);

  if (host !== DEFAULT_HOST) {
    console.log(`[serve] ${host} 에 바인딩합니다 — 루프백 밖이면 인증 설정이 있어야 부팅됩니다.`);
  }

  const nextBin = path.join(repoRoot, 'node_modules', '.bin', 'next');
  const child = spawn(nextBin, [mode, '-H', host, ...extraArgs], {
    cwd: repoRoot,
    stdio: 'inherit',
    // 부팅 검사가 바인딩 주소와 같은 값을 보게 한다.
    env: { ...process.env, ANB_HOST: host },
  });

  // Ctrl-C 를 그대로 전달한다 — Next 의 종료 훅(instrumentation 의 정리)이 돌아야 한다.
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => child.kill(signal));
  }
  child.on('exit', (code, signal) => {
    process.exit(signal ? 1 : (code ?? 0));
  });
}

// 테스트에서 import 할 때는 서버를 띄우지 않는다.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
