'use client';

import { useState } from 'react';
import type { SetupState } from '@/lib/aside/blog-meta';
import type { LoginPersistence } from '@/lib/aside/login-persistence';
import styles from './Onboarding.module.css';

interface OnboardingProps {
  state: SetupState;
  /** 로그인이 끝났거나 상태를 다시 읽었을 때 부모에게 알린다 */
  onState: (state: SetupState) => void;
}

export function Onboarding({ state, onState }: OnboardingProps) {
  const [waiting, setWaiting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [persistence, setPersistence] = useState<LoginPersistence | null>(null);

  async function handleLogin() {
    if (waiting) return;
    setWaiting(true);
    setError(null);
    try {
      // 사람이 로그인을 마칠 때까지 서버가 기다리므로 이 요청은 몇 분간 열려 있을 수 있다.
      const response = await fetch('/api/setup/login', { method: 'POST' });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(body?.error ?? `로그인에 실패했습니다 (${response.status})`);
      }
      const result = body as SetupState & { persistence?: LoginPersistence };
      setPersistence(result.persistence ?? null);
      onState(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : '로그인 중 알 수 없는 오류가 발생했습니다.');
    } finally {
      setWaiting(false);
    }
  }

  async function handleRecheck() {
    if (checking) return;
    setChecking(true);
    setError(null);
    try {
      const response = await fetch('/api/setup');
      if (!response.ok) throw new Error(`상태를 불러오지 못했습니다 (${response.status})`);
      onState((await response.json()) as SetupState);
    } catch (err) {
      setError(err instanceof Error ? err.message : '상태를 불러오지 못했습니다.');
    } finally {
      setChecking(false);
    }
  }

  return (
    <section className={styles.card}>
      <h2 className={styles.title}>시작하기 전에 — 네이버 로그인</h2>

      <p className={styles.lead}>
        글을 쓰려면 먼저 네이버에 로그인해야 합니다. 로그인은 <strong>영기님이 직접</strong> Aside
        브라우저에서 합니다 — 이 앱은 아이디·비밀번호를 받지도, 저장하지도 않습니다.
      </p>

      <ol className={styles.steps}>
        <li>아래 &ldquo;네이버 로그인 시작&rdquo;을 누르면 Aside 브라우저에 네이버 창이 열립니다.</li>
        <li>
          Aside 앱이 뒤에 있으면 창이 안 보일 수 있습니다 — Dock이나 <span className="mono">⌘Tab</span>
          으로 Aside를 앞으로 가져오세요.
        </li>
        <li>
          아이디·비밀번호만 직접 입력합니다 — &lsquo;로그인 상태 유지&rsquo;는 자동으로 켜 둡니다.
          그래야 브라우저를 닫아도 로그인이 풀리지 않습니다.
        </li>
        <li>로그인이 확인되면 쿠키와 블로그 정보(아이디·카테고리)가 자동으로 저장됩니다.</li>
      </ol>

      <div className={styles.checklist}>
        <div className={styles.checkRow}>
          <span className={state.hasCookies ? styles.done : styles.pending}>
            {state.hasCookies ? '완료' : '대기'}
          </span>
          <span>네이버 로그인 쿠키</span>
        </div>
        <div className={styles.checkRow}>
          <span className={state.blogId ? styles.done : styles.pending}>
            {state.blogId ? '완료' : '대기'}
          </span>
          <span>블로그 아이디{state.blogId ? ` — ${state.blogId}` : ''}</span>
        </div>
        <div className={styles.checkRow}>
          <span className={state.categories.length > 0 ? styles.done : styles.pending}>
            {state.categories.length > 0 ? '완료' : '대기'}
          </span>
          <span>
            카테고리
            {state.categories.length > 0 ? ` ${state.categories.length}개 — ${state.categories.join(', ')}` : ''}
          </span>
        </div>
      </div>

      {error && <p className={styles.error}>{error}</p>}

      {persistence !== null && !persistence.keepLoggedIn && (
        <p className={styles.error}>
          로그인은 됐지만 인증 쿠키가 세션 쿠키입니다 — 브라우저를 닫으면 풀립니다.
          &lsquo;로그인 상태 유지&rsquo;를 체크한 뒤 다시 로그인해 주세요.
        </p>
      )}
      {persistence !== null && persistence.keepLoggedIn && (
        <p className={styles.waiting}>
          로그인이 유지됩니다 — 인증 쿠키 만료 {persistence.expiresAt?.slice(0, 10)}. 그때까지 다시
          로그인하지 않아도 됩니다.
        </p>
      )}

      {waiting && (
        <p className={styles.waiting}>
          Aside 브라우저에서 로그인을 기다리는 중입니다 (최대 5분). 창이 안 보이면 Aside 앱을 앞으로
          가져오세요.
        </p>
      )}

      <div className={styles.actions}>
        <button className={styles.primaryButton} type="button" onClick={handleLogin} disabled={waiting}>
          {waiting ? '로그인 대기 중…' : '네이버 로그인 시작'}
        </button>
        <button
          className={styles.secondaryButton}
          type="button"
          onClick={handleRecheck}
          disabled={waiting || checking}
        >
          {checking ? '확인 중…' : '상태 다시 확인'}
        </button>
      </div>

      <p className={styles.cliHint}>
        터미널에서 <span className="mono">npm run naver:login</span> 을 실행해도 똑같이 동작합니다.
      </p>
    </section>
  );
}
