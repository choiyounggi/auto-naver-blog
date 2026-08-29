'use client';

import { useEffect, useState } from 'react';
import type { ChangeEvent } from 'react';
import type { ImageBlock, JobState, PostDraft } from '@/lib/types';
import styles from './PreviewApproval.module.css';

interface PreviewApprovalProps {
  job: JobState;
  onPublished: () => void;
  /** 초안을 저장했을 때 잡 상태를 새로 읽어오게 한다 */
  onSaved?: () => void;
}

function moveBlock(blocks: ImageBlock[], from: number, to: number): ImageBlock[] {
  if (to < 0 || to >= blocks.length) return blocks;
  const next = [...blocks];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/**
 * 승인 화면. 여기서 본 그대로 발행된다 — 글·소제목·태그를 고치고 사진을 넣거나 빼거나
 * 순서를 바꿀 수 있다. 저장한 내용은 발행할 때 네이버 에디터에 다시 채워진다.
 */
export function PreviewApproval({ job, onPublished, onSaved }: PreviewApprovalProps) {
  const [draft, setDraft] = useState<PostDraft | null>(job.draft);
  const [publishing, setPublishing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  // 사진을 추가하면 서버가 준 새 잡 상태로 초안을 맞춘다.
  useEffect(() => {
    setDraft(job.draft);
  }, [job.draft]);

  if (!draft) {
    return <p className={styles.errorMessage}>초안이 아직 준비되지 않았습니다.</p>;
  }

  // 첫 사진이 대표라는 계약을 화면에서도 지킨다.
  const normalized: PostDraft = { ...draft, thumbnailImageId: draft.blocks[0]?.imageId ?? draft.thumbnailImageId };
  const dirty = JSON.stringify(normalized) !== JSON.stringify(job.draft);

  function update(patch: Partial<PostDraft>) {
    setDraft((current) => (current ? { ...current, ...patch } : current));
    setSavedAt(null);
  }

  function updateBlock(index: number, patch: Partial<ImageBlock>) {
    setDraft((current) => {
      if (!current) return current;
      const blocks = current.blocks.map((block, i) => (i === index ? { ...block, ...patch } : block));
      return { ...current, blocks };
    });
    setSavedAt(null);
  }

  function reorder(index: number, delta: number) {
    setDraft((current) => {
      if (!current) return current;
      const blocks = moveBlock(current.blocks, index, index + delta);
      return { ...current, blocks, thumbnailImageId: blocks[0].imageId };
    });
    setSavedAt(null);
  }

  function removeBlock(index: number) {
    setDraft((current) => {
      if (!current || current.blocks.length <= 1) return current;
      const blocks = current.blocks.filter((_, i) => i !== index);
      return { ...current, blocks, thumbnailImageId: blocks[0].imageId };
    });
    setSavedAt(null);
  }

  async function handleSave(): Promise<boolean> {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/jobs/${job.id}/draft`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draft: normalized }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error ?? `저장 실패 (${response.status})`);
      }
      setSavedAt(new Date().toLocaleTimeString('ko-KR'));
      onSaved?.();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : '초안을 저장하지 못했습니다.');
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function handleAddImages(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (files.length === 0) return;

    setUploading(true);
    setError(null);
    try {
      const formData = new FormData();
      for (const file of files) formData.append('images', file);
      const response = await fetch(`/api/jobs/${job.id}/images`, { method: 'POST', body: formData });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error ?? `사진 추가 실패 (${response.status})`);

      const added = (body.added ?? []) as { id: string }[];
      setDraft((current) =>
        current
          ? {
              ...current,
              blocks: [
                ...current.blocks,
                ...added.map((image) => ({ imageId: image.id, heading: '', caption: '', altText: '' })),
              ],
            }
          : current,
      );
      setSavedAt(null);
      onSaved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : '사진을 추가하지 못했습니다.');
    } finally {
      setUploading(false);
    }
  }

  async function handlePublish() {
    if (publishing) return;
    setPublishing(true);
    setError(null);
    try {
      // 고친 게 남아 있으면 먼저 저장한다 — 화면에서 본 그대로 올라가야 한다.
      if (dirty && !(await handleSave())) return;

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

  const busy = publishing || saving || uploading;

  return (
    <div className={styles.container}>
      <p className={styles.editIntro}>
        아래가 <strong>실제로 올라갈 내용</strong>입니다. 여기서 고친 그대로 발행됩니다.
      </p>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="draft-title">
          제목
        </label>
        <input
          id="draft-title"
          className={styles.titleInput}
          value={draft.title}
          onChange={(e) => update({ title: e.target.value })}
          disabled={busy}
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="draft-intro">
          여는 글
        </label>
        <textarea
          id="draft-intro"
          className={styles.textarea}
          rows={5}
          value={draft.intro}
          onChange={(e) => update({ intro: e.target.value })}
          disabled={busy}
        />
      </div>

      {draft.blocks.map((block, index) => (
        <div key={block.imageId} className={styles.block}>
          <div className={styles.blockHeader}>
            <span className={styles.blockLabel}>
              {index === 0 ? `사진 ${index + 1} · 대표` : `사진 ${index + 1}`}
            </span>
            <div className={styles.blockActions}>
              <button type="button" onClick={() => reorder(index, -1)} disabled={busy || index === 0}>
                ↑
              </button>
              <button
                type="button"
                onClick={() => reorder(index, 1)}
                disabled={busy || index === draft.blocks.length - 1}
              >
                ↓
              </button>
              <button
                type="button"
                onClick={() => removeBlock(index)}
                disabled={busy || draft.blocks.length <= 1}
              >
                빼기
              </button>
            </div>
          </div>

          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            className={styles.image}
            src={`/api/jobs/${job.id}/images/${block.imageId}`}
            alt={block.altText}
          />

          <input
            className={styles.headingInput}
            value={block.heading}
            placeholder="소제목 (선택) — 굵고 큰 글씨로 들어갑니다"
            onChange={(e) => updateBlock(index, { heading: e.target.value })}
            disabled={busy}
          />
          <textarea
            className={styles.textarea}
            rows={4}
            value={block.caption}
            onChange={(e) => updateBlock(index, { caption: e.target.value })}
            disabled={busy}
          />
        </div>
      ))}

      <div className={styles.addImages}>
        <label className={styles.label} htmlFor="draft-add-images">
          사진 추가
        </label>
        <input
          id="draft-add-images"
          type="file"
          accept="image/*"
          multiple
          onChange={handleAddImages}
          disabled={busy}
        />
        {uploading && <span className={styles.hint}>올리는 중…</span>}
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="draft-outro">
          닫는 글
        </label>
        <textarea
          id="draft-outro"
          className={styles.textarea}
          rows={4}
          value={draft.outro}
          onChange={(e) => update({ outro: e.target.value })}
          disabled={busy}
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="draft-tags">
          태그 (쉼표로 구분)
        </label>
        <input
          id="draft-tags"
          className={styles.titleInput}
          value={draft.tags.join(', ')}
          onChange={(e) =>
            update({
              tags: e.target.value
                .split(',')
                .map((tag) => tag.trim())
                .filter((tag) => tag !== ''),
            })
          }
          disabled={busy}
        />
      </div>

      {error && <p className={styles.errorMessage}>{error}</p>}

      <div className={styles.publishBar}>
        <button className={styles.publishButton} type="button" onClick={handlePublish} disabled={busy}>
          {publishing ? '발행 중…' : '네이버 블로그에 발행'}
        </button>
        <button className={styles.saveButton} type="button" onClick={handleSave} disabled={busy || !dirty}>
          {saving ? '저장 중…' : '수정 내용 저장'}
        </button>
        <span className={styles.hint}>
          {dirty
            ? '고친 내용이 있습니다 — 발행을 누르면 자동으로 저장한 뒤 그 내용대로 올립니다.'
            : savedAt
              ? `저장됨 (${savedAt}). 승인 후에만 발행됩니다.`
              : '승인 후에만 발행됩니다. 위 내용을 확인한 뒤 눌러주세요.'}
        </span>
      </div>
    </div>
  );
}
