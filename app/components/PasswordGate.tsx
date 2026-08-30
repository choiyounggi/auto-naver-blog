'use client';

import { useState } from 'react';
import type { SessionRole } from '@/lib/auth/session';
import styles from './PasswordGate.module.css';

interface PasswordGateProps {
  /** 관리자 비밀번호가 아예 설정돼 있지 않으면 안내 문구가 달라진다. */
  adminAvailable: boolean;
  onAuthenticated: (role: SessionRole) => void;
}

/**
 * 비밀번호를 아는 사람만 앱을 쓸 수 있게 하는 첫 화면.
 *
 * 아이디는 없다 — 비밀번호 하나가 곧 신분이다. 관리자 비밀번호를 넣으면 네이버 로그인까지
 * 할 수 있는 관리자 세션이 된다. 비밀번호는 여기서 서버로 한 번 보내고 끝이며, 화면에도
 * 저장하지 않는다(서버가 준 서명 쿠키만 남는다).
 */
export function PasswordGate({ adminAvailable, onAuthenticated }: PasswordGateProps) {
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting || password === '') return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(body?.error ?? `로그인에 실패했습니다 (${response.status})`);
      }
      // 성공하면 화면에 비밀번호를 남기지 않는다.
      setPassword('');
      onAuthenticated((body as { role: SessionRole }).role);
    } catch (err) {
      setError(err instanceof Error ? err.message : '로그인 중 알 수 없는 오류가 발생했습니다.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className={styles.card}>
      <h2 className={styles.title}>비밀번호를 입력해 주세요</h2>
      <p className={styles.lead}>
        이 앱은 하나의 네이버 블로그에 글을 씁니다. 비밀번호를 받은 사람만 쓸 수 있습니다.
      </p>

      <form className={styles.form} onSubmit={handleSubmit}>
        <input
          className={styles.input}
          type="password"
          name="password"
          autoComplete="current-password"
          placeholder="비밀번호"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          disabled={submitting}
          autoFocus
        />
        <button className={styles.button} type="submit" disabled={submitting || password === ''}>
          {submitting ? '확인 중…' : '들어가기'}
        </button>
      </form>

      {error && <p className={styles.error}>{error}</p>}

      <p className={styles.hint}>
        {adminAvailable
          ? '네이버 로그인·재로그인은 관리자 비밀번호로 들어와야 할 수 있습니다.'
          : '이 서버에는 관리자 비밀번호가 설정돼 있지 않습니다 — 네이버 로그인은 서버를 띄운 사람이 터미널에서 합니다.'}
      </p>
    </section>
  );
}
