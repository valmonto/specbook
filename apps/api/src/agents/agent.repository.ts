import { Inject, Injectable } from '@nestjs/common';
import {
  DATABASE_CLIENT,
  type DatabaseClient,
  agent,
  project,
  server,
  task,
  and,
  asc,
  desc,
  eq,
  type AgentRow,
  type NewAgentRow,
} from '@pkg/database';

/** An agent row joined with its display context. */
export type AgentWithContext = AgentRow & {
  serverName: string | null;
  currentTaskTitle: string | null;
};

/**
 * Org-scoped like every repository: an agent is only reachable inside the
 * org its API key was minted in.
 */
@Injectable()
export class AgentRepository {
  constructor(@Inject(DATABASE_CLIENT) private readonly dbClient: DatabaseClient) {}

  async findByApiKey(apiKeyId: string): Promise<AgentRow | null> {
    const [row] = await this.dbClient.db
      .select()
      .from(agent)
      .where(eq(agent.apiKeyId, apiKeyId))
      .limit(1);
    return row ?? null;
  }

  async create(data: NewAgentRow): Promise<AgentRow> {
    const [row] = await this.dbClient.db.insert(agent).values(data).returning();
    return row!;
  }

  async update(id: string, orgId: string, patch: Partial<NewAgentRow>): Promise<AgentRow | null> {
    const [row] = await this.dbClient.db
      .update(agent)
      .set(patch)
      .where(and(eq(agent.id, id), eq(agent.orgId, orgId)))
      .returning();
    return row ?? null;
  }

  /**
   * The claim this agent's acting user currently holds, org-scoped through
   * the project join. Claims are attributed per USER today, so two agents
   * whose keys act as the same user resolve to the same task — acceptable
   * until claims carry agent identity.
   */
  async currentClaim(
    userId: string,
    orgId: string,
  ): Promise<{ id: string; title: string } | null> {
    const [row] = await this.dbClient.db
      .select({ id: task.id, title: task.title })
      .from(task)
      .innerJoin(project, and(eq(project.id, task.projectId), eq(project.orgId, orgId)))
      .where(and(eq(task.claimedBy, userId), eq(task.status, 'in_progress')))
      .orderBy(desc(task.claimedAt))
      .limit(1);
    return row ?? null;
  }

  async listForOrg(orgId: string): Promise<AgentWithContext[]> {
    const rows = await this.dbClient.db
      .select({ agent: agent, serverName: server.name, currentTaskTitle: task.title })
      .from(agent)
      .leftJoin(server, eq(server.id, agent.serverId))
      .leftJoin(task, eq(task.id, agent.currentTaskId))
      .where(eq(agent.orgId, orgId))
      .orderBy(asc(agent.name));
    return rows.map((r) => ({
      ...r.agent,
      serverName: r.serverName ?? null,
      currentTaskTitle: r.currentTaskTitle ?? null,
    }));
  }
}
