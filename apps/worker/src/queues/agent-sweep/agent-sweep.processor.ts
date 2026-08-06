import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, type OnModuleInit } from '@nestjs/common';
import { Queue, type Job } from 'bullmq';
import {
  DATABASE_CLIENT,
  type DatabaseClient,
  agent,
  apiKey,
  project,
  server,
  task,
  taskComment,
  and,
  eq,
  inArray,
  type AgentRow,
  type Server,
} from '@pkg/database';
import { STALE_CLAIM_AFTER_MS } from '@pkg/contracts';
import {
  AGENT_SWEEP_QUEUE,
  InjectLogger,
  PinoLogger,
  SecretsService,
  SshService,
  appendDeployLog,
  scrubDeployText,
} from '@pkg/server';

/**
 * Stale-claim release: an in_progress task whose claimant agent has gone
 * silent past STALE_CLAIM_AFTER returns to ready with an audit comment, so
 * a dead runner never wedges the board.
 *
 * Deliberate boundaries:
 *  - only in_progress — blocked is a HUMAN wait (silence expected) and
 *    needs_review already left the agent court; the WHERE clause enforces it.
 *  - claims with NO agent rows (pre-presence sessions, human tests) are
 *    left untouched — release requires positive evidence of a dead agent,
 *    not absence of evidence.
 *  - claim attribution is per user today, so the claimant's liveness is the
 *    MOST RECENT last_seen across that user's agents in the org.
 */
@Processor(AGENT_SWEEP_QUEUE.name, AGENT_SWEEP_QUEUE.workerOptions)
export class AgentSweepProcessor extends WorkerHost implements OnModuleInit {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly dbClient: DatabaseClient,
    @InjectQueue(AGENT_SWEEP_QUEUE.name) private readonly queue: Queue,
    private readonly ssh: SshService,
    private readonly secrets: SecretsService,
    @InjectLogger() private readonly logger: PinoLogger,
  ) {
    super();
  }

  /** Self-scheduling, like every sweep: the worker owns its own heartbeat. */
  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler('agent-sweep-tick', {
      every: AGENT_SWEEP_QUEUE.repeatEveryMs,
    });
  }

  async process(_job: Job): Promise<{ released: number }> {
    const cutoff = new Date(Date.now() - STALE_CLAIM_AFTER_MS);

    const claims = await this.dbClient.db
      .select({ task: task, orgId: project.orgId })
      .from(task)
      .innerJoin(project, eq(project.id, task.projectId))
      .where(eq(task.status, 'in_progress'))
      .limit(AGENT_SWEEP_QUEUE.batchSize);

    let released = 0;
    for (const { task: row, orgId } of claims) {
      if (!row.claimedBy) continue;
      const agents = await this.claimantAgents(row.claimedBy, orgId);
      if (agents.length === 0) continue; // no presence data — never guess
      const lastSeen = agents
        .map((a) => a.lastSeenAt?.getTime() ?? 0)
        .reduce((max, t) => Math.max(max, t), 0);
      if (lastSeen >= cutoff.getTime()) continue;

      const name = agents.find((a) => (a.lastSeenAt?.getTime() ?? 0) === lastSeen)?.name ?? 'agent';
      await this.release(row.id, row.claimedBy, name, new Date(lastSeen));
      released += 1;
      this.logger.info({ taskId: row.id, agent: name }, 'Stale claim released');
    }

    await this.pollManaged();

    return { released };
  }

  /**
   * Managed agents: reconcile the stored lifecycle with the box's reality —
   * a session that vanished while the agent was supposed to be running flips
   * to error (with the pane's last words in the log), and the visible tail
   * refreshes each tick. Best-effort per agent: one dead box never stalls
   * the sweep for the rest.
   */
  private async pollManaged(): Promise<void> {
    const rows = await this.dbClient.db
      .select({ agent: agent, server: server })
      .from(agent)
      .innerJoin(server, eq(server.id, agent.serverId))
      .where(and(eq(agent.kind, 'managed'), inArray(agent.status, ['idle', 'working'])));

    for (const { agent: row, server: srv } of rows) {
      try {
        const out = await this.ssh.exec(this.targetFor(srv), 'runner-status', [row.name]);
        const alive = out.includes('RUNNER_RUNNING');
        const tail = scrubDeployText(out.replace(/^RUNNER_(RUNNING|STOPPED)\n?/, ''));
        await this.dbClient.db
          .update(agent)
          .set(
            alive
              ? { log: appendDeployLog(null, tail) }
              : {
                  status: 'error',
                  log: appendDeployLog(
                    appendDeployLog(null, tail),
                    '\nsession not found — the runner died or was killed outside specbook\n',
                  ),
                },
          )
          .where(eq(agent.id, row.id));
        if (!alive) this.logger.warn({ agentId: row.id, name: row.name }, 'Managed agent session gone');
      } catch (error) {
        this.logger.warn({ agentId: row.id, error }, 'Managed agent status poll failed');
      }
    }
  }

  private targetFor(srv: Server) {
    return {
      host: srv.host,
      port: srv.port,
      user: srv.sshUser,
      privateKey: this.secrets.open(srv.privateKeyEnc),
      hostFingerprint: srv.hostFingerprint,
    };
  }

  /** The claimant user's agents inside the owning org (identity = api key). */
  private async claimantAgents(userId: string, orgId: string): Promise<AgentRow[]> {
    const keys = await this.dbClient.db
      .select({ id: apiKey.id })
      .from(apiKey)
      .where(and(eq(apiKey.userId, userId), eq(apiKey.orgId, orgId)));
    if (keys.length === 0) return [];
    return this.dbClient.db
      .select()
      .from(agent)
      .where(
        and(
          eq(agent.orgId, orgId),
          inArray(
            agent.apiKeyId,
            keys.map((key) => key.id),
          ),
        ),
      );
  }

  /**
   * Idempotent by state: the guard re-checks in_progress in the WHERE, so a
   * retried job (or a racing human transition) releases nothing twice.
   */
  private async release(
    taskId: string,
    claimedBy: string,
    agentName: string,
    lastSeen: Date,
  ): Promise<void> {
    const updated = await this.dbClient.db
      .update(task)
      .set({
        status: 'ready',
        claimedBy: null,
        claimedAt: null,
        statusChangedBy: claimedBy,
        statusChangedAt: new Date(),
      })
      .where(and(eq(task.id, taskId), eq(task.status, 'in_progress')))
      .returning({ id: task.id });
    if (updated.length === 0) return;

    await this.dbClient.db.insert(taskComment).values({
      taskId,
      authorId: claimedBy,
      authorType: 'agent',
      kind: 'comment',
      body: `claim released: agent '${agentName}' silent since ${lastSeen.toISOString()} — task returned to ready`,
    });
  }
}
