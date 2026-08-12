import { z } from 'zod';
import { RESEARCH_STATUSES, TASK_AUTHOR_TYPES } from '../constants';

// --- Research Enums ---
// Derived from ../constants — the same value sets the database CHECK
// constraints enforce, defined exactly once.
export const ResearchStatusSchema = z.enum(RESEARCH_STATUSES);
export const ResearchAuthorTypeSchema = z.enum(TASK_AUTHOR_TYPES);

export type ResearchStatus = z.infer<typeof ResearchStatusSchema>;
export type ResearchAuthorType = z.infer<typeof ResearchAuthorTypeSchema>;

// --- Keyset (cursor) pagination ---
// The listing is infinite-scroll ready: a `nextCursor` opaque token encodes
// the last (updated_at, id) seen. It is NOT the offset-based
// PaginatedResponseSchema — new inserts at the head never shift the window,
// so a scroll cannot skip or double-count rows.
export const CursorPaginationRequestSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export function CursorPaginatedResponseSchema<T extends z.ZodTypeAny>(itemSchema: T) {
  return z.object({
    data: z.array(itemSchema),
    meta: z.object({
      // null once the feed is exhausted — pass it back to fetch the next page.
      nextCursor: z.string().nullable(),
    }),
  });
}

export type CursorPaginationRequest = z.infer<typeof CursorPaginationRequestSchema>;

export type CursorPaginatedResponse<T> = {
  data: T[];
  meta: { nextCursor: string | null };
};

// --- Research Entity ---
export const ResearchSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  /** The associated project; null = an org-level (unassociated) document. */
  projectId: z.string().uuid().nullable(),
  title: z.string(),
  status: ResearchStatusSchema,
  /** The living document; null until the first draft lands. */
  bodyMarkdown: z.string().nullable(),
  /** Bumped every time the agent publishes a new draft. */
  version: z.number().int(),
  createdBy: z.string().uuid(),
  acceptedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Research = z.infer<typeof ResearchSchema>;

// --- Research Message Entity ---
export const ResearchMessageSchema = z.object({
  id: z.string().uuid(),
  researchId: z.string().uuid(),
  orgId: z.string().uuid(),
  authorId: z.string().uuid(),
  authorType: ResearchAuthorTypeSchema,
  body: z.string(),
  createdAt: z.string(),
});

export type ResearchMessage = z.infer<typeof ResearchMessageSchema>;

// --- Create Research ---
// Frictionless capture: a bare title starts a document. An optional first
// message seeds the conversation (and would trigger the first agent turn).
export const CreateResearchRequestSchema = z
  .object({
    title: z.string().min(1).max(500),
    projectId: z.string().uuid().optional(),
    message: z.string().min(1).max(100_000).optional(),
  })
  .strict();

export const CreateResearchResponseSchema = ResearchSchema;

export type CreateResearchRequest = z.infer<typeof CreateResearchRequestSchema>;
export type CreateResearchResponse = z.infer<typeof CreateResearchResponseSchema>;

// --- Get Research by ID (document + first page of messages + lineage count) ---
export const GetResearchRequestSchema = z.object({ id: z.string().uuid() }).strict();
export const GetResearchResponseSchema = ResearchSchema.extend({
  messages: z.array(ResearchMessageSchema),
  /** How many draft tickets have been cut from this document. */
  tasksCut: z.number().int(),
});

export type GetResearchRequest = z.infer<typeof GetResearchRequestSchema>;
export type GetResearchResponse = z.infer<typeof GetResearchResponseSchema>;

// --- List Research (KEYSET) ---
// Filters: by associated project, org-level/unassociated (`scope=org`), by
// status, and a case-insensitive title query `q`.
export const ListResearchRequestSchema = CursorPaginationRequestSchema.extend({
  projectId: z.string().uuid().optional(),
  scope: z.enum(['org']).optional(),
  status: ResearchStatusSchema.optional(),
  q: z.string().max(500).optional(),
}).strict();

export const ListResearchResponseSchema = CursorPaginatedResponseSchema(ResearchSchema);

export type ListResearchRequest = z.infer<typeof ListResearchRequestSchema>;
export type ListResearchResponse = z.infer<typeof ListResearchResponseSchema>;

// --- Update Research (spec fields; status changes go through accept/reopen) ---
export const UpdateResearchRequestSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string().min(1).max(500).optional(),
    // Nullable: re-associate to a project, or detach to org-level.
    projectId: z.string().uuid().nullable().optional(),
    bodyMarkdown: z.string().max(1_000_000).nullable().optional(),
  })
  .strict();

export const UpdateResearchResponseSchema = ResearchSchema;

export type UpdateResearchRequest = z.infer<typeof UpdateResearchRequestSchema>;
export type UpdateResearchResponse = z.infer<typeof UpdateResearchResponseSchema>;

// --- Append Message (human side: seeds an agent turn) ---
export const AppendResearchMessageRequestSchema = z
  .object({
    id: z.string().uuid(),
    body: z.string().min(1).max(100_000),
  })
  .strict();

export const AppendResearchMessageResponseSchema = ResearchMessageSchema;

export type AppendResearchMessageRequest = z.infer<typeof AppendResearchMessageRequestSchema>;
export type AppendResearchMessageResponse = z.infer<typeof AppendResearchMessageResponseSchema>;

// --- List Messages (KEYSET, chronological) ---
export const ListResearchMessagesRequestSchema = CursorPaginationRequestSchema.extend({
  id: z.string().uuid(),
}).strict();

export const ListResearchMessagesResponseSchema =
  CursorPaginatedResponseSchema(ResearchMessageSchema);

export type ListResearchMessagesRequest = z.infer<typeof ListResearchMessagesRequestSchema>;
export type ListResearchMessagesResponse = z.infer<typeof ListResearchMessagesResponseSchema>;

// --- Accept (finalize: → accepted, accepted_at = now) ---
export const AcceptResearchRequestSchema = z.object({ id: z.string().uuid() }).strict();
export const AcceptResearchResponseSchema = ResearchSchema;

export type AcceptResearchRequest = z.infer<typeof AcceptResearchRequestSchema>;
export type AcceptResearchResponse = z.infer<typeof AcceptResearchResponseSchema>;

// --- Reopen (accepted → needs_review, human-only; appends a feedback message) ---
// Mirrors the task reopen arc: the feedback comment is the round-2 spec delta,
// required just as a review rejection's is.
export const ReopenResearchRequestSchema = z
  .object({
    id: z.string().uuid(),
    comment: z.string().max(100_000).optional(),
  })
  .strict();

export const ReopenResearchResponseSchema = ResearchSchema;

export type ReopenResearchRequest = z.infer<typeof ReopenResearchRequestSchema>;
export type ReopenResearchResponse = z.infer<typeof ReopenResearchResponseSchema>;

// --- Cut Tickets (create DRAFT tasks carrying source_research_id lineage) ---
// Each proposal becomes a draft task in the target project (default = the
// research's associated project). The Ready boundary still applies: cutting
// produces DRAFTS, never queued work.
export const CutTicketsRequestSchema = z
  .object({
    id: z.string().uuid(),
    targetProjectId: z.string().uuid().optional(),
    proposals: z
      .array(
        z.object({
          title: z.string().min(1).max(500),
          context: z.string().max(100_000).optional(),
          // The feature/flow the cut ticket belongs to — lands it pre-grouped
          // on the board (Group-by-Area). Human-set; a research doc is usually
          // one feature, so the sheet pre-fills it. Same 120 cap as task.area.
          area: z.string().max(120).optional(),
        }),
      )
      .min(1)
      .max(50),
  })
  .strict();

export const CutTicketsResponseSchema = z.object({
  taskIds: z.array(z.string().uuid()),
});

export type CutTicketsRequest = z.infer<typeof CutTicketsRequestSchema>;
export type CutTicketsResponse = z.infer<typeof CutTicketsResponseSchema>;

// --- Delete Research ---
export const DeleteResearchRequestSchema = z.object({ id: z.string().uuid() }).strict();
export const DeleteResearchResponseSchema = z.object({});

export type DeleteResearchRequest = z.infer<typeof DeleteResearchRequestSchema>;
export type DeleteResearchResponse = z.infer<typeof DeleteResearchResponseSchema>;
