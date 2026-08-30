import { hashPassword } from './password';

export const DEFAULT_HOST = '127.0.0.1';

/** 공유 비밀번호 최소 길이. 여럿이 나눠 쓰는 비밀번호라 네 글자짜리를 허용하지 않는다. */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * 서명 키 최소 길이. HMAC-SHA256 의 블록 크기(64바이트)에는 못 미치지만, 사람이 손으로
 * 만들어 넣는 값이라 현실적인 하한을 둔다 — `openssl rand -hex 32` 가 64자를 준다.
 */
export const MIN_SESSION_SECRET_LENGTH = 32;

export type AuthMode = 'open' | 'password';

export interface AuthConfig {
  /** 'open' = 비밀번호 미설정(루프백 전용). 'password' = 공유 비밀번호로 잠긴 상태. */
  mode: AuthMode;
  host: string;
  loopback: boolean;
  accessPasswordHash: Buffer | null;
  /** 미설정이면 관리자 세션을 만들 수 없다 — 관리자 전용 경로는 아무도 못 쓴다. */
  adminPasswordHash: Buffer | null;
  sessionSecret: string | null;
}

/** 설정이 잘못돼 서버가 뜨면 안 되는 상태. 메시지는 사람이 읽고 고칠 수 있게 쓴다. */
export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthConfigError';
  }
}

/**
 * 이 호스트로 바인딩하면 같은 기계에서만 접근할 수 있는가.
 *
 * `0.0.0.0`/`::` 는 모든 인터페이스라 루프백이 아니고, `127.0.0.0/8` 전체와 `::1` 은
 * 루프백이다. 판정을 잘못하면 인증 없이 외부에 열리므로, 모르는 값은 전부 "외부"로 본다.
 */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (normalized === 'localhost') return true;
  if (normalized === '::1') return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized)) return true;
  return false;
}

export function resolveHost(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.ANB_HOST?.trim();
  return raw === undefined || raw === '' ? DEFAULT_HOST : raw;
}

function readSecretValue(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  // 공백만 있는 값은 "설정하지 않은 것"으로 본다 — 따옴표만 남은 .env 줄이 인증을 켠 것처럼
  // 보이는 상태를 만들지 않는다.
  return raw.trim() === '' ? null : raw;
}

/**
 * 인증 설정을 읽는다. 잘못된 조합은 조용히 무인증으로 도는 대신 여기서 던진다.
 *
 * 라우트가 요청마다 부르므로(AppConfig 와 같은 방식), 부팅 검사를 통과했더라도 뒤늦게
 * 환경이 망가지면 요청이 실패(500)한다 — 열린 채로 계속 도는 것보다 낫다.
 */
export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const host = resolveHost(env);
  const loopback = isLoopbackHost(host);

  const accessPassword = readSecretValue(env.ANB_ACCESS_PASSWORD);
  const adminPassword = readSecretValue(env.ANB_ADMIN_PASSWORD);
  const sessionSecret = readSecretValue(env.ANB_SESSION_SECRET);

  if (accessPassword === null) {
    if (adminPassword !== null) {
      throw new AuthConfigError(
        'ANB_ADMIN_PASSWORD 만 설정돼 있고 ANB_ACCESS_PASSWORD 가 없습니다 — ' +
          '공유 비밀번호 없이는 관리자 구분에 의미가 없습니다. 둘 다 설정하세요.',
      );
    }
    if (!loopback) {
      throw new AuthConfigError(
        `ANB_HOST='${host}' 로 외부에 열려 하는데 ANB_ACCESS_PASSWORD 가 없습니다 — ` +
          '주소를 아는 누구나 발행할 수 있게 되므로 부팅을 거부합니다. ' +
          'ANB_ACCESS_PASSWORD·ANB_ADMIN_PASSWORD·ANB_SESSION_SECRET 을 설정하거나, ' +
          `ANB_HOST 를 '${DEFAULT_HOST}' 로 두세요.`,
      );
    }
    return {
      mode: 'open',
      host,
      loopback,
      accessPasswordHash: null,
      adminPasswordHash: null,
      sessionSecret: null,
    };
  }

  if (accessPassword.length < MIN_PASSWORD_LENGTH) {
    throw new AuthConfigError(`ANB_ACCESS_PASSWORD 는 ${MIN_PASSWORD_LENGTH}자 이상이어야 합니다.`);
  }
  if (sessionSecret === null) {
    throw new AuthConfigError(
      'ANB_SESSION_SECRET 이 없습니다 — 세션 쿠키에 서명할 수 없습니다. ' +
        "`openssl rand -hex 32` 로 만든 값을 넣으세요.",
    );
  }
  if (sessionSecret.length < MIN_SESSION_SECRET_LENGTH) {
    throw new AuthConfigError(
      `ANB_SESSION_SECRET 은 ${MIN_SESSION_SECRET_LENGTH}자 이상이어야 합니다 (\`openssl rand -hex 32\`).`,
    );
  }
  if (adminPassword !== null && adminPassword.length < MIN_PASSWORD_LENGTH) {
    throw new AuthConfigError(`ANB_ADMIN_PASSWORD 는 ${MIN_PASSWORD_LENGTH}자 이상이어야 합니다.`);
  }
  if (adminPassword !== null && adminPassword === accessPassword) {
    throw new AuthConfigError(
      'ANB_ADMIN_PASSWORD 가 ANB_ACCESS_PASSWORD 와 같습니다 — 같으면 모든 사용자가 관리자가 됩니다.',
    );
  }

  return {
    mode: 'password',
    host,
    loopback,
    accessPasswordHash: hashPassword(accessPassword),
    adminPasswordHash: adminPassword === null ? null : hashPassword(adminPassword),
    sessionSecret,
  };
}

export interface BootCheckResult {
  ok: boolean;
  /** 부팅을 거부한 이유(ok=false) 또는 사람이 알아야 할 경고(ok=true, 없으면 null). */
  message: string | null;
  config: AuthConfig | null;
}

/**
 * 부팅 시 한 번 부른다. 던지는 대신 결과를 돌려주므로, 호출자가 이유를 출력하고
 * 프로세스를 끝낼 수 있다(테스트에서도 프로세스를 죽이지 않고 확인할 수 있다).
 */
export function checkBootConfig(env: NodeJS.ProcessEnv = process.env): BootCheckResult {
  let config: AuthConfig;
  try {
    config = loadAuthConfig(env);
  } catch (err) {
    if (err instanceof AuthConfigError) {
      return { ok: false, message: err.message, config: null };
    }
    throw err;
  }

  if (config.mode === 'open') {
    return {
      ok: true,
      message: `인증이 꺼져 있습니다 — ${config.host} (루프백) 에만 바인딩되므로 이 기계에서만 열립니다.`,
      config,
    };
  }
  if (config.adminPasswordHash === null) {
    return {
      ok: true,
      message:
        'ANB_ADMIN_PASSWORD 가 없습니다 — 네이버 로그인·재로그인은 화면에서 할 수 없습니다 ' +
        '(터미널에서 `npm run naver:login` 은 그대로 쓸 수 있습니다).',
      config,
    };
  }
  return { ok: true, message: null, config };
}
