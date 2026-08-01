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

export type AttachmentKindName = (typeof ATTACHMENT_KINDS)[number];
export type AttachmentSubjectTypeName = (typeof ATTACHMENT_SUBJECT_TYPES)[number];

export interface AttachmentPolicy {
  /** Kinds this subject accepts. Absent kind → declare is rejected. */
  kinds: readonly AttachmentKindName[];
  /** Optional per-kind ceilings BELOW the platform caps — a policy can
   *  tighten ATTACHMENT_MAX_BYTES, never exceed it. */
  maxBytes?: Partial<Record<AttachmentKindName, number>>;
}

/**
 * Per-subject upload rules — the product layer above the platform caps.
 * Single source for the server (declare + confirm) and the client
 * (pre-upload validation), so the browser never starts an upload the
 * server would refuse.
 *
 * Tasks carry proof-of-work: screenshots and logs/artifacts. No video or
 * audio — a demo recording belongs in the PR, not the ticket.
 */
export const ATTACHMENT_POLICIES: Readonly<Record<AttachmentSubjectTypeName, AttachmentPolicy>> = {
  task: {
    kinds: ['image', 'file'],
    maxBytes: { image: 10 * 1024 * 1024, file: 25 * 1024 * 1024 },
  },
};

/** Effective ceiling: the policy may tighten the platform cap, never raise it. */
export const attachmentLimitFor = (
  subjectType: AttachmentSubjectTypeName,
  kind: AttachmentKindName,
): number => {
  const platform = ATTACHMENT_MAX_BYTES[kind];
  const policy = ATTACHMENT_POLICIES[subjectType]?.maxBytes?.[kind];
  return policy === undefined ? platform : Math.min(policy, platform);
};

export const attachmentKindAllowed = (
  subjectType: AttachmentSubjectTypeName,
  kind: AttachmentKindName,
): boolean => ATTACHMENT_POLICIES[subjectType]?.kinds.includes(kind) ?? false;
