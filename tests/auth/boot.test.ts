import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { registerNode } from '@/instrumentation-node';
import { getServices, resetServices } from '@/lib/job/services';
import { disposeServices } from '@/lib/pipeline';

// 부팅 거부는 process.exit(1) 로 끝난다 — 테스트 프로세스를 죽이지 않도록 그 지점만 가로채고,
// 나머지(설정 판정·메시지)는 실제 코드가 그대로 돌게 둔다.
class ProcessExit extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

const ENV_KEYS = ['ANB_ACCESS_PASSWORD', 'ANB_ADMIN_PASSWORD', 'ANB_SESSION_SECRET', 'ANB_HOST', 'ANB_DATA_DIR'] as const;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  // 보안 정책: /tmp·$TMPDIR 금지 — 프로젝트 안에만 만든다. data/ 를 건드리지 않기 위한 격리다.
  process.env.ANB_DATA_DIR = path.join(process.cwd(), '.vitest-tmp', `boot-${randomUUID()}`);
  resetServices();
});

afterEach(async () => {
  await disposeServices();
  resetServices();
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function interceptExit(): { exit: ReturnType<typeof vi.spyOn>; errors: string[] } {
  const errors: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ProcessExit(code);
  }) as never);
  return { exit, errors };
}

describe('부팅 검사 (완료 기준 5)', () => {
  test('외부 바인딩인데 비밀번호·서명 키가 없으면 부팅을 거부하고 이유를 출력한다', async () => {
    process.env.ANB_HOST = '0.0.0.0';
    const { exit, errors } = interceptExit();

    await expect(registerNode()).rejects.toBeInstanceOf(ProcessExit);
    expect(exit).toHaveBeenCalledWith(1);
    expect(errors.join('\n')).toMatch(/ANB_ACCESS_PASSWORD/);
    // 부팅이 멈췄으므로 서비스도 주입되지 않았다 — 무인증으로 한 요청도 처리하지 않는다.
    expect(() => getServices()).toThrow();
  });

  test('외부 바인딩이어도 인증이 갖춰져 있으면 부팅한다', async () => {
    process.env.ANB_HOST = '0.0.0.0';
    process.env.ANB_ACCESS_PASSWORD = 'shared-secret';
    process.env.ANB_ADMIN_PASSWORD = 'admin-secret';
    process.env.ANB_SESSION_SECRET = 'f'.repeat(64);
    const { exit } = interceptExit();

    await registerNode();
    expect(exit).not.toHaveBeenCalled();
    expect(typeof getServices().publisher.fillEditor).toBe('function');
  });

  test('기본값(루프백)에서는 인증 없이도 부팅하되 그 사실을 알린다', async () => {
    const warnings: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    });
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ProcessExit(code);
    }) as never);

    await registerNode();
    expect(exit).not.toHaveBeenCalled();
    expect(warnings.join('\n')).toMatch(/인증이 꺼져/);
  });

  test('설정이 어긋나면(관리자 비밀번호만 설정) 부팅을 거부한다 (경계값)', async () => {
    process.env.ANB_ADMIN_PASSWORD = 'admin-secret';
    const { exit, errors } = interceptExit();

    await expect(registerNode()).rejects.toBeInstanceOf(ProcessExit);
    expect(exit).toHaveBeenCalledWith(1);
    expect(errors.join('\n')).toMatch(/ANB_ADMIN_PASSWORD/);
  });
});
