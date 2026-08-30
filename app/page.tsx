'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { LoginBanner } from './components/LoginBanner';
import { Onboarding } from './components/Onboarding';
import { PasswordGate } from './components/PasswordGate';
import { PreviewApproval } from './components/PreviewApproval';
import { ProgressLog } from './components/ProgressLog';
import { UploadForm } from './components/UploadForm';
import { phaseLabel, safeHref, setupScreen } from '@/lib/job/ui-logic';
import type { SetupView } from '@/lib/aside/blog-meta';
import type { SessionRole } from '@/lib/auth/session';
import type { JobPhase, JobState } from '@/lib/types';
import styles from './page.module.css';

// awaiting_approval·published·failed·cancelled은 각자 전용 화면이 있다 — 나머지는
// 전부 진행 중이므로 같은 진행 로그 화면을 쓴다.
const PROGRESS_PHASES: ReadonlySet<JobPhase> = new Set([
  'created',
  'analyzing',
  'drafting',
  'draft_ready',
  'filling_editor',
  'publishing',
]);

/** `/api/auth/session` 응답. 비밀번호 화면을 띄울지 여기서 정한다. */
interface AuthState {
  authRequired: boolean;
  authenticated: boolean;
  role: SessionRole | null;
  adminAvailable: boolean;
}

export default function Home() {
  const [job, setJob] = useState<JobState | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  // null = 아직 확인 전. 인증이 켜져 있는지·로그인했는지 서버에 물어본다.
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  // null = 아직 확인 전. 온보딩을 마쳤는지 서버(=.env·쿠키 파일)에 물어본다.
  const [setup, setSetup] = useState<SetupView | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(true);
  // ProgressLog의 EventSource가 매 렌더마다 재구독하지 않도록, refreshJob은 안정된
  // 참조를 유지하고 최신 jobId는 ref로만 읽는다.
  const jobRef = useRef<JobState | null>(null);
  jobRef.current = job;

  // 세션이 만료되면(쿠키 수명이 다하거나 서버가 다시 잠기면) 어떤 요청이든 401 을 받는다 —
  // 그때는 화면을 비밀번호 입력으로 되돌린다. 조용히 실패한 채로 두지 않는다.
  const handleUnauthorized = useCallback(() => {
    setAuth((current) => (current === null ? current : { ...current, authenticated: false, role: null }));
    setJob(null);
    setSetup(null);
  }, []);

  const refreshJob = useCallback(async () => {
    const current = jobRef.current;
    if (!current) return;
    try {
      const response = await fetch(`/api/jobs/${current.id}`);
      if (response.status === 401) {
        handleUnauthorized();
        return;
      }
      if (!response.ok) throw new Error(`잡 상태 조회 실패 (${response.status})`);
      const updated = (await response.json()) as JobState;
      setJob(updated);
      setRefreshError(null);
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : '잡 상태를 불러오지 못했습니다.');
    }
  }, [handleUnauthorized]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch('/api/auth/session');
        if (!response.ok) throw new Error(`로그인 상태를 확인하지 못했습니다 (${response.status})`);
        if (!cancelled) setAuth((await response.json()) as AuthState);
      } catch (err) {
        if (!cancelled) {
          setAuthError(err instanceof Error ? err.message : '로그인 상태를 확인하지 못했습니다.');
          setVerifying(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const authenticated = auth?.authenticated === true;
  const isAdmin = auth?.role === 'admin';

  useEffect(() => {
    if (!authenticated) return;
    let cancelled = false;
    setVerifying(true);
    (async () => {
      // 파일 기준 상태를 먼저 받아 화면을 띄우고, 이어서 저장된 쿠키가 실제로 살아 있는지
      // 확인한다. 파일만 보면 브라우저에서 로그아웃해도 "준비됨" 으로 보이기 때문이다.
      // 라이브 확인은 Aside 브라우저를 띄우므로 관리자만 한다.
      try {
        const fast = await fetch('/api/setup');
        if (fast.status === 401) {
          if (!cancelled) handleUnauthorized();
          return;
        }
        if (!fast.ok) throw new Error(`설정 상태를 불러오지 못했습니다 (${fast.status})`);
        if (!cancelled) setSetup((await fast.json()) as SetupView);
      } catch (err) {
        if (!cancelled) setSetupError(err instanceof Error ? err.message : '설정 상태를 불러오지 못했습니다.');
      }

      if (!isAdmin) {
        if (!cancelled) setVerifying(false);
        return;
      }

      try {
        const verified = await fetch('/api/setup?verify=1');
        if (verified.status === 401) {
          if (!cancelled) handleUnauthorized();
          return;
        }
        if (!verified.ok) throw new Error(`로그인 상태를 확인하지 못했습니다 (${verified.status})`);
        if (!cancelled) setSetup((await verified.json()) as SetupView);
      } catch (err) {
        if (!cancelled) setSetupError(err instanceof Error ? err.message : '로그인 상태를 확인하지 못했습니다.');
      } finally {
        if (!cancelled) setVerifying(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authenticated, isAdmin, handleUnauthorized]);

  function handleReset() {
    setJob(null);
    setRefreshError(null);
  }

  async function handleLogout() {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // 쿠키를 지우지 못했어도 화면은 잠근다 — 서버에 다시 물어보면 어차피 401 이다.
    }
    handleUnauthorized();
  }

  function handleAuthenticated(role: SessionRole) {
    setAuthError(null);
    setSetupError(null);
    setAuth((current) => ({
      authRequired: true,
      adminAvailable: current?.adminAvailable ?? false,
      authenticated: true,
      role,
    }));
  }

  const needsPassword = auth !== null && auth.authRequired && !auth.authenticated;
  const screen = setupScreen({ verifying, setup });

  return (
    <main className={styles.main}>
      <header className={styles.header}>
        <h1 className={styles.heading}>auto-naver-blog</h1>
        {job && <span className={`${styles.jobId} mono`}>job {job.id}</span>}
        {auth?.authRequired && auth.authenticated && (
          <button className={styles.logoutButton} type="button" onClick={handleLogout}>
            {isAdmin ? '관리자 — 로그아웃' : '로그아웃'}
          </button>
        )}
      </header>

      {authError && <p className={styles.warning}>{authError}</p>}

      {auth === null && !authError && <p className={styles.checking}>로그인 상태를 확인하는 중…</p>}

      {needsPassword && <PasswordGate adminAvailable={auth.adminAvailable} onAuthenticated={handleAuthenticated} />}

      {authenticated && (
        <>
          {refreshError && <p className={styles.warning}>{refreshError}</p>}

          {setupError && <p className={styles.warning}>{setupError}</p>}

          {!job && screen === 'checking' && (
            <p className={styles.checking}>
              {isAdmin ? '네이버 로그인 상태를 확인하는 중…' : '설정을 불러오는 중…'}
            </p>
          )}

          {!job && screen === 'onboarding' && setup?.admin && (
            <Onboarding state={setup} loggedIn={setup.loggedIn} onState={setSetup} />
          )}

          {!job && screen === 'waiting-for-admin' && (
            <p className={styles.notice}>
              아직 글을 쓸 수 없습니다 — 관리자가 네이버 로그인을 해야 합니다. 관리자에게 알려 주세요.
            </p>
          )}

          {!job && screen === 'upload' && setup !== null && (
            <>
              {setup.admin && <LoginBanner state={setup} onState={setSetup} />}
              <UploadForm onCreated={setJob} categories={setup.categories} />
            </>
          )}

          {job && PROGRESS_PHASES.has(job.phase) && <ProgressLog jobId={job.id} onProgress={refreshJob} />}

          {job && job.phase === 'awaiting_approval' && (
            <PreviewApproval job={job} onPublished={refreshJob} onSaved={refreshJob} />
          )}

          {job && job.phase === 'published' && (
            <div className={styles.resultCard}>
              <p className={styles.resultTitle}>발행 완료</p>
              {(() => {
                const href = safeHref(job.result?.postUrl ?? null);
                return href ? (
                  <a className={styles.resultLink} href={href} target="_blank" rel="noreferrer">
                    {href}
                  </a>
                ) : null;
              })()}
              <button className={styles.resetButton} type="button" onClick={handleReset}>
                새 잡 시작
              </button>
            </div>
          )}

          {job && (job.phase === 'failed' || job.phase === 'cancelled') && (
            <div className={styles.resultCard}>
              <p className={styles.resultTitle}>{phaseLabel(job.phase)}</p>
              {job.error && (
                <p className={styles.errorDetail}>
                  {job.error.message} ({job.error.step})
                </p>
              )}
              <button className={styles.resetButton} type="button" onClick={handleReset}>
                새로 시작
              </button>
            </div>
          )}
        </>
      )}
    </main>
  );
}
