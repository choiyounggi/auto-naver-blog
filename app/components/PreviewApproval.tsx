'use client';

import { useState } from 'react';
import type { JobState } from '@/lib/types';
import styles from './PreviewApproval.module.css';

interface PreviewApprovalProps {
  job: JobState;
  onPublished: () => void;
}

export function PreviewApproval({ job, onPublished }: PreviewApprovalProps) {
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { draft } = job;

  if (!draft) {
    // phase가 awaiting_approval이면 draft는 항상 채워져 있다 — 방어적 표시일 뿐이다
    return <p className={styles.errorMessage}>초안이 아직 준비되지 않았습니다.</p>;
  }

  async function handlePublish() {
    if (publishing) return;
    setPublishing(true);
    setError(null);
    try {
      const response = await fetch(`/api/jobs/${job.id}/publish`, { method: 'POST' });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error ?? `발행 요청 실패 (${response.status})`);
      }
      onPublished();
    } catch (err) {
      setError(err instanceof Error ? err.message : '알 수 없는 오류로 발행 요청에 실패했습니다.');
    } finally {
      setPublishing(false);
    }
  }

  return (
    <div className={styles.container}>
      <div className={styles.summary}>
        <span className={styles.title}>{draft.title}</span>
        <div className={styles.meta}>
          <span>주제: {draft.topic}</span>
          <span className="mono">이미지 {draft.blocks.length}장</span>
        </div>
        <div className={styles.tags}>
          {draft.tags.map((tag) => (
            <span key={tag} className={styles.tag}>
              #{tag}
            </span>
          ))}
        </div>
      </div>

      <p className={styles.prose}>{draft.intro}</p>

      {draft.blocks.map((block) => (
        <div key={block.imageId} className={styles.block}>
          <span className={styles.blockLabel}>
            {block.imageId === draft.thumbnailImageId ? '대표 이미지' : '이미지'}
          </span>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            className={styles.image}
            src={`/api/jobs/${job.id}/images/${block.imageId}`}
            alt={block.altText}
          />
          <p className={styles.caption}>{block.caption}</p>
        </div>
      ))}

      <p className={styles.prose}>{draft.outro}</p>

      {error && <p className={styles.errorMessage}>{error}</p>}

      <div className={styles.publishBar}>
        <button className={styles.publishButton} type="button" onClick={handlePublish} disabled={publishing}>
          {publishing ? '발행 중…' : '네이버 블로그에 발행'}
        </button>
        <span>승인 후에만 발행됩니다. 위 내용을 확인한 뒤 눌러주세요.</span>
      </div>
    </div>
  );
}
