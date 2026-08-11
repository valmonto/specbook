import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectLogger, PinoLogger, ExampleProducer } from '@pkg/server';
import {
  type AcceptResearchRequest,
  type ActiveUser,
  type AppendResearchMessageRequest,
  type AppendResearchMessageResponse,
  type CreateResearchRequest,
  type CreateResearchResponse,
  type CutTicketsRequest,
  type CutTicketsResponse,
  type GetResearchResponse,
  type ListResearchMessagesRequest,
  type ListResearchMessagesResponse,
  type ListResearchRequest,
  type ListResearchResponse,
  type Research as ResearchDto,
  type ResearchAuthorType,
  type ResearchMessage as ResearchMessageDto,
  type ResearchStatus,
  type ReopenResearchRequest,
  type UpdateResearchRequest,
  type UpdateResearchResponse,
} from '@pkg/contracts';
import type { NewResearch, Research, ResearchMessage } from '@pkg/database';
import { k } from '@pkg/locales';
import { ProjectRepository } from '../tasks/project.repository';
import { TaskRepository } from '../tasks/task.repository';
import { ResearchRepository, type ResearchCursor } from './research.repository';

/** How many messages ride the initial get_research payload. */
const MESSAGES_FIRST_PAGE = 50;

/**
 * Research: a durable, versioned document produced through an async agent
 * conversation. The human court (REST) creates, converses, accepts, reopens
 * and cuts tickets; the agent court (MCP) reads the feed and publishes drafts.
 * Every method takes the ActiveUser and scopes to its org — research carries
 * org_id directly, so a foreign id behaves exactly like a missing one.
 */
@Injectable()
export class ResearchService {
  constructor(
    private readonly researchRepository: ResearchRepository,
    private readonly projectRepository: ProjectRepository,
    private readonly taskRepository: TaskRepository,
    private readonly turnQueue: ExampleProducer,
    @InjectLogger() private readonly logger: PinoLogger,
  ) {}

  async create(activeUser: ActiveUser, dto: CreateResearchRequest): Promise<CreateResearchResponse> {
    if (dto.projectId) await this.requireLiveProject(dto.projectId, activeUser.orgId);

    const created = await this.researchRepository.create({
      orgId: activeUser.orgId,
      projectId: dto.projectId ?? null,
      title: dto.title,
      createdBy: activeUser.userId,
    });

    // An optional first message seeds the conversation and asks for a turn.
    if (dto.message) {
      await this.researchRepository.createMessage({
        researchId: created.id,
        orgId: activeUser.orgId,
        authorId: activeUser.userId,
        authorType: 'user',
        body: dto.message,
      });
      await this.enqueueTurn(activeUser, created.id);
    }

    this.logger.info({ researchId: created.id, title: created.title }, 'Research created');
    return this.serialize(created);
  }

  async getById(activeUser: ActiveUser, id: string): Promise<GetResearchResponse> {
    const found = await this.requireResearch(id, activeUser.orgId);
    const [messages, tasksCut] = await Promise.all([
      this.researchRepository.listMessages(id, activeUser.orgId, { limit: MESSAGES_FIRST_PAGE }),
      this.researchRepository.countTasksCut(id, activeUser.orgId),
    ]);
    return {
      ...this.serialize(found),
      messages: messages.data.map((m) => this.serializeMessage(m)),
      tasksCut,
    };
  }

  async list(activeUser: ActiveUser, dto: ListResearchRequest): Promise<ListResearchResponse> {
    const { data, nextCursor } = await this.researchRepository.list(activeUser.orgId, {
      cursor: this.decodeCursor(dto.cursor),
      limit: dto.limit,
      projectId: dto.projectId,
      scope: dto.scope,
      status: dto.status,
      q: dto.q,
    });
    return {
      data: data.map((r) => this.serialize(r)),
      meta: { nextCursor: nextCursor ? this.encodeCursor(nextCursor) : null },
    };
  }

  async update(activeUser: ActiveUser, dto: UpdateResearchRequest): Promise<UpdateResearchResponse> {
    await this.requireResearch(dto.id, activeUser.orgId);
    if (dto.projectId) await this.requireLiveProject(dto.projectId, activeUser.orgId);

    const patch: Partial<NewResearch> = {};
    if (dto.title !== undefined) patch.title = dto.title;
    if (dto.projectId !== undefined) patch.projectId = dto.projectId;
    if (dto.bodyMarkdown !== undefined) patch.bodyMarkdown = dto.bodyMarkdown;

    const updated = await this.researchRepository.update(dto.id, activeUser.orgId, patch);
    if (!updated) throw new NotFoundException(k.research.errors.notFound);
    return this.serialize(updated);
  }

  /**
   * The human side of the conversation: persist the user's message and enqueue
   * an agent turn. The document goes back to `researching` — a reply awaits.
   * The research worker (drive the agent, publish a draft) is out of scope;
   * the enqueue is real so wiring it later needs no API change.
   */
  async appendMessage(
    activeUser: ActiveUser,
    dto: AppendResearchMessageRequest,
  ): Promise<AppendResearchMessageResponse> {
    await this.requireResearch(dto.id, activeUser.orgId);
    const created = await this.researchRepository.createMessage({
      researchId: dto.id,
      orgId: activeUser.orgId,
      authorId: activeUser.userId,
      authorType: 'user',
      body: dto.body,
    });
    await this.researchRepository.update(dto.id, activeUser.orgId, { status: 'researching' });
    await this.enqueueTurn(activeUser, dto.id);
    return this.serializeMessage(created);
  }

  async listMessages(
    activeUser: ActiveUser,
    dto: ListResearchMessagesRequest,
  ): Promise<ListResearchMessagesResponse> {
    await this.requireResearch(dto.id, activeUser.orgId);
    const { data, nextCursor } = await this.researchRepository.listMessages(
      dto.id,
      activeUser.orgId,
      { cursor: dto.cursor, limit: dto.limit },
    );
    return {
      data: data.map((m) => this.serializeMessage(m)),
      meta: { nextCursor },
    };
  }

  /** Finalize: needs_review → accepted, accepted_at = now. */
  async accept(activeUser: ActiveUser, dto: AcceptResearchRequest): Promise<ResearchDto> {
    const found = await this.requireResearch(dto.id, activeUser.orgId);
    if (found.status !== 'needs_review') {
      throw new UnprocessableEntityException(k.research.errors.notReviewable);
    }
    const updated = await this.researchRepository.update(dto.id, activeUser.orgId, {
      status: 'accepted',
      acceptedAt: new Date(),
    });
    if (!updated) throw new NotFoundException(k.research.errors.notFound);
    this.logger.info({ researchId: dto.id }, 'Research accepted');
    return this.serialize(updated);
  }

  /**
   * Reopen: accepted → needs_review, human-only (no MCP tool wraps it — an
   * agent must never resurrect its own accepted work). The feedback message is
   * required, the round-2 spec delta, exactly like a task reopen's.
   */
  async reopen(activeUser: ActiveUser, dto: ReopenResearchRequest): Promise<ResearchDto> {
    const found = await this.requireResearch(dto.id, activeUser.orgId);
    if (found.status !== 'accepted') {
      throw new UnprocessableEntityException(k.research.errors.notAccepted);
    }
    const comment = dto.comment?.trim();
    if (!comment) {
      throw new UnprocessableEntityException(k.research.errors.reopenFeedbackRequired);
    }
    await this.researchRepository.createMessage({
      researchId: dto.id,
      orgId: activeUser.orgId,
      authorId: activeUser.userId,
      authorType: 'user',
      body: comment,
    });
    const updated = await this.researchRepository.update(dto.id, activeUser.orgId, {
      status: 'needs_review',
      acceptedAt: null,
    });
    if (!updated) throw new NotFoundException(k.research.errors.notFound);
    this.logger.info({ researchId: dto.id }, 'Research reopened');
    return this.serialize(updated);
  }

  /**
   * Cut draft tickets from a document. Each proposal becomes a DRAFT task in
   * the target project (default = the research's associated project), carrying
   * `source_research_id` lineage. Drafts only — the Ready boundary still gates
   * dispatch. Gated by task:create at the controller.
   */
  async cutTickets(
    activeUser: ActiveUser,
    dto: CutTicketsRequest,
  ): Promise<CutTicketsResponse> {
    const found = await this.requireResearch(dto.id, activeUser.orgId);
    const targetProjectId = dto.targetProjectId ?? found.projectId;
    if (!targetProjectId) {
      throw new UnprocessableEntityException(k.research.errors.noTargetProject);
    }
    await this.requireLiveProject(targetProjectId, activeUser.orgId);

    const taskIds: string[] = [];
    for (const proposal of dto.proposals) {
      const created = await this.taskRepository.create({
        projectId: targetProjectId,
        title: proposal.title,
        context: proposal.context,
        status: 'draft',
        sourceResearchId: found.id,
        createdBy: activeUser.userId,
      });
      taskIds.push(created.id);
    }
    this.logger.info(
      { researchId: dto.id, targetProjectId, count: taskIds.length },
      'Tickets cut from research',
    );
    return { taskIds };
  }

  async delete(activeUser: ActiveUser, id: string): Promise<void> {
    await this.requireResearch(id, activeUser.orgId);
    await this.researchRepository.delete(id, activeUser.orgId);
    this.logger.info({ researchId: id }, 'Research deleted');
  }

  /**
   * The agent court: an agent reply that publishes a new draft. Appends the
   * agent's message, replaces the document body, bumps the version, and moves
   * to needs_review — the research analogue of submitting for review. Called
   * only through the MCP tool (actor is the API key's user, author_type
   * 'agent').
   */
  async agentAppend(
    activeUser: ActiveUser,
    dto: { id: string; message?: string; bodyMarkdown: string },
  ): Promise<ResearchDto> {
    const found = await this.requireResearch(dto.id, activeUser.orgId);
    await this.researchRepository.createMessage({
      researchId: dto.id,
      orgId: activeUser.orgId,
      authorId: activeUser.userId,
      authorType: 'agent',
      body: dto.message?.trim() || 'Published a new draft.',
    });
    const updated = await this.researchRepository.update(dto.id, activeUser.orgId, {
      bodyMarkdown: dto.bodyMarkdown,
      version: found.version + 1,
      status: 'needs_review',
    });
    if (!updated) throw new NotFoundException(k.research.errors.notFound);
    this.logger.info({ researchId: dto.id, version: updated.version }, 'Research draft published');
    return this.serialize(updated);
  }

  // --- internals ---

  private async requireResearch(id: string, orgId: string): Promise<Research> {
    const found = await this.researchRepository.findById(id, orgId);
    if (!found) throw new NotFoundException(k.research.errors.notFound);
    return found;
  }

  /** Org-scoped project lookup + archive guard, shared by create/update/cut. */
  private async requireLiveProject(projectId: string, orgId: string): Promise<void> {
    const owner = await this.projectRepository.findById(projectId, orgId);
    if (!owner) throw new NotFoundException(k.tasks.errors.projectNotFound);
    if (owner.archivedAt) {
      throw new UnprocessableEntityException(k.tasks.errors.projectArchivedReadonly);
    }
  }

  private async enqueueTurn(activeUser: ActiveUser, researchId: string): Promise<void> {
    // Identity from the session, never the payload. The action rides the
    // existing example queue as a typed stub until the research worker lands.
    await this.turnQueue.enqueue({
      userId: activeUser.userId,
      orgId: activeUser.orgId,
      action: 'research-turn',
      data: { researchId },
    });
  }

  private encodeCursor(cursor: ResearchCursor): string {
    return Buffer.from(`${cursor.updatedAt.toISOString()}|${cursor.id}`).toString('base64url');
  }

  private decodeCursor(raw?: string): ResearchCursor | undefined {
    if (!raw) return undefined;
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    const sep = decoded.lastIndexOf('|');
    if (sep < 0) return undefined; // tolerate garbage — treat as no cursor
    const updatedAt = new Date(decoded.slice(0, sep));
    const id = decoded.slice(sep + 1);
    if (Number.isNaN(updatedAt.getTime()) || !id) return undefined;
    return { updatedAt, id };
  }

  private serialize(r: Research): ResearchDto {
    return {
      ...r,
      status: r.status as ResearchStatus,
      acceptedAt: r.acceptedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  private serializeMessage(m: ResearchMessage): ResearchMessageDto {
    return {
      ...m,
      authorType: m.authorType as ResearchAuthorType,
      createdAt: m.createdAt.toISOString(),
    };
  }
}
