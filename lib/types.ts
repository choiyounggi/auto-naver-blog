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
  // 사진 위에 붙는 짧은 소제목. 굵게+큰 글씨로 들어가 글의 구조를 드러낸다.
  // 빈 문자열이면 소제목 없이 문단만 쓴다. default 를 둬서 이 필드가 없던 시절에 저장된
  // 잡 파일도 그대로 읽힌다.
  heading: z.string().default(''),
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
  // 이 잡을 만든 세션의 식별자. 남의 잡을 고치거나 발행하지 못하게 하는 근거다.
  // 인증을 붙이기 전에 만들어진 잡 파일에는 이 필드가 없으므로 default 로 null 을 준다.
  owner: z.string().nullable().default(null),
  phase: JobPhaseSchema,
  input: PostInputSchema,
  // 사람이 승인 화면에서 고칠 수 있는 초안. 발행할 때 이 내용대로 올라간다.
  draft: PostDraftSchema.nullable(),
  // 지금 네이버 에디터에 실제로 채워져 있는 초안. draft 와 다르면 사람이 고쳤다는 뜻이라,
  // 발행 전에 에디터를 고친 내용대로 다시 채운다. default 로 이 필드가 없던 잡 파일도 읽힌다.
  editorDraft: PostDraftSchema.nullable().default(null),
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
  /** 사람이 브라우저에서 직접 고친 뒤, 무엇이 발행될지 다시 확인하려고 스크린샷만 다시 찍는다. */
  refreshPreview(input: PostInput): Promise<EditorPreview>;
  publish(): Promise<PublishResult>;
  abort(): Promise<void>;
}
