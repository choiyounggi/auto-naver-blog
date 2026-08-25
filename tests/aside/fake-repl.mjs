#!/usr/bin/env node
// 테스트 전용 픽스처: `aside repl` 의 센티넬 프로토콜을 흉내낸다.
// __FAKE_ECHO__/__FAKE_ERROR__/__FAKE_HANG__/__FAKE_DIE__/__FAKE_SLOW__ 제어 토큰은 이
// 픽스처 전용이며 lib/ 코드는 이 토큰을 알지 못한다. `chmod +x` 없이 `node <path>` 로만 실행한다.

import readline from 'node:readline';

const PROMPT = '\x1b[32mrepl\x1b[0m \x1b[33m>\x1b[0m ';

function ok(ms) {
  return `\x1b[2m[ok | ${ms}ms]\x1b[0m`;
}

function error(ms) {
  return `\x1b[31m[error | ${ms}ms]\x1b[0m`;
}

process.stdout.write('account: u0 (dch020223@gmail.com)\n');
process.stdout.write('sessionDir: /Users/fixture/.aside/u/0/sessions/fixture-session\n');
process.stdout.write("type 'help' for usage, 'state' to inspect tool state, 'exit' to quit\n");
process.stdout.write(PROMPT);

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  if (line.includes('__FAKE_HANG__')) {
    // 의도적으로 센티넬을 내지 않는다 (타임아웃/음성 대조용)
    return;
  }
  if (line.includes('__FAKE_DIE__')) {
    process.exit(1);
  }
  if (line.includes('__FAKE_ERROR__')) {
    process.stdout.write(`${error(7)}\n${PROMPT}`);
    return;
  }
  const echoMatch = line.match(/__FAKE_ECHO__:(\S*)/);
  if (echoMatch) {
    process.stdout.write(`${echoMatch[1]}\n${ok(12)}\n${PROMPT}`);
    return;
  }
  const slowMatch = line.match(/__FAKE_SLOW__:(\d+):(\S*)/);
  if (slowMatch) {
    // F1 회귀용: 이 스텝을 요청한 evaluate() 가 이미 타임아웃되어 버려진 뒤에도, 지연된
    // 출력이 실제로 도착하는 상황을 재현한다 (드레이닝 로직이 없으면 다음 스텝이 이걸 삼킨다).
    const delayMs = Number(slowMatch[1]);
    const text = slowMatch[2];
    setTimeout(() => {
      process.stdout.write(`${text}\n${ok(12)}\n${PROMPT}`);
    }, delayMs);
    return;
  }
  process.stdout.write(`${ok(12)}\n${PROMPT}`);
});
