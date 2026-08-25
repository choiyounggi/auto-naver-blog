import type { JobPhase } from '../types';

// UI 표시용 순수 함수만 둔다 — node:fs 등 서버 전용 API를 절대 import하지 않는다
// (클라이언트 컴포넌트에서 안전하게 import할 수 있어야 한다).

const PHASE_LABELS: Record<JobPhase, string> = {
  created: '준비 중',
  analyzing: '이미지 분석 중',
  drafting: '초안 작성 중',
  draft_ready: '초안 완료',
  filling_editor: '에디터에 채우는 중',
  awaiting_approval: '승인 대기 중',
  publishing: '발행 중',
  published: '발행 완료',
  failed: '실패',
  cancelled: '취소됨',
};

export function phaseLabel(phase: JobPhase): string {
  return PHASE_LABELS[phase];
}

const TERMINAL_PHASES: ReadonlySet<JobPhase> = new Set(['published', 'failed', 'cancelled']);

export function isTerminalPhase(phase: JobPhase): boolean {
  return TERMINAL_PHASES.has(phase);
}

// order===0이 대표(썸네일)라는 사실을 화면에 명시한다
export function imageOrderLabel(order: number, total: number): string {
  if (order === 0) return `대표 (1/${total})`;
  return `${order + 1}/${total}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)}KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)}MB`;
}

export interface ClientUploadLimits {
  maxCount: number;
  maxBytesPerImage: number;
}

const ALLOWED_URL_PROTOCOLS = new Set(['http:', 'https:']);

// D10: postUrl은 우리 팀이 만들지 않은 값(발행기 구현체·네이버 응답)이다. href에
// 그대로 묶기 전에 프로토콜을 허용 목록으로 검증한다 — javascript: 등은 버린다.
export function safeHref(url: string | null): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  return ALLOWED_URL_PROTOCOLS.has(parsed.protocol) ? url : null;
}

// 서버 검증이 진짜 관문이다 — 이건 사용자 편의를 위한 사전 안내일 뿐이다.
export function validateClientUpload(
  files: { size: number }[],
  limits: ClientUploadLimits,
): string | null {
  if (files.length === 0) {
    return '사진을 최소 1장 선택하세요.';
  }
  if (files.length > limits.maxCount) {
    return `사진은 최대 ${limits.maxCount}장까지 선택할 수 있습니다 (현재 ${files.length}장).`;
  }
  const oversized = files.find((file) => file.size > limits.maxBytesPerImage);
  if (oversized) {
    return `장당 최대 ${formatBytes(limits.maxBytesPerImage)}까지 업로드할 수 있습니다.`;
  }
  return null;
}
