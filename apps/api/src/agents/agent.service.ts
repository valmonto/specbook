import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  AGENT_OFFLINE_AFTER_MS,
  type ActiveUser,
  type Agent as AgentDto,
  type AgentActionRequest,
  type CreateManagedAgentRequest,
} from '@pkg/contracts';
import { k } from '@pkg/locales';
import { AgentLifecycleProducer, InjectLogger, PinoLogger, SecretsService } from '@pkg/server';
import { ApiKeyService } from '../api-key/api-key.service.js';
import { AgentRepository, type AgentWithContext } from './agent.repository.js';

/** What the MCP layer knows about the calling key — an agent's identity. */
export interface AgentIdentity {
  keyId: string;
  name: string;
  activeUser: ActiveUser;
}

/** Postgres 23505 on the (org, name) unique index. */
function isNameCollision(error: unknown): boolean {
  for (
    let e = error as { code?: string; constraint?: string; cause?: unknown } | undefined;
    e;
    e = e.cause as typeof e
  ) {
    if (e.code === '23505') return true;
  }
  return false;
}

/**
 * Presence: every agent-court MCP call lands here (explicitly via the
 * heartbeat tool, implicitly after any tool call), upserting the agent row
 * for the calling key and stamping liveness + the current claim.
 */
@Injectable()
export class AgentService {
  constructor(
    private readonly agentRepository: AgentRepository,
    private readonly apiKeys: ApiKeyService,
    private readonly secrets: SecretsService,
    private readonly lifecycle: AgentLifecycleProducer,
    @InjectLogger() private readonly logger: PinoLogger,
  ) {}

  /**
   * Create a managed agent: mint its dedicated API key (identity), seal the
   * plaintext for the worker to materialize onto the box at start, and park
   * it stopped. One managed agent per server is a DEFAULT, not a law — a
   * second needs the explicit confirm (memory sizing is documented, the
   * operator decides).
   */
  async createManaged(activeUser: ActiveUser, dto: CreateManagedAgentRequest): Promise<AgentDto> {
    const srv = await this.agentRepository.findServer(dto.serverId, activeUser.orgId);
    if (!srv) throw new NotFoundException(k.servers.errors.notFound);
    const roles = Array.isArray(srv.roles) ? (srv.roles as string[]) : [];
    if (!roles.includes('runner')) {
      throw new BadRequestException(k.agents.errors.serverNotRunner);
    }
    const existing = await this.agentRepository.findManagedByServer(dto.serverId, activeUser.orgId);
    if (existing.length > 0 && !dto.confirmAdditional) {
      throw new BadRequestException(k.agents.errors.serverBusy);
    }

    const minted = await this.apiKeys.create(activeUser, {
      name: `agent:${dto.name}`,
      scopes: ['tasks:agent'],
    });
    let row;
    try {
      row = await this.agentRepository.create({
        orgId: activeUser.orgId,
        name: dto.name,
        apiKeyId: minted.id,
        serverId: dto.serverId,
        kind: 'managed',
        status: 'stopped',
        mcpKeyEnc: this.secrets.seal(minted.key),
      });
    } catch (error) {
      if (isNameCollision(error)) {
        throw new BadRequestException(k.agents.errors.nameTaken);
      }
      throw error;
    }
    this.logger.info(
      { agentId: row.id, name: row.name, serverId: dto.serverId, keyId: minted.id },
      'Managed agent created',
    );
    return this.serialize({
      ...row,
      serverName: srv.name,
      serverHost: srv.host,
      serverSshUser: srv.sshUser,
      currentTaskTitle: null,
    });
  }

  async start(activeUser: ActiveUser, dto: AgentActionRequest): Promise<AgentDto> {
    const row = await this.managedOrThrow(dto.id, activeUser.orgId);
    await this.agentRepository.update(row.id, activeUser.orgId, { status: 'starting' });
    await this.lifecycle.enqueue({ agentId: row.id, action: 'start' });
    this.logger.info({ agentId: row.id }, 'Managed agent start enqueued');
    return this.getById(activeUser, row.id);
  }

  async stop(activeUser: ActiveUser, dto: AgentActionRequest): Promise<AgentDto> {
    const row = await this.managedOrThrow(dto.id, activeUser.orgId);
    await this.lifecycle.enqueue({ agentId: row.id, action: 'stop' });
    this.logger.info({ agentId: row.id }, 'Managed agent stop enqueued');
    return this.getById(activeUser, row.id);
  }

  private async managedOrThrow(id: string, orgId: string) {
    const row = await this.agentRepository.findById(id, orgId);
    if (!row) throw new NotFoundException(k.agents.errors.notFound);
    if (row.kind !== 'managed') throw new BadRequestException(k.agents.errors.notManaged);
    return row;
  }

  private async getById(activeUser: ActiveUser, id: string): Promise<AgentDto> {
    const rows = await this.agentRepository.listForOrg(activeUser.orgId);
    const found = rows.find((r) => r.id === id);
    if (!found) throw new NotFoundException(k.agents.errors.notFound);
    return this.serialize(found);
  }

  /**
   * Upsert-and-stamp. Never throws to the caller's benefit — the MCP layer
   * fires this after successful tool calls and a presence hiccup must not
   * fail the work itself; the heartbeat tool awaits it and returns the row.
   */
  async touch(identity: AgentIdentity): Promise<AgentDto> {
    const { keyId, activeUser } = identity;
    const claim = await this.agentRepository.currentClaim(activeUser.userId, activeUser.orgId);
    const stamp = {
      lastSeenAt: new Date(),
      currentTaskId: claim?.id ?? null,
      status: claim ? ('working' as const) : ('idle' as const),
    };

    let row = await this.agentRepository.findByApiKey(keyId);
    if (row && row.orgId === activeUser.orgId) {
      row = (await this.agentRepository.update(row.id, row.orgId, stamp)) ?? row;
    } else if (!row) {
      row = await this.createWithUniqueName(identity, stamp);
    }
    // A key re-bound across orgs never leaks the old row: treat as absent.
    if (row.orgId !== activeUser.orgId) {
      row = await this.createWithUniqueName(identity, stamp);
    }

    return this.serialize({
      ...row,
      serverName: null,
      serverHost: null,
      serverSshUser: null,
      currentTaskTitle: claim?.title ?? null,
    });
  }

  async list(activeUser: ActiveUser): Promise<{ data: AgentDto[] }> {
    const rows = await this.agentRepository.listForOrg(activeUser.orgId);
    return { data: rows.map((r) => this.serialize(r)) };
  }

  /** First contact: kind=external (managed agents are created by their slice). */
  private async createWithUniqueName(
    identity: AgentIdentity,
    stamp: { lastSeenAt: Date; currentTaskId: string | null; status: 'working' | 'idle' },
  ) {
    const base = identity.name.slice(0, 56) || 'agent';
    try {
      return await this.create(identity, base, stamp);
    } catch (error) {
      if (!isNameCollision(error)) throw error;
      // Same display name, different key: disambiguate deterministically.
      return this.create(identity, `${base}-${identity.keyId.slice(0, 6)}`, stamp);
    }
  }

  private async create(
    identity: AgentIdentity,
    name: string,
    stamp: { lastSeenAt: Date; currentTaskId: string | null; status: 'working' | 'idle' },
  ) {
    const row = await this.agentRepository.create({
      orgId: identity.activeUser.orgId,
      name,
      apiKeyId: identity.keyId,
      kind: 'external',
      startedAt: new Date(),
      ...stamp,
    });
    this.logger.info({ agentId: row.id, name: row.name }, 'Agent registered');
    return row;
  }

  /**
   * The ONLY outward shape — identity (api_key_id) never serializes, and
   * silence overrides the stored status: an agent unseen for
   * AGENT_OFFLINE_AFTER_MS reads as offline whatever it last claimed to be.
   */
  private serialize(r: AgentWithContext): AgentDto {
    const stale = !r.lastSeenAt || Date.now() - r.lastSeenAt.getTime() > AGENT_OFFLINE_AFTER_MS;
    const presence = ['idle', 'working'].includes(r.status);
    return {
      id: r.id,
      name: r.name,
      kind: r.kind as AgentDto['kind'],
      status: (presence && stale ? 'offline' : r.status) as AgentDto['status'],
      serverId: r.serverId,
      serverName: r.serverName,
      serverHost: r.serverHost,
      serverSshUser: r.serverSshUser,
      currentTaskId: r.currentTaskId,
      currentTaskTitle: r.currentTaskTitle,
      lastSeenAt: r.lastSeenAt?.toISOString() ?? null,
      startedAt: r.startedAt?.toISOString() ?? null,
      log: r.log ?? null,
      createdAt: r.createdAt.toISOString(),
    };
  }
}
