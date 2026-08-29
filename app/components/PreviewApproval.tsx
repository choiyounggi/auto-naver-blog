'use client';

import { useState } from 'react';
import type { JobState } from '@/lib/types';
import styles from './PreviewApproval.module.css';

interface PreviewApprovalProps {
  job: JobState;
  onPublished: () => void;
  /** 미리보기를 다시 찍은 뒤 잡 상태를 새로 읽어오게 한다 */
  onRefreshed?: () => void;
}

export function PreviewApproval({ job, onPublished, onRefreshed }: PreviewApprovalProps) {
  const [publishing, setPublishing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // 미리보기 이미지를 강제로 다시 받아오기 위한 캐시 무력화 값
  const [previewVersion, setPreviewVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const { draft } = job;

  if (!draft) {
    // phase가 awaiting_approval이면 draft는 항상 채워져 있다 — 방어적 표시일 뿐이다
    return <p className={styles.errorMessage}>초안이 아직 준비되지 않았습니다.</p>;
  }

  async function handleRefresh() {
    if (refreshing || publishing) return;
    setRefreshing(true);
    setError(null);
    try {
      const response = await fetch(`/api/jobs/${job.id}/preview`, { method: 'POST' });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error ?? `미리보기 새로고침 실패 (${response.status})`);
      }
      setPreviewVersion((v) => v + 1);
      onRefreshed?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : '미리보기를 다시 찍지 못했습니다.');
    } finally {
      setRefreshing(false);
    }
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

      <section className={styles.editNotice}>
        <p>
          <strong>고칠 게 있으면 Aside 브라우저에서 직접 고치세요.</strong> 지금 네이버 글쓰기
          화면이 열려 있고, 발행 설정 창은 닫아 뒀습니다. 글·사진·서식 무엇이든 평소처럼
          편집하면 되고, 아래 &lsquo;발행&rsquo;을 누르면 <strong>고친 그대로</strong> 올라갑니다.
        </p>
        <div className={styles.editActions}>
          <button
            className={styles.secondaryButton}
            type="button"
            onClick={handleRefresh}
            disabled={refreshing || publishing}
          >
            {refreshing ? '다시 찍는 중…' : '수정한 화면 다시 보기'}
          </button>
          <span className={styles.hint}>고친 뒤 눌러서 무엇이 발행될지 확인하세요.</span>
        </div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          className={styles.previewShot}
          src={`/api/jobs/${job.id}/preview?v=${previewVersion}`}
          alt="에디터 미리보기"
        />
      </section>

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
