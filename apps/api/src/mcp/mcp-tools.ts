import { Injectable } from '@nestjs/common';
// The MCP SDK is built against zod v3; the workspace is v4. Tool input schemas
// use the aliased v3 so they match the SDK's ZodRawShape at runtime.
import { z, type ZodRawShape } from 'zod-v3';
import {
  ATTACHMENT_KINDS,
  TASK_COMMENT_KINDS,
  TASK_STATUSES,
  type ActiveUser,
  type McpScope,
} from '@pkg/contracts';
import { AttachmentsService } from '../attachments/attachments.service';
import { OrgService } from '../org/org.service';
import { ProjectService } from '../tasks/project.service';
import { TaskService } from '../tasks/task.service';

export interface McpToolDef {
  name: string;
  /** null = visible to every authenticated key (e.g. whoami). */
  scope: McpScope | null;
  /** Org-scoped tools only exist for keys bound to an org (activeUser present). */
  needsOrgContext?: boolean;
  description: string;
  inputSchema?: ZodRawShape;
  handler: (args: Record<string, unknown>, actor: ActiveUser | null) => Promise<unknown>;
}

const MAX_LIMIT = 100;

const str = (v: unknown): string => v as string;
const optStr = (v: unknown): string | undefined => v as string | undefined;

/**
 * The tool catalog — one place, each tool tagged with the scope that exposes
 * it. A key sees exactly the tools its granted scopes cover; granting a scope
 * at key creation IS the exposure decision.
 *
 * The convention every future tool follows: wrap a SERVICE method, never raw
 * SQL — tools get the same rules, logging and shape the HTTP surface has.
 *
 * Task tools are the AGENT COURT of the status protocol: they call the same
 * TaskService the REST surface uses, but with actor 'agent', so the
 * AGENT_TASK_TRANSITIONS map applies — an agent can pull, work, block and
 * submit for review, and can never approve its own work.
 */
@Injectable()
export class McpTools {
  constructor(
    private readonly orgService: OrgService,
    private readonly projectService: ProjectService,
    private readonly taskService: TaskService,
    private readonly attachmentsService: AttachmentsService,
  ) {}

  catalog(): McpToolDef[] {
    return [
      {
        name: 'list_organizations',
        scope: 'orgs:read',
        description: 'Every organization on the platform, with member counts.',
        inputSchema: {
          skip: z.number().int().min(0).optional(),
          limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
        },
        handler: async (args) =>
          this.orgService.adminListOrgs({
            skip: (args.skip as number | undefined) ?? 0,
            limit: (args.limit as number | undefined) ?? 20,
          }),
      },
      {
        name: 'platform_stats',
        scope: 'platform:read',
        description: 'Platform totals (organization count).',
        handler: async () => {
          const { meta } = await this.orgService.adminListOrgs({ skip: 0, limit: 1 });
          return { organizations: meta.total };
        },
      },

      // --- Agent court: the task protocol ---
      {
        name: 'list_projects',
        scope: 'tasks:agent',
        needsOrgContext: true,
        description:
          'Projects in this organization. Read a project (get_project) before working its tasks — its context document is the constitution.',
        inputSchema: {
          skip: z.number().int().min(0).optional(),
          limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
        },
        handler: async (args, actor) =>
          this.projectService.list(actor!, {
            skip: (args.skip as number | undefined) ?? 0,
            limit: (args.limit as number | undefined) ?? 20,
          }),
      },
      {
        name: 'get_project',
        scope: 'tasks:agent',
        needsOrgContext: true,
        description:
          'Full project: the context document (read it first), repo URL, default branch, and workdir on the agent machine.',
        inputSchema: { id: z.string().uuid() },
        handler: async (args, actor) => this.projectService.getById(actor!, str(args.id)),
      },
      {
        name: 'list_tasks',
        scope: 'tasks:agent',
        needsOrgContext: true,
        description:
          'Tasks, filterable by project and status. available=true is THE work queue: ready tasks whose dependencies are all finished — pull from here.',
        inputSchema: {
          projectId: z.string().uuid().optional(),
          status: z.enum(TASK_STATUSES).optional(),
          available: z.boolean().optional(),
          skip: z.number().int().min(0).optional(),
          limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
        },
        handler: async (args, actor) =>
          this.taskService.list(actor!, {
            skip: (args.skip as number | undefined) ?? 0,
            limit: (args.limit as number | undefined) ?? 20,
            projectId: optStr(args.projectId),
            status: args.status as (typeof TASK_STATUSES)[number] | undefined,
            available: (args.available as boolean | undefined) ?? false,
          }),
      },
      {
        name: 'get_task',
        scope: 'tasks:agent',
        needsOrgContext: true,
        description:
          'Full task: spec (context, out-of-scope, acceptance criteria), the comment log, and dependency state.',
        inputSchema: { id: z.string().uuid() },
        handler: async (args, actor) => this.taskService.getById(actor!, str(args.id)),
      },
      {
        name: 'create_task',
        scope: 'tasks:agent',
        needsOrgContext: true,
        description:
          "File a task spec on the human's behalf. ALWAYS lands as a draft — only the human can dispatch it to ready (the dispatch gate), so use this to capture specs, not to queue work for yourself.",
        inputSchema: {
          projectId: z.string().uuid(),
          title: z.string().min(1).max(500),
          context: z.string().optional(),
          outOfScope: z.string().optional(),
          acceptanceCriteria: z.array(z.string().min(1)).max(50).optional(),
          priority: z.number().int().min(0).max(1000).optional(),
        },
        handler: async (args, actor) =>
          this.taskService.create(actor!, {
            projectId: str(args.projectId),
            title: str(args.title),
            context: optStr(args.context),
            outOfScope: optStr(args.outOfScope),
            acceptanceCriteria: args.acceptanceCriteria as string[] | undefined,
            priority: args.priority as number | undefined,
          }),
      },
      {
        name: 'claim_task',
        scope: 'tasks:agent',
        needsOrgContext: true,
        description:
          'Atomically claim a ready task (ready → in_progress). If another session won the race you get a conflict — pull the next available task instead.',
        inputSchema: { id: z.string().uuid() },
        handler: async (args, actor) =>
          this.taskService.transition(actor!, 'agent', { id: str(args.id), to: 'in_progress' }),
      },
      {
        name: 'update_status',
        scope: 'tasks:agent',
        needsOrgContext: true,
        description:
          'Move a task through the agent transitions: in_progress → blocked (comment = your question, required) or → needs_review (requires a summary comment AND branch + prUrl set on the task first, via update_task_links); blocked/changes_requested → in_progress to resume.',
        inputSchema: {
          id: z.string().uuid(),
          to: z.enum(TASK_STATUSES),
          comment: z.string().optional(),
        },
        handler: async (args, actor) =>
          this.taskService.transition(actor!, 'agent', {
            id: str(args.id),
            to: args.to as (typeof TASK_STATUSES)[number],
            comment: optStr(args.comment),
          }),
      },
      {
        name: 'update_task_links',
        scope: 'tasks:agent',
        needsOrgContext: true,
        description:
          'Record where the work lives: branch name and PR URL. Required before update_status → needs_review.',
        inputSchema: {
          id: z.string().uuid(),
          branch: z.string().max(255).optional(),
          prUrl: z.string().max(500).optional(),
        },
        handler: async (args, actor) =>
          this.taskService.update(actor!, {
            id: str(args.id),
            branch: optStr(args.branch),
            prUrl: optStr(args.prUrl),
          }),
      },
      {
        name: 'check_criterion',
        scope: 'tasks:agent',
        needsOrgContext: true,
        description:
          'Tick (or untick) one acceptance criterion by index as you complete it — this is live progress reporting.',
        inputSchema: {
          id: z.string().uuid(),
          index: z.number().int().min(0),
          done: z.boolean(),
        },
        handler: async (args, actor) =>
          this.taskService.checkCriterion(actor!, {
            id: str(args.id),
            index: args.index as number,
            done: args.done as boolean,
          }),
      },
      {
        name: 'list_attachments',
        scope: 'tasks:agent',
        needsOrgContext: true,
        description:
          "A task's files with presigned read URLs — fetch the bytes with a plain HTTP GET. Specs may carry design screenshots; read them before working.",
        inputSchema: { taskId: z.string().uuid() },
        handler: async (args, actor) =>
          this.attachmentsService.list(actor!, {
            subjectType: 'task',
            subjectId: str(args.taskId),
          }),
      },
      {
        name: 'create_attachment_upload',
        scope: 'tasks:agent',
        needsOrgContext: true,
        description:
          'Attach proof-of-work to a task, step 1 of 3: declares the file and returns a presigned PUT URL. Upload the bytes with HTTP PUT (Content-Type must match), then call confirm_attachment. Task policy applies (image/file only, size ceilings).',
        inputSchema: {
          taskId: z.string().uuid(),
          kind: z.enum(ATTACHMENT_KINDS),
          fileName: z.string().min(1).max(255),
          mimeType: z.string().min(1).max(255),
          sizeBytes: z.number().int().positive(),
        },
        handler: async (args, actor) =>
          this.attachmentsService.createUpload(actor!, {
            subjectType: 'task',
            subjectId: str(args.taskId),
            kind: args.kind as (typeof ATTACHMENT_KINDS)[number],
            fileName: str(args.fileName),
            mimeType: str(args.mimeType),
            sizeBytes: args.sizeBytes as number,
            withThumbnail: false,
          }),
      },
      {
        name: 'confirm_attachment',
        scope: 'tasks:agent',
        needsOrgContext: true,
        description:
          'Step 3: after the PUT succeeds, confirm — the server verifies what actually landed and the file becomes visible on the task.',
        inputSchema: { id: z.string().uuid() },
        handler: async (args, actor) =>
          this.attachmentsService.confirm(actor!, { id: str(args.id) }),
      },
      {
        name: 'add_comment',
        scope: 'tasks:agent',
        needsOrgContext: true,
        description:
          "Write to the task's work log. kind 'progress' for narration mid-flight, 'comment' for everything else (questions go through update_status → blocked).",
        inputSchema: {
          id: z.string().uuid(),
          kind: z.enum(TASK_COMMENT_KINDS).optional(),
          body: z.string().min(1),
        },
        handler: async (args, actor) =>
          this.taskService.addComment(actor!, 'agent', {
            id: str(args.id),
            kind: (args.kind as (typeof TASK_COMMENT_KINDS)[number] | undefined) ?? 'comment',
            body: str(args.body),
          }),
      },
    ];
  }
}
