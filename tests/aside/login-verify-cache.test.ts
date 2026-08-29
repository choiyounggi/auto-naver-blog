import { beforeEach, describe, expect, test } from 'vitest';
import {
  DEFAULT_VERIFY_TTL_MS,
  clearVerifyCache,
  readVerifyCache,
  writeVerifyCache,
} from '@/lib/aside/login-verify-cache';

beforeEach(() => {
  clearVerifyCache();
});

describe('로그인 확인 캐시 — 정상', () => {
  test('쓴 값을 유효 기간 안에서는 그대로 돌려준다', () => {
    writeVerifyCache({ loggedIn: true, reason: null }, 1_000);
    expect(readVerifyCache(1_000 + 1_000)).toEqual({ loggedIn: true, reason: null });
  });

  test('로그인 실패 결과도 캐시된다(사유까지 보존)', () => {
    writeVerifyCache({ loggedIn: false, reason: 'expired' }, 1_000);
    expect(readVerifyCache(1_500)).toEqual({ loggedIn: false, reason: 'expired' });
  });
});

describe('로그인 확인 캐시 — 만료/무효화', () => {
  test('유효 기간이 지나면 null 이다', () => {
    writeVerifyCache({ loggedIn: true, reason: null }, 0);
    expect(readVerifyCache(DEFAULT_VERIFY_TTL_MS)).toBeNull();
  });

  test('경계값: 유효 기간 직전은 살아 있고, 정확히 만료 시점은 죽는다', () => {
    writeVerifyCache({ loggedIn: true, reason: null }, 0);
    expect(readVerifyCache(DEFAULT_VERIFY_TTL_MS - 1)).not.toBeNull();
    expect(readVerifyCache(DEFAULT_VERIFY_TTL_MS)).toBeNull();
  });

  test('clearVerifyCache 후에는 null 이다 (로그인 직후 갱신 경로)', () => {
    writeVerifyCache({ loggedIn: true, reason: null }, 1_000);
    clearVerifyCache();
    expect(readVerifyCache(1_000)).toBeNull();
  });

  test('경계값: 쓴 적이 없으면 null 이다', () => {
    expect(readVerifyCache(0)).toBeNull();
  });

  test('짧은 TTL 을 주면 그만큼만 유효하다', () => {
    writeVerifyCache({ loggedIn: true, reason: null }, 0);
    expect(readVerifyCache(500, 1_000)).not.toBeNull();
    expect(readVerifyCache(1_500, 1_000)).toBeNull();
  });
});
