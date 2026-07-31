/**
 * Attachment value sets — single source for the Zod schemas, the database
 * CHECK constraints, and client-side pre-upload validation. Zod-free: ships
 * in frontend bundles.
 */
export const ATTACHMENT_KINDS = ['image', 'video', 'audio', 'file'] as const;

export const ATTACHMENT_STATUSES = ['pending', 'uploaded'] as const;

/**
 * Subject types attachments may hang off. Apps register a resolver per type
 * (see AttachmentsModule); the list lives here so clients can validate too.
 */
export const ATTACHMENT_SUBJECT_TYPES = ['task'] as const;

/**
 * Per-kind upload ceilings, enforced twice: client-side before uploading and
 * server-side at confirm time against the object's real HEAD size — the
 * declared size is a claim, the ceiling is the law.
 */
export const ATTACHMENT_MAX_BYTES: Readonly<Record<(typeof ATTACHMENT_KINDS)[number], number>> = {
  image: 10 * 1024 * 1024,
  video: 200 * 1024 * 1024,
  audio: 25 * 1024 * 1024,
  file: 25 * 1024 * 1024,
};
