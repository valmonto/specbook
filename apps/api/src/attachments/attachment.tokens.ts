import type { ActiveUser, AttachmentSubjectType } from '@pkg/contracts';

/**
 * The app's knowledge injected into the domain-blind attachments module: one
 * resolver per subject type answering "may THIS caller access this subject".
 * It is an ACCESS check, not mere existence — the resolver receives the full
 * ActiveUser so it can enforce the per-project visibility grant (a human MEMBER
 * only reaches attachments on tasks in projects they were granted; OWNER/ADMIN
 * and agents are unrestricted). Unknown types 400 at the schema layer; a false
 * resolver 404s — closing the list, the direct `:id`, and the read-url paths.
 */
export type SubjectResolver = (subjectId: string, activeUser: ActiveUser) => Promise<boolean>;

export type SubjectResolvers = Partial<Record<AttachmentSubjectType, SubjectResolver>>;

export const ATTACHMENT_SUBJECT_RESOLVERS = Symbol('ATTACHMENT_SUBJECT_RESOLVERS');
