'use client';

import { useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { formatBytes, imageOrderLabel, validateClientUpload } from '@/lib/job/ui-logic';
import type { JobState } from '@/lib/types';
import styles from './UploadForm.module.css';

// 서버 검증이 진짜 관문이다 (D3) — 여기 상수는 사용자 안내용이며 서버 값과
// 어긋나면 안 되지만, 실제 강제는 항상 app/api/jobs/route.ts에서 일어난다.
const MAX_IMAGES_PER_JOB = 20;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

interface UploadFormProps {
  onCreated: (job: JobState) => void;
}

export function UploadForm({ onCreated }: UploadFormProps) {
  const [category, setCategory] = useState('');
  const [highlights, setHighlights] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleFilesChange(event: ChangeEvent<HTMLInputElement>) {
    setFiles(Array.from(event.target.files ?? []));
  }

  const clientError = validateClientUpload(files, {
    maxCount: MAX_IMAGES_PER_JOB,
    maxBytesPerImage: MAX_IMAGE_BYTES,
  });

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (clientError || submitting) return;

    setSubmitting(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.set('category', category);
      formData.set('highlights', highlights);
      for (const file of files) {
        formData.append('images', file);
      }

      const response = await fetch('/api/jobs', { method: 'POST', body: formData });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error ?? `업로드 실패 (${response.status})`);
      }
      const job = (await response.json()) as JobState;
      onCreated(job);
    } catch (err) {
      setError(err instanceof Error ? err.message : '알 수 없는 오류로 업로드에 실패했습니다.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={handleSubmit}>
      <div className={styles.field}>
        <label className={styles.label} htmlFor="category">
          카테고리
        </label>
        <input
          id="category"
          className={styles.input}
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          required
          disabled={submitting}
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="highlights">
          강조할 내용
        </label>
        <textarea
          id="highlights"
          className={styles.textarea}
          value={highlights}
          onChange={(e) => setHighlights(e.target.value)}
          required
          disabled={submitting}
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="images">
          사진 (첫 장이 대표 이미지가 됩니다)
        </label>
        <input
          id="images"
          className={styles.fileInput}
          type="file"
          accept="image/*"
          multiple
          onChange={handleFilesChange}
          disabled={submitting}
        />
        <span className={styles.hint}>
          장당 최대 {formatBytes(MAX_IMAGE_BYTES)}, 최대 {MAX_IMAGES_PER_JOB}장. 서버가 실제 파일
          내용을 검사해 최종 허용 여부를 결정합니다.
        </span>

        {files.length > 0 && (
          <ul className={styles.fileList}>
            {files.map((file, order) => (
              <li key={`${file.name}-${order}`} className={styles.fileRow} data-thumbnail={order === 0}>
                <span className={`${styles.fileOrder} mono`}>{imageOrderLabel(order, files.length)}</span>
                <span className={styles.fileName}>{file.name}</span>
                <span className={`${styles.fileSize} mono`}>{formatBytes(file.size)}</span>
              </li>
            ))}
          </ul>
        )}
        {files.length > 0 && clientError && <p className={styles.errorMessage}>{clientError}</p>}
      </div>

      {error && <p className={styles.errorMessage}>{error}</p>}

      <div className={styles.actions}>
        <button className={styles.submitButton} type="submit" disabled={submitting || Boolean(clientError)}>
          {submitting ? '업로드 중…' : '잡 시작'}
        </button>
        {submitting && <span className={styles.submitHint}>이미지를 검사하고 저장하는 중입니다…</span>}
      </div>
    </form>
  );
}
