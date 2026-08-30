import { describe, expect, test } from 'vitest';
import { hashPassword, passwordMatches } from '@/lib/auth/password';

describe('hashPassword — 정상', () => {
  test('sha256 이므로 32바이트 다이제스트를 만든다', () => {
    expect(hashPassword('correct horse battery staple').length).toBe(32);
  });

  test('같은 입력은 같은 다이제스트를, 다른 입력은 다른 다이제스트를 만든다', () => {
    expect(hashPassword('secret-1').equals(hashPassword('secret-1'))).toBe(true);
    expect(hashPassword('secret-1').equals(hashPassword('secret-2'))).toBe(false);
  });

  test('길이가 크게 달라도 다이제스트 길이는 같다 (길이가 새지 않는다)', () => {
    expect(hashPassword('a').length).toBe(hashPassword('a'.repeat(4096)).length);
  });
});

describe('passwordMatches — 정상/에러', () => {
  test('맞는 비밀번호는 통과한다', () => {
    expect(passwordMatches('열려라참깨', hashPassword('열려라참깨'))).toBe(true);
  });

  test('틀린 비밀번호는 막는다', () => {
    expect(passwordMatches('열려라참깨!', hashPassword('열려라참깨'))).toBe(false);
  });

  test('한 글자만 달라도 막는다', () => {
    expect(passwordMatches('shared-secret-a', hashPassword('shared-secret-b'))).toBe(false);
  });

  test('길이가 다른 다이제스트가 들어오면 던지지 않고 불일치로 본다', () => {
    expect(passwordMatches('anything', Buffer.alloc(16))).toBe(false);
  });
});

describe('passwordMatches — 경계값', () => {
  test('빈 문자열끼리는 일치한다 (빈 비밀번호는 설정 단계에서 거른다)', () => {
    expect(passwordMatches('', hashPassword(''))).toBe(true);
  });

  test('빈 후보는 설정된 비밀번호와 일치하지 않는다', () => {
    expect(passwordMatches('', hashPassword('shared-secret'))).toBe(false);
  });

  test('앞뒤 공백은 다른 비밀번호로 본다', () => {
    expect(passwordMatches(' shared-secret', hashPassword('shared-secret'))).toBe(false);
  });
});
