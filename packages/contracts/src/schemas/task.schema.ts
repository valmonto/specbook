import { z } from 'zod';
import {
  CI_FAILURE_KINDS,
  TASK_AUTHOR_TYPES,
  TASK_CI_STATES,
  TASK_COMMENT_KINDS,
  TASK_PR_STATES,
  TASK_STATUSES,
} from '../constants';
import { PaginatedRequestSchema, PaginatedResponseSchema } from './pagination.schema';

// --- Task Enums ---
// Derived from ../constants — the same value sets the database CHECK
// constraints enforce, defined exactly once.
export const TaskStatusSchema = z.enum(TASK_STATUSES);
export const TaskCommentKindSchema = z.enum(TASK_COMMENT_KINDS);
export const TaskAuthorTypeSchema = z.enum(TASK_AUTHOR_TYPES);
export const TaskPrStateSchema = z.enum(TASK_PR_STATES);
export const TaskCiStateSchema = z.enum(TASK_CI_STATES);
export const CiFailureKindSchema = z.enum(CI_FAILURE_KINDS);

export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type TaskCommentKind = z.infer<typeof TaskCommentKindSchema>;
export type TaskAuthorType = z.infer<typeof TaskAuthorTypeSchema>;
export type TaskPrState = z.infer<typeof TaskPrStateSchema>;
export type TaskCiState = z.infer<typeof TaskCiStateSchema>;
export type CiFailureKind = z.infer<typeof CiFailureKindSchema>;

// --- Acceptance Criterion ---
// The checklist that replaces subtasks: "all boxes ticked" is the
// machine-checkable definition of done.
export const AcceptanceCriterionSchema = z.object({
  text: z.string().min(1).max(1000),
  done: z.boolean(),
});

export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;

// --- Dependency summary (one edge's far end: the related task, id + title +
// status). Embedded in the task detail AND, for the board's row indicators,
// on the list read model. Defined before TaskSchema so the entity can carry it.
export const TaskDependencyInfoSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  status: TaskStatusSchema,
});

export type TaskDependencyInfo = z.infer<typeof TaskDependencyInfoSchema>;

// --- Task Entity ---
export const TaskSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  title: z.string(),
  context: z.string().nullable(),
  outOfScope: z.string().nullable(),
  /** One free-text feature/flow label the board can group by; null = untagged. */
  area: z.string().max(120).nullable(),
  acceptanceCriteria: z.array(AcceptanceCriterionSchema),
  status: TaskStatusSchema,
  priority: z.number().int(),
  claimedBy: z.string().uuid().nullable(),
  claimedAt: z.string().nullable(),
  branch: z.string().nullable(),
  prUrl: z.string().nullable(),
  // Live GitHub state, webhook-written only; null until an event arrives.
  prState: TaskPrStateSchema.nullable(),
  prNumber: z.number().int().nullable(),
  ciState: TaskCiStateSchema.nullable(),
  /** Why the red is red — classified conservatively; null = plain red. */
  ciFailureKind: CiFailureKindSchema.nullable(),
  prSyncedAt: z.string().nullable(),
  /** Human-only work: never fed to the agent queue, styled "human task". */
  isHumanTask: z.boolean(),
  /** Agent-reported cost, accumulated additively; null = never reported. */
  costTokensIn: z.number().int().nullable(),
  costTokensOut: z.number().int().nullable(),
  costUsdCents: z.number().int().nullable(),
  statusChangedBy: z.string().uuid().nullable(),
  statusChangedAt: z.string().nullable(),
  /** Lineage: the research document this task was cut from; null = filed directly. */
  sourceResearchId: z.string().uuid().nullable(),
  /** Title of that research, resolved via an org-scoped join; null = no source. */
  sourceResearchTitle: z.string().nullable(),
  createdBy: z.string().uuid(),
  createdAt: z.string(),
  updatedAt: z.string(),
  // Dependency edges, for the board's collapsed-row indicators. Populated on
  // the list read path (both directions, org-scoped); omitted on plain write
  // responses (create/update/transition) where no row is drawn — hence
  // optional. `dependencies` = prerequisites this task waits on ("depends on
  // N"); `dependents` = tasks that wait on this one ("blocks N"). The detail
  // response re-declares them as required.
  dependencies: z.array(TaskDependencyInfoSchema).optional(),
  dependents: z.array(TaskDependencyInfoSchema).optional(),
});

export type Task = z.infer<typeof TaskSchema>;

// --- Task Comment Entity ---
export const TaskCommentSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  authorId: z.string().uuid(),
  authorType: TaskAuthorTypeSchema,
  kind: TaskCommentKindSchema,
  body: z.string(),
  /** kind 'note' only: when the claiming agent read it; null = unseen. */
  ackedAt: z.string().nullable(),
  createdAt: z.string(),
});

export type TaskComment = z.infer<typeof TaskCommentSchema>;

// --- Create Task ---
// Capture is frictionless: a draft can be a bare title. The dispatch gate
// (draft→ready) is where context + criteria become mandatory — enforced in
// the service, not here.
export const CreateTaskRequestSchema = z
  .object({
    projectId: z.string().uuid(),
    title: z.string().min(1).max(500),
    context: z.string().max(100_000).optional(),
    outOfScope: z.string().max(10_000).optional(),
    area: z.string().max(120).optional(),
    acceptanceCriteria: z.array(z.string().min(1).max(1000)).max(50).optional(),
    priority: z.number().int().min(0).max(1000).optional(),
    isHumanTask: z.boolean().optional(),
    // "Depends on" edges to wire at creation: ids of prerequisite tasks in the
    // same project. Each is added through the guarded add-dependency path, so
    // existence, same-project, self and cycle checks all apply.
    dependsOn: z.array(z.string().uuid()).max(50).optional(),
  })
  .strict();

export const CreateTaskResponseSchema = TaskSchema;

export type CreateTaskRequest = z.infer<typeof CreateTaskRequestSchema>;
export type CreateTaskResponse = z.infer<typeof CreateTaskResponseSchema>;

// --- Update Task (spec fields; status changes go through transition) ---
export const UpdateTaskRequestSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string().min(1).max(500).optional(),
    context: z.string().max(100_000).nullable().optional(),
    outOfScope: z.string().max(10_000).nullable().optional(),
    area: z.string().max(120).nullable().optional(),
    // Full replacement, preserving done flags — the checklist is small.
    acceptanceCriteria: z.array(AcceptanceCriterionSchema).max(50).optional(),
    priority: z.number().int().min(0).max(1000).optional(),
    branch: z.string().max(255).nullable().optional(),
    prUrl: z.string().max(500).nullable().optional(),
    isHumanTask: z.boolean().optional(),
  })
  .strict();

export const UpdateTaskResponseSchema = TaskSchema;

export type UpdateTaskRequest = z.infer<typeof UpdateTaskRequestSchema>;
export type UpdateTaskResponse = z.infer<typeof UpdateTaskResponseSchema>;

// --- Report Cost (agent court, claimant-only, values ADD) ---
export const ReportCostRequestSchema = z
  .object({
    taskId: z.string().uuid(),
    tokensIn: z.number().int().min(0).max(1_000_000_000).optional(),
    tokensOut: z.number().int().min(0).max(1_000_000_000).optional(),
    usdCents: z.number().int().min(0).max(100_000_000).optional(),
  })
  .strict();

export const ReportCostResponseSchema = TaskSchema;

export type ReportCostRequest = z.infer<typeof ReportCostRequestSchema>;
export type ReportCostResponse = z.infer<typeof ReportCostResponseSchema>;

// --- List Tasks ---
// `available: true` is THE agent queue query: status=ready AND every
// dependency in a terminal-success state (done).
export const ListTasksRequestSchema = PaginatedRequestSchema.extend({
  projectId: z.string().uuid().optional(),
  status: TaskStatusSchema.optional(),
  available: z
    .preprocess((val) => val === 'true' || val === true, z.boolean())
    .optional()
    .default(false),
}).strict();

export const ListTasksResponseSchema = PaginatedResponseSchema(TaskSchema);

export type ListTasksRequest = z.infer<typeof ListTasksRequestSchema>;
export type ListTasksResponse = z.infer<typeof ListTasksResponseSchema>;

// --- List distinct areas for a project (autocomplete + board grouping) ---
// Just task data under task:read — the distinct non-null `area` values used
// for one project, most-used first, so the form combobox suggests them.
export const ListTaskAreasRequestSchema = z
  .object({ projectId: z.string().uuid() })
  .strict();
export const ListTaskAreasResponseSchema = z.object({
  areas: z.array(z.string()),
});

export type ListTaskAreasRequest = z.infer<typeof ListTaskAreasRequestSchema>;
export type ListTaskAreasResponse = z.infer<typeof ListTaskAreasResponseSchema>;

// --- Get Task by ID (full detail: spec + comments + dependency state) ---
export const GetTaskByIdRequestSchema = z.object({ id: z.string().uuid() }).strict();
export const GetTaskByIdResponseSchema = TaskSchema.extend({
  comments: z.array(TaskCommentSchema),
  dependencies: z.array(TaskDependencyInfoSchema),
  dependents: z.array(TaskDependencyInfoSchema),
});

export type GetTaskByIdRequest = z.infer<typeof GetTaskByIdRequestSchema>;
export type GetTaskByIdResponse = z.infer<typeof GetTaskByIdResponseSchema>;

// --- Transition (the status protocol; actor rules + gates enforced server-side) ---
export const TransitionTaskRequestSchema = z
  .object({
    id: z.string().uuid(),
    to: TaskStatusSchema,
    // Required by the review gate (in_progress→needs_review) and expected
    // with blocked (the question) and changes_requested (the feedback).
    comment: z.string().max(100_000).optional(),
  })
  .strict();

export const TransitionTaskResponseSchema = TaskSchema;

export type TransitionTaskRequest = z.infer<typeof TransitionTaskRequestSchema>;
export type TransitionTaskResponse = z.infer<typeof TransitionTaskResponseSchema>;

// --- Bulk mark-ready (human/UI-only; resolves transitive draft prerequisites) ---
// One endpoint behind three UI surfaces: the project cog ("Mark all as ready"),
// a per-Area group menu, and the single-task action. The scope names the target
// draft set; the service also promotes those targets' transitive DRAFT
// prerequisites so nothing is left ready-but-stranded. Human-only by design —
// `ready` is the human dispatch gate, so no MCP tool wraps this.
//
// Scope is discriminated on `kind`; every variant carries `projectId` so the
// dependency walk stays inside one project (edges are same-project by
// construction) and the org guard has a project to join on.
export const MarkReadyScopeSchema = z.discriminatedUnion('kind', [
  // Every draft task in the project.
  z.object({ kind: z.literal('project'), projectId: z.string().uuid() }).strict(),
  // Every draft task in one Area/group; `area: null` is the "No area" group.
  z
    .object({
      kind: z.literal('area'),
      projectId: z.string().uuid(),
      area: z.string().max(120).nullable(),
    })
    .strict(),
  // An explicit set of task ids (the single-task action passes one).
  z
    .object({
      kind: z.literal('tasks'),
      projectId: z.string().uuid(),
      taskIds: z.array(z.string().uuid()).min(1).max(500),
    })
    .strict(),
]);

export type MarkReadyScope = z.infer<typeof MarkReadyScopeSchema>;

export const MarkReadyRequestSchema = z.object({ scope: MarkReadyScopeSchema }).strict();
export const MarkReadyResponseSchema = z.object({
  // Every task moved draft → ready by this call.
  promoted: z.array(z.object({ id: z.string().uuid(), title: z.string() })),
  // The subset pulled in as transitive draft prerequisites — not directly in
  // the requested scope. The single-task toast lists these ("Also marked
  // ready: A"); a group confirm warns they may come from other groups.
  prerequisites: z.array(z.object({ id: z.string().uuid(), title: z.string() })),
});

export type MarkReadyRequest = z.infer<typeof MarkReadyRequestSchema>;
export type MarkReadyResponse = z.infer<typeof MarkReadyResponseSchema>;

// --- Claim (atomic ready→in_progress; loser of the race gets a 409) ---
export const ClaimTaskRequestSchema = z.object({ id: z.string().uuid() }).strict();
export const ClaimTaskResponseSchema = TaskSchema;

export type ClaimTaskRequest = z.infer<typeof ClaimTaskRequestSchema>;
export type ClaimTaskResponse = z.infer<typeof ClaimTaskResponseSchema>;

// --- Merge (approved → main, server-side) ---
// The server mints the downscoped installation token, finds or creates the
// PR for the task's branch, and merges it — the browser never holds a GitHub
// credential. Legal only from `approved`; the response is the updated task
// (status `done`, prState `merged` on success).
export const MergeTaskRequestSchema = z.object({ id: z.string().uuid() }).strict();
export const MergeTaskResponseSchema = TaskSchema;

export type MergeTaskRequest = z.infer<typeof MergeTaskRequestSchema>;
export type MergeTaskResponse = z.infer<typeof MergeTaskResponseSchema>;

// --- PR stats (scope-at-a-glance for the review card) ---
// Live from GitHub at read time, so the numbers can't go stale. `areas` are
// the top-level workspace paths the diff touches (e.g. "apps/web") — a big
// diff on a small ticket is itself a review signal.
export const GetTaskPrRequestSchema = z.object({ id: z.string().uuid() }).strict();
export const GetTaskPrResponseSchema = z.object({
  number: z.number().int(),
  url: z.string(),
  state: z.enum(['open', 'merged', 'closed']),
  additions: z.number().int(),
  deletions: z.number().int(),
  changedFiles: z.number().int(),
  areas: z.array(z.string()),
});

export type GetTaskPrRequest = z.infer<typeof GetTaskPrRequestSchema>;
export type GetTaskPrResponse = z.infer<typeof GetTaskPrResponseSchema>;

// --- Check / uncheck an acceptance criterion ---
export const CheckCriterionRequestSchema = z
  .object({
    id: z.string().uuid(),
    index: z.number().int().min(0),
    done: z.boolean(),
  })
  .strict();

export const CheckCriterionResponseSchema = TaskSchema;

export type CheckCriterionRequest = z.infer<typeof CheckCriterionRequestSchema>;
export type CheckCriterionResponse = z.infer<typeof CheckCriterionResponseSchema>;

// --- Add Comment ---
export const AddTaskCommentRequestSchema = z
  .object({
    id: z.string().uuid(),
    kind: TaskCommentKindSchema.optional().default('comment'),
    body: z.string().min(1).max(100_000),
  })
  .strict();

export const AddTaskCommentResponseSchema = TaskCommentSchema;

export type AddTaskCommentRequest = z.infer<typeof AddTaskCommentRequestSchema>;
export type AddTaskCommentResponse = z.infer<typeof AddTaskCommentResponseSchema>;

// --- Dependencies ---
export const AddTaskDependencyRequestSchema = z
  .object({ id: z.string().uuid(), dependsOnTaskId: z.string().uuid() })
  .strict();
export const AddTaskDependencyResponseSchema = z.object({});

export type AddTaskDependencyRequest = z.infer<typeof AddTaskDependencyRequestSchema>;
export type AddTaskDependencyResponse = z.infer<typeof AddTaskDependencyResponseSchema>;

export const RemoveTaskDependencyRequestSchema = z
  .object({ id: z.string().uuid(), dependsOnTaskId: z.string().uuid() })
  .strict();
export const RemoveTaskDependencyResponseSchema = z.object({});

export type RemoveTaskDependencyRequest = z.infer<typeof RemoveTaskDependencyRequestSchema>;
export type RemoveTaskDependencyResponse = z.infer<typeof RemoveTaskDependencyResponseSchema>;

// --- Delete Task ---
export const DeleteTaskRequestSchema = z.object({ id: z.string().uuid() }).strict();
export const DeleteTaskResponseSchema = z.object({});

export type DeleteTaskRequest = z.infer<typeof DeleteTaskRequestSchema>;
export type DeleteTaskResponse = z.infer<typeof DeleteTaskResponseSchema>;
