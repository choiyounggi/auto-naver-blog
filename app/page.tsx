'use client';

import { useCallback, useRef, useState } from 'react';
import { PreviewApproval } from './components/PreviewApproval';
import { ProgressLog } from './components/ProgressLog';
import { UploadForm } from './components/UploadForm';
import { phaseLabel, safeHref } from '@/lib/job/ui-logic';
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

      {!job && <UploadForm onCreated={setJob} />}

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
