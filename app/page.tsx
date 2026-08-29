'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { LoginBanner } from './components/LoginBanner';
import { Onboarding } from './components/Onboarding';
import { PreviewApproval } from './components/PreviewApproval';
import { ProgressLog } from './components/ProgressLog';
import { UploadForm } from './components/UploadForm';
import { phaseLabel, safeHref } from '@/lib/job/ui-logic';
import type { SetupResponse } from '@/lib/aside/blog-meta';
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

export default function Home() {
  const [job, setJob] = useState<JobState | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  // null = 아직 확인 전. 온보딩을 마쳤는지 서버(=.env·쿠키 파일)에 물어본다.
  const [setup, setSetup] = useState<SetupResponse | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(true);
  // ProgressLog의 EventSource가 매 렌더마다 재구독하지 않도록, refreshJob은 안정된
  // 참조를 유지하고 최신 jobId는 ref로만 읽는다.
  const jobRef = useRef<JobState | null>(null);
  jobRef.current = job;

  const refreshJob = useCallback(async () => {
    const current = jobRef.current;
    if (!current) return;
    try {
      const response = await fetch(`/api/jobs/${current.id}`);
      if (!response.ok) throw new Error(`잡 상태 조회 실패 (${response.status})`);
      const updated = (await response.json()) as JobState;
      setJob(updated);
      setRefreshError(null);
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : '잡 상태를 불러오지 못했습니다.');
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // 파일 기준 상태를 먼저 받아 화면을 띄우고, 이어서 저장된 쿠키가 실제로 살아 있는지
      // 확인한다. 파일만 보면 브라우저에서 로그아웃해도 "준비됨" 으로 보이기 때문이다.
      try {
        const fast = await fetch('/api/setup');
        if (!fast.ok) throw new Error(`설정 상태를 불러오지 못했습니다 (${fast.status})`);
        if (!cancelled) setSetup((await fast.json()) as SetupResponse);
      } catch (err) {
        if (!cancelled) setSetupError(err instanceof Error ? err.message : '설정 상태를 불러오지 못했습니다.');
      }

      try {
        const verified = await fetch('/api/setup?verify=1');
        if (!verified.ok) throw new Error(`로그인 상태를 확인하지 못했습니다 (${verified.status})`);
        if (!cancelled) setSetup((await verified.json()) as SetupResponse);
      } catch (err) {
        if (!cancelled) setSetupError(err instanceof Error ? err.message : '로그인 상태를 확인하지 못했습니다.');
      } finally {
        if (!cancelled) setVerifying(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function handleReset() {
    setJob(null);
    setRefreshError(null);
  }

  return (
    <main className={styles.main}>
      <header className={styles.header}>
        <h1 className={styles.heading}>auto-naver-blog</h1>
        {job && <span className={`${styles.jobId} mono`}>job {job.id}</span>}
      </header>

      {refreshError && <p className={styles.warning}>{refreshError}</p>}

      {setupError && <p className={styles.warning}>{setupError}</p>}

      {!job && verifying && <p className={styles.warning}>네이버 로그인 상태를 확인하는 중입니다…</p>}

      {!job && setup !== null && !setup.ready && (
        <Onboarding state={setup} loggedIn={setup.loggedIn} onState={setSetup} />
      )}

      {!job && setup !== null && setup.ready && (
        <>
          <LoginBanner state={setup} onState={setSetup} />
          <UploadForm onCreated={setJob} categories={setup.categories} />
        </>
      )}

      {job && PROGRESS_PHASES.has(job.phase) && <ProgressLog jobId={job.id} onProgress={refreshJob} />}

      {job && job.phase === 'awaiting_approval' && <PreviewApproval job={job} onPublished={refreshJob} />}

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
    </main>
  );
}
