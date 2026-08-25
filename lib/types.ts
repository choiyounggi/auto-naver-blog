import { z } from 'zod';

const isoDateTime = () => z.iso.datetime();

// ---------- boundary-crossing data (D1: zod schema is the source of truth) ----------

export const NaverSessionStatusSchema = z.discriminatedUnion('loggedIn', [
  z.object({
    loggedIn: z.literal(true),
    blogId: z.string(),
    checkedAt: isoDateTime(),
  }),
  z.object({
    loggedIn: z.literal(false),
    reason: z.enum(['no-cookies', 'expired', 'unknown']),
    checkedAt: isoDateTime(),
  }),
]);
export type NaverSessionStatus = z.infer<typeof NaverSessionStatusSchema>;

export const UploadedImageSchema = z.object({
  id: z.string(),
  originalName: z.string(),
  path: z.string(),
  mimeType: z.string(),
  bytes: z.number(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  order: z.number().int().min(0),
});
export type UploadedImage = z.infer<typeof UploadedImageSchema>;

export const PostInputSchema = z.object({
  jobId: z.string(),
  category: z.string(),
  highlights: z.string(),
  // 글 끝에 붙일 장소. 선택 입력이라 빈 문자열이면 장소 문단 자체를 넣지 않는다.
  // default 를 둬서 이 필드가 없던 시절에 저장된 잡 파일도 그대로 읽힌다.
  place: z.string().default(''),
  images: z.array(UploadedImageSchema).min(1),
  createdAt: isoDateTime(),
});
export type PostInput = z.infer<typeof PostInputSchema>;

export const ImageBlockSchema = z.object({
  imageId: z.string(),
  caption: z.string(),
  altText: z.string(),
});
export type ImageBlock = z.infer<typeof ImageBlockSchema>;

export const PostDraftSchema = z.object({
  title: z.string(),
  intro: z.string(),
  blocks: z.array(ImageBlockSchema),
  outro: z.string(),
  tags: z.array(z.string()).max(30),
  topic: z.string(),
  thumbnailImageId: z.string(),
  generatedAt: isoDateTime(),
  model: z.string(),
});
export type PostDraft = z.infer<typeof PostDraftSchema>;

export const PublishResultSchema = z.object({
  ok: z.boolean(),
  postUrl: z.string().nullable(),
  publishedAt: isoDateTime().nullable(),
  message: z.string(),
});
export type PublishResult = z.infer<typeof PublishResultSchema>;

export const JobPhaseSchema = z.enum([
  'created',
  'analyzing',
  'drafting',
  'draft_ready',
  'filling_editor',
  'awaiting_approval',
  'publishing',
  'published',
  'failed',
  'cancelled',
]);
export type JobPhase = z.infer<typeof JobPhaseSchema>;

export const JobLogEntrySchema = z.object({
  at: isoDateTime(),
  phase: JobPhaseSchema,
  message: z.string(),
});
export type JobLogEntry = z.infer<typeof JobLogEntrySchema>;

export const JobStateSchema = z.object({
  id: z.string(),
  phase: JobPhaseSchema,
  input: PostInputSchema,
  draft: PostDraftSchema.nullable(),
  preview: z
    .object({
      screenshotPath: z.string(),
      editorUrl: z.string(),
    })
    .nullable(),
  result: PublishResultSchema.nullable(),
  error: z
    .object({
      message: z.string(),
      step: z.string(),
      at: isoDateTime(),
    })
    .nullable(),
  log: z.array(JobLogEntrySchema),
  updatedAt: isoDateTime(),
});
export type JobState = z.infer<typeof JobStateSchema>;

// ---------- 구현체는 후속 작업이 만든다. t0은 인터페이스만 선언한다 (D2: 순수 내부 인터페이스) ----------

export interface AsideEvalResult {
  ok: boolean;
  stdout: string;
  durationMs: number;
  error: string | null;
}

export interface AsideReplApi {
  start(): Promise<void>;
  evaluate(js: string, opts?: { timeoutMs?: number }): Promise<AsideEvalResult>;
  dispose(): Promise<void>;
}

export interface NaverSessionApi {
  status(): Promise<NaverSessionStatus>;
  exportCookies(): Promise<number>;
  importCookies(): Promise<number>;
}

export type ProgressFn = (message: string) => void;

export interface ContentGeneratorApi {
  generate(input: PostInput, onProgress?: ProgressFn): Promise<PostDraft>;
}

export interface EditorPreview {
  screenshotPath: string;
  editorUrl: string;
}

export interface NaverPublisherApi {
  fillEditor(draft: PostDraft, input: PostInput, onProgress?: ProgressFn): Promise<EditorPreview>;
  publish(): Promise<PublishResult>;
  abort(): Promise<void>;
}
