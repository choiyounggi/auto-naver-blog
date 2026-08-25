#!/usr/bin/env node
// Test double for the `claude` CLI. Never invoked in production — only from
// tests/content/claude-cli.test.ts and tests/content/generator.test.ts, with
// this file's path injected as `config.claudeBin`. Selects a canned response
// by reading a `FAKE_MODE:<mode>` token out of the prompt (the last argv
// element), so the double stays a plain argv-in/stdout-out process just like
// the real CLI — no env-var side channel needed.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, 'fixtures');

const argv = process.argv.slice(2);
const prompt = argv[argv.length - 1] ?? '';

function emitFixture(fileName) {
  const contents = readFileSync(path.join(fixturesDir, fileName), 'utf8');
  process.stdout.write(contents);
  process.exit(0);
}

const modeMatch = /FAKE_MODE:(\S+)/.exec(prompt);
const mode = modeMatch ? modeMatch[1] : null;

switch (mode) {
  case 'garbage':
    process.stdout.write('this is not json {{{');
    process.exit(0);
    break;
  case 'sleep':
    // Never exits on its own — exercises callClaude's timeout + kill path.
    setInterval(() => {}, 1000);
    break;
  case null:
    process.stderr.write(`fake-claude: no FAKE_MODE token found in prompt: ${JSON.stringify(prompt)}\n`);
    process.exit(1);
    break;
  default:
    // Every other mode name maps directly to its fixture file, e.g.
    // FAKE_MODE:success -> fixtures/success.json.
    emitFixture(`${mode}.json`);
}
