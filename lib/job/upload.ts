import path from 'node:path';

export type SniffedImageType = 'jpeg' | 'png' | 'gif' | 'webp';

// D1: 매직바이트(content sniffing)로만 판정한다 — 확장자·클라이언트 Content-Type은 신뢰하지 않는다.
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const GIF_MAGIC = [0x47, 0x49, 0x46, 0x38];
const RIFF_MAGIC = [0x52, 0x49, 0x46, 0x46];
const WEBP_MAGIC = [0x57, 0x45, 0x42, 0x50];

function matches(head: Uint8Array, magic: readonly number[], offset = 0): boolean {
  if (head.length < offset + magic.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (head[offset + i] !== magic[i]) return false;
  }
  return true;
}

export function sniffImageType(head: Uint8Array): SniffedImageType | null {
  if (matches(head, JPEG_MAGIC)) return 'jpeg';
  if (matches(head, PNG_MAGIC)) return 'png';
  if (matches(head, GIF_MAGIC)) return 'gif';
  if (matches(head, RIFF_MAGIC) && matches(head, WEBP_MAGIC, 8)) return 'webp';
  return null;
}

export function extensionFor(type: SniffedImageType): string {
  return type === 'jpeg' ? 'jpg' : type;
}

export function mimeTypeFor(type: SniffedImageType): string {
  return `image/${type}`;
}

// D4: 정규화 후 절대경로 접두사 검증. 문자열 검사(예: includes('..'))만으로 막지 않는다.
export function resolveImagePathWithin(baseDir: string, jobId: string, imageId: string): string {
  const imagesDir = path.resolve(baseDir, 'jobs', jobId, 'images');
  const prefix = imagesDir.endsWith(path.sep) ? imagesDir : imagesDir + path.sep;
  const candidate = path.resolve(imagesDir, imageId);
  if (!candidate.startsWith(prefix)) {
    throw new Error(`resolveImagePathWithin: '${imageId}' escapes the images directory for job '${jobId}'`);
  }
  return candidate;
}

export const MAX_IMAGES_PER_JOB = 20;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
