import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * 공유 비밀번호 비교.
 *
 * 비밀번호 자체는 환경변수로만 들어온다(저장소·코드에 두지 않는다). 코드는 그 평문을
 * 그대로 비교하지 않는다 — 양쪽을 sha256 으로 고정 길이 다이제스트로 만든 뒤
 * `timingSafeEqual` 로 비교한다. 이유는 두 가지다.
 *
 *  1. `===` 는 앞자리가 맞을수록 오래 걸린다 — 응답 시간으로 한 글자씩 알아낼 수 있다.
 *  2. `timingSafeEqual` 은 길이가 다르면 던진다. 먼저 해시로 길이를 32바이트로 고정하면
 *     비밀번호 길이조차 응답에 새지 않는다.
 *
 * 이건 "비밀번호 저장용 해시"(scrypt/bcrypt 류)가 아니다 — 원본이 이미 환경변수에 평문으로
 * 있으므로 KDF 를 얹어도 지킬 게 없다. 여기서 얻는 것은 상수 시간 비교뿐이다.
 */
export function hashPassword(password: string): Buffer {
  return createHash('sha256').update(password, 'utf8').digest();
}

export function passwordMatches(candidate: string, expectedHash: Buffer): boolean {
  const candidateHash = hashPassword(candidate);
  // sha256 끼리는 항상 32바이트라 같지만, 다른 다이제스트가 섞여 들어오면 throw 하는 대신
  // 불일치로 처리한다.
  if (candidateHash.length !== expectedHash.length) return false;
  return timingSafeEqual(candidateHash, expectedHash);
}
