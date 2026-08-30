import { beforeEach, describe, expect, test } from 'vitest';
import {
  MAX_ATTEMPTS,
  WINDOW_MS,
  clearLoginAttempts,
  clientKey,
  recordLoginAttempt,
  resetLoginAttempts,
} from '@/lib/auth/rate-limit';

const NOW = 1_800_000_000_000;

beforeEach(() => {
  resetLoginAttempts();
});

describe('recordLoginAttempt — 정상', () => {
  test('창 안에서 허용 횟수까지는 통과시킨다', () => {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const decision = recordLoginAttempt('1.2.3.4', NOW);
      expect(decision.allowed).toBe(true);
      expect(decision.remaining).toBe(MAX_ATTEMPTS - attempt);
    }
  });

  test('키가 다르면 서로 영향을 주지 않는다', () => {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) recordLoginAttempt('1.2.3.4', NOW);
    expect(recordLoginAttempt('1.2.3.4', NOW).allowed).toBe(false);
    expect(recordLoginAttempt('5.6.7.8', NOW).allowed).toBe(true);
  });

  test('로그인에 성공하면 카운터를 비운다', () => {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) recordLoginAttempt('1.2.3.4', NOW);
    clearLoginAttempts('1.2.3.4');
    expect(recordLoginAttempt('1.2.3.4', NOW).allowed).toBe(true);
  });
});

describe('recordLoginAttempt — 에러/경계값', () => {
  test('허용 횟수를 넘으면 거절하고 다시 시도할 시각을 알려 준다', () => {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) recordLoginAttempt('1.2.3.4', NOW);
    const decision = recordLoginAttempt('1.2.3.4', NOW);
    expect(decision.allowed).toBe(false);
    expect(decision.remaining).toBe(0);
    expect(decision.retryAfterSec).toBe(WINDOW_MS / 1000);
  });

  test('창이 지나면 다시 허용한다 (경계값: 정확히 창 길이)', () => {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) recordLoginAttempt('1.2.3.4', NOW);
    expect(recordLoginAttempt('1.2.3.4', NOW + WINDOW_MS - 1).allowed).toBe(false);
    expect(recordLoginAttempt('1.2.3.4', NOW + WINDOW_MS).allowed).toBe(true);
  });

  test('거절된 시도가 창을 연장하지는 않는다', () => {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) recordLoginAttempt('1.2.3.4', NOW);
    recordLoginAttempt('1.2.3.4', NOW + 30_000);
    expect(recordLoginAttempt('1.2.3.4', NOW + WINDOW_MS).allowed).toBe(true);
  });

  // 고정 창이었다면 창이 바뀌는 순간 카운터가 통째로 비워져, 몇 초 사이에 허용치의 두 배를
  // 쓸 수 있었다. 어느 60초를 잘라 봐도 10회를 넘지 않아야 한다.
  test('창 경계에서도 허용치의 두 배를 쓰지 못한다', () => {
    recordLoginAttempt('1.2.3.4', NOW);
    for (let attempt = 0; attempt < MAX_ATTEMPTS - 1; attempt++) {
      recordLoginAttempt('1.2.3.4', NOW + 59_000);
    }
    // 첫 시도만 창 밖으로 나갔으므로 딱 한 번 더 허용된다.
    expect(recordLoginAttempt('1.2.3.4', NOW + WINDOW_MS).allowed).toBe(true);
    expect(recordLoginAttempt('1.2.3.4', NOW + WINDOW_MS).allowed).toBe(false);
  });

  test('가장 오래된 시도가 빠져나갈 때까지 기다리라고 알려 준다', () => {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) recordLoginAttempt('1.2.3.4', NOW);
    // 30초가 지났으면 남은 30초를 알려 준다 (창 전체가 아니라).
    expect(recordLoginAttempt('1.2.3.4', NOW + 30_000).retryAfterSec).toBe(30);
  });

  test('남은 시간은 최소 1초로 올림한다 (경계값)', () => {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) recordLoginAttempt('1.2.3.4', NOW);
    expect(recordLoginAttempt('1.2.3.4', NOW + WINDOW_MS - 1).retryAfterSec).toBe(1);
  });
});

describe('clientKey', () => {
  test('x-forwarded-for 의 첫 주소를 쓴다', () => {
    const request = new Request('http://x/', { headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' } });
    expect(clientKey(request)).toBe('203.0.113.9');
  });

  test('헤더가 없으면 모두 한 통을 나눠 쓴다 (전체 합산 제한)', () => {
    expect(clientKey(new Request('http://x/'))).toBe('direct');
  });

  test('헤더가 비어 있어도 던지지 않는다 (경계값)', () => {
    const request = new Request('http://x/', { headers: { 'x-forwarded-for': '  ' } });
    expect(clientKey(request)).toBe('direct');
  });
});
