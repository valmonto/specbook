import { Injectable } from '@nestjs/common';
import { AGENT_OFFLINE_AFTER_MS, type ActiveUser, type Agent as AgentDto } from '@pkg/contracts';
import { InjectLogger, PinoLogger } from '@pkg/server';
import { AgentRepository, type AgentWithContext } from './agent.repository';

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
    @InjectLogger() private readonly logger: PinoLogger,
  ) {}

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
    const stale =
      !r.lastSeenAt || Date.now() - r.lastSeenAt.getTime() > AGENT_OFFLINE_AFTER_MS;
    const presence = ['idle', 'working'].includes(r.status);
    return {
      id: r.id,
      name: r.name,
      kind: r.kind as AgentDto['kind'],
      status: (presence && stale ? 'offline' : r.status) as AgentDto['status'],
      serverId: r.serverId,
      serverName: r.serverName,
      currentTaskId: r.currentTaskId,
      currentTaskTitle: r.currentTaskTitle,
      lastSeenAt: r.lastSeenAt?.toISOString() ?? null,
      startedAt: r.startedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    };
  }
}
