'use client';

import { useEffect, useState } from 'react';
import { phaseLabel } from '@/lib/job/ui-logic';
import type { JobLogEntry } from '@/lib/types';
import styles from './ProgressLog.module.css';

interface ProgressLogProps {
  jobId: string;
  onProgress: () => void;
}

export function ProgressLog({ jobId, onProgress }: ProgressLogProps) {
  const [entries, setEntries] = useState<JobLogEntry[]>([]);
  const [connectionError, setConnectionError] = useState(false);

  useEffect(() => {
    setEntries([]);
    setConnectionError(false);

    // D6: EventSource의 내장 자동 재연결(+ Last-Event-ID 이어받기)에 맡긴다 —
    // 직접 재연결 루프를 만들지 않는다.
    const source = new EventSource(`/api/jobs/${jobId}/events`);

    source.onmessage = (event) => {
      setConnectionError(false);
      try {
        const entry = JSON.parse(event.data) as JobLogEntry;
        setEntries((prev) => [...prev, entry]);
      } catch {
        // 형식이 다른 이벤트는 로그에 추가하지 않는다
      }
      onProgress();
    };

    source.onerror = () => {
      setConnectionError(true);
    };

    return () => {
      source.close();
    };
  }, [jobId, onProgress]);

  const latest = entries[entries.length - 1];

  return (
    <div className={styles.container}>
      <p className={styles.status}>{latest ? phaseLabel(latest.phase) : '진행 상황을 기다리는 중…'}</p>
      {connectionError && (
        <p className={styles.warning}>연결이 끊어졌습니다 — 브라우저가 자동으로 재연결합니다…</p>
      )}
      <ul className={styles.log}>
        {entries.map((entry, i) => (
          <li key={i} className={styles.logRow}>
            <span className={`${styles.logTime} mono`}>{new Date(entry.at).toLocaleTimeString('ko-KR')}</span>
            <span className={styles.logMessage}>{entry.message}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
