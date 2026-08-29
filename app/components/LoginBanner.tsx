'use client';

import { useState } from 'react';
import type { SetupResponse } from '@/lib/aside/blog-meta';
import styles from './LoginBanner.module.css';

interface LoginBannerProps {
  state: SetupResponse;
  onState: (state: SetupResponse) => void;
}

/**
 * 로그인은 됐지만 '로그인 상태 유지' 없이 된 상태를 알리고, 한 번에 고칠 수단을 준다.
 *
 * 브라우저에서 로그아웃하는 것만으로는 고쳐지지 않는다 — 앱이 저장된 쿠키를 다시 복원하기
 * 때문이다. 그래서 쿠키를 지우고 네이버 로그아웃까지 한 뒤 로그인 화면부터 다시 시작한다.
 */
export function LoginBanner({ state, onState }: LoginBannerProps) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (state.persistence?.keepLoggedIn !== false) return null;

  async function handleRelogin() {
    if (working) return;
    setWorking(true);
    setError(null);
    try {
      const response = await fetch('/api/setup/relogin', { method: 'POST' });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error ?? `다시 로그인에 실패했습니다 (${response.status})`);
      onState(body as SetupResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : '다시 로그인 중 알 수 없는 오류가 발생했습니다.');
    } finally {
      setWorking(false);
    }
  }

  return (
    <section className={styles.banner}>
      <p className={styles.text}>
        지금 로그인은 <strong>브라우저를 닫으면 풀립니다</strong> — &lsquo;로그인 상태 유지&rsquo;가
        꺼진 채로 로그인됐기 때문입니다. 한 번만 다시 로그인하면 그 뒤로는 오래 갑니다.
      </p>
      <button className={styles.button} type="button" onClick={handleRelogin} disabled={working}>
        {working ? '로그인 대기 중…' : '다시 로그인'}
      </button>
      {error && <p className={styles.error}>{error}</p>}
      {working && (
        <p className={styles.error}>
          Aside 브라우저에 로그인 화면을 열었습니다. &lsquo;로그인 상태 유지&rsquo;는 켜 뒀으니
          아이디·비밀번호만 입력해 주세요 (최대 5분 대기).
        </p>
      )}
    </section>
  );
}
