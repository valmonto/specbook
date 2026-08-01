import type { AttachmentSubjectType } from '@pkg/contracts';

/**
 * The app's knowledge injected into the domain-blind attachments module:
 * one resolver per subject type answering "does this subject exist in this
 * org". Unknown types 400 at the schema layer; a false resolver 404s.
 */
export type SubjectResolver = (subjectId: string, orgId: string) => Promise<boolean>;

export type SubjectResolvers = Partial<Record<AttachmentSubjectType, SubjectResolver>>;

export const ATTACHMENT_SUBJECT_RESOLVERS = Symbol('ATTACHMENT_SUBJECT_RESOLVERS');
