import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectLogger, PinoLogger } from '@pkg/server';
import { k } from '@pkg/locales';
// The MCP SDK is built against zod v3; the workspace is v4. Tool input schemas
// use the aliased v3 so they match the SDK's ZodRawShape at runtime.
import { z, type ZodRawShape } from 'zod-v3';
import {
  ATTACHMENT_KINDS,
  MCP_TOOLS,
  TASK_COMMENT_KINDS,
  TASK_STATUSES,
  type ActiveUser,
  type McpScope,
  type McpToolName,
} from '@pkg/contracts';
import { AgentService } from '../agents';
import { AttachmentsService } from '../attachments/attachments.service';
import { GithubAppService } from '@pkg/server';
import { OrgService } from '../org/org.service';
import { ProjectService } from '../tasks/project.service';
import { TaskService } from '../tasks/task.service';
import { ResearchService } from '../research/research.service';

export interface McpToolDef {
  name: string;
  /** null = visible to every authenticated key (e.g. whoami). */
  scope: McpScope | null;
  /** Org-scoped tools only exist for keys bound to an org (activeUser present). */
  needsOrgContext?: boolean;
  description: string;
  inputSchema?: ZodRawShape;
  handler: (
    args: Record<string, unknown>,
    actor: ActiveUser | null,
    /** The calling key — an agent's identity (presence, heartbeat). */
    auth?: { keyId: string; name: string },
  ) => Promise<unknown>;
}

const MAX_LIMIT = 100;

const str = (v: unknown): string => v as string;
const optStr = (v: unknown): string | undefined => v as string | undefined;

/**
 * Metadata (name, scope, description, org-context flag) comes from the
 * shared descriptors in @pkg/contracts — the same data the key-creation UI
 * renders — so a catalog entry here only adds what contracts cannot hold:
 * the input schema and the handler.
 */
const meta = (name: Exclude<McpToolName, 'whoami'>) => {
  const descriptor = MCP_TOOLS.find((tool) => tool.name === name);
  if (!descriptor) throw new Error(`MCP tool '${name}' has no descriptor in @pkg/contracts`);
  return descriptor;
};

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
    private readonly researchService: ResearchService,
    private readonly attachmentsService: AttachmentsService,
    private readonly githubApp: GithubAppService,
    private readonly agentService: AgentService,
    @InjectLogger() private readonly logger: PinoLogger,
  ) {}

  catalog(): McpToolDef[] {
    return [
      {
        ...meta('list_organizations'),
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
        ...meta('platform_stats'),
        handler: async () => {
          const { meta } = await this.orgService.adminListOrgs({ skip: 0, limit: 1 });
          return { organizations: meta.total };
        },
      },

      // --- Agent court: the task protocol ---
      {
        ...meta('list_projects'),
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
        ...meta('get_project'),
        inputSchema: { id: z.string().uuid() },
        handler: async (args, actor) => this.projectService.getById(actor!, str(args.id)),
      },
      {
        ...meta('get_repo_token'),
        inputSchema: { projectId: z.string().uuid() },
        handler: async (args, actor) => this.mintRepoToken(actor!, str(args.projectId)),
      },
      {
        ...meta('list_tasks'),
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
        ...meta('get_task'),
        inputSchema: { id: z.string().uuid() },
        handler: async (args, actor) => this.taskService.getById(actor!, str(args.id)),
      },
      {
        ...meta('create_task'),
        inputSchema: {
          projectId: z.string().uuid(),
          title: z.string().min(1).max(500),
          context: z.string().optional(),
          outOfScope: z.string().optional(),
          area: z.string().max(120).optional(),
          acceptanceCriteria: z.array(z.string().min(1)).max(50).optional(),
          priority: z.number().int().min(0).max(1000).optional(),
        },
        handler: async (args, actor) =>
          this.taskService.create(actor!, {
            projectId: str(args.projectId),
            title: str(args.title),
            context: optStr(args.context),
            outOfScope: optStr(args.outOfScope),
            area: optStr(args.area),
            acceptanceCriteria: args.acceptanceCriteria as string[] | undefined,
            priority: args.priority as number | undefined,
          }),
      },
      {
        ...meta('claim_task'),
        inputSchema: { id: z.string().uuid() },
        handler: async (args, actor) =>
          this.taskService.transition(actor!, 'agent', { id: str(args.id), to: 'in_progress' }),
      },
      {
        ...meta('update_status'),
        inputSchema: {
          id: z.string().uuid(),
          to: z.enum(TASK_STATUSES),
          comment: z.string().optional(),
          // Optional final cost tally — one needs_review call can carry it.
          costTokensIn: z.number().int().min(0).optional(),
          costTokensOut: z.number().int().min(0).optional(),
          costUsdCents: z.number().int().min(0).optional(),
        },
        handler: async (args, actor) => {
          if (
            args.costTokensIn !== undefined ||
            args.costTokensOut !== undefined ||
            args.costUsdCents !== undefined
          ) {
            // Cost rides the transition but is booked BEFORE it: the claim
            // is still held here, so the claimant-only rule applies cleanly.
            await this.taskService.reportCost(actor!, {
              taskId: str(args.id),
              tokensIn: args.costTokensIn as number | undefined,
              tokensOut: args.costTokensOut as number | undefined,
              usdCents: args.costUsdCents as number | undefined,
            });
          }
          return this.taskService.transition(actor!, 'agent', {
            id: str(args.id),
            to: args.to as (typeof TASK_STATUSES)[number],
            comment: optStr(args.comment),
          });
        },
      },
      {
        ...meta('update_task_links'),
        inputSchema: {
          id: z.string().uuid(),
          branch: z.string().max(255).optional(),
          prUrl: z.string().max(500).optional(),
        },
        handler: async (args, actor) =>
          this.taskService.update(
            actor!,
            {
              id: str(args.id),
              branch: optStr(args.branch),
              prUrl: optStr(args.prUrl),
            },
            'agent',
          ),
      },
      {
        ...meta('get_notes'),
        inputSchema: { taskId: z.string().uuid() },
        handler: async (args, actor) => this.taskService.getNotes(actor!, str(args.taskId)),
      },
      {
        ...meta('report_cost'),
        inputSchema: {
          taskId: z.string().uuid(),
          tokensIn: z.number().int().min(0).optional(),
          tokensOut: z.number().int().min(0).optional(),
          usdCents: z.number().int().min(0).optional(),
        },
        handler: async (args, actor) =>
          this.taskService.reportCost(actor!, {
            taskId: str(args.taskId),
            tokensIn: args.tokensIn as number | undefined,
            tokensOut: args.tokensOut as number | undefined,
            usdCents: args.usdCents as number | undefined,
          }),
      },
      {
        ...meta('check_criterion'),
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
        ...meta('list_attachments'),
        inputSchema: { taskId: z.string().uuid() },
        handler: async (args, actor) =>
          this.attachmentsService.list(actor!, {
            subjectType: 'task',
            subjectId: str(args.taskId),
          }),
      },
      {
        ...meta('create_attachment_upload'),
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
        ...meta('confirm_attachment'),
        inputSchema: { id: z.string().uuid() },
        handler: async (args, actor) =>
          this.attachmentsService.confirm(actor!, { id: str(args.id) }),
      },
      {
        ...meta('add_comment'),
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
      // --- Research court: the async agent conversation ---
      {
        ...meta('list_research'),
        inputSchema: {
          projectId: z.string().uuid().optional(),
          // Omitted = the `researching` turn-queue, so the ambient runner is
          // unchanged. Pass a status to browse the fuller set; `all` drops the
          // status filter entirely (every status).
          status: z.enum(['researching', 'needs_review', 'accepted', 'all']).optional(),
          limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
          cursor: z.string().optional(),
        },
        handler: async (args, actor) => {
          const requested = args.status as
            | 'researching'
            | 'needs_review'
            | 'accepted'
            | 'all'
            | undefined;
          return this.researchService.list(actor!, {
            status: requested === 'all' ? undefined : (requested ?? 'researching'),
            projectId: optStr(args.projectId),
            limit: (args.limit as number | undefined) ?? 20,
            cursor: optStr(args.cursor),
          });
        },
      },
      {
        ...meta('get_research'),
        inputSchema: { id: z.string().uuid() },
        handler: async (args, actor) => this.researchService.getById(actor!, str(args.id)),
      },
      {
        ...meta('append_research_message'),
        inputSchema: {
          id: z.string().uuid(),
          bodyMarkdown: z.string().min(1),
          message: z.string().optional(),
        },
        handler: async (args, actor) =>
          this.researchService.agentAppend(actor!, {
            id: str(args.id),
            bodyMarkdown: str(args.bodyMarkdown),
            message: optStr(args.message),
          }),
      },
      {
        ...meta('heartbeat'),
        handler: async (_args, actor, auth) =>
          this.agentService.touch({ keyId: auth!.keyId, name: auth!.name, activeUser: actor! }),
      },
    ];
  }

  /**
   * Implicit presence: every successful agent-court call stamps the calling
   * key's agent row. Fire-and-forget by contract — a presence hiccup must
   * never fail the work that just succeeded.
   */
  stampPresence(auth: { keyId: string; name: string }, actor: ActiveUser): void {
    void this.agentService
      .touch({ keyId: auth.keyId, name: auth.name, activeUser: actor })
      .catch((error) => this.logger.warn({ error, keyId: auth.keyId }, 'Presence stamp failed'));
  }

  /**
   * The standing-credential killer: an agent trades its API key for a 1-hour
   * GitHub token restricted to the project's bound repo. Project resolution
   * goes through ProjectService with the ACTOR's org — a key of org A cannot
   * mint for org B's project. Every failure is a distinct k.* key, never a 500.
   */
  private async mintRepoToken(actor: ActiveUser, projectId: string) {
    if (!this.githubApp.enabled) {
      throw new BadRequestException(k.orgs.github.errors.notConfigured);
    }

    // Org-scoped lookup — throws projectNotFound for another org's project.
    const project = await this.projectService.getById(actor, projectId);
    if (!project.githubRepoId || !project.githubRepoFullName) {
      throw new BadRequestException(k.tasks.errors.projectNotBound);
    }

    const connection = await this.orgService.githubConnection(actor.orgId);
    if (!connection) {
      throw new BadRequestException(k.tasks.errors.githubNotConnected);
    }

    const minted = await this.githubApp.mintRepoToken(
      connection.installationId,
      project.githubRepoFullName,
    );
    if (!minted) {
      throw new BadRequestException(k.tasks.errors.repoDroppedFromGrant);
    }

    this.logger.info(
      { projectId, repoFullName: project.githubRepoFullName },
      'Repo-scoped GitHub token minted',
    );

    return {
      token: minted.token,
      expiresAt: minted.expiresAt,
      repoFullName: project.githubRepoFullName,
      cloneUrl: `https://x-access-token:${minted.token}@github.com/${project.githubRepoFullName}.git`,
    };
  }
}
