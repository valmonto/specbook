import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type Job } from 'bullmq';
import {
  DATABASE_CLIENT,
  type DatabaseClient,
  agent,
  server,
  eq,
  type AgentRow,
  type Server,
} from '@pkg/database';
import {
  AGENT_LIFECYCLE_QUEUE,
  InjectLogger,
  PinoLogger,
  SecretsService,
  SshService,
  appendDeployLog,
  scrubDeployText,
  type AgentLifecycleJobPayload,
  type SshTarget,
} from '@pkg/server';
// Managed-agent rendering is specbook-domain (the dispatch runbook), so it
// lives here next to its only consumer rather than in the shared deploy engine.
import { renderRunnerMcpJson, renderRunnerPrompt } from './runner-render.js';

/**
 * Managed-agent lifecycle: start = ensure the box can host a runner (CLI,
 * tmux, workdir, Anthropic auth probe), materialize the workdir files
 * (.mcp.json with the sealed key — the only place it ever decrypts — and the
 * runner prompt), launch the tmux session. Stop = kill the session.
 * Anthropic credentials are NEVER touched: a failed auth probe parks the
 * agent in auth_needed and the UI tells the human the one command to run.
 */
@Processor(AGENT_LIFECYCLE_QUEUE.name, AGENT_LIFECYCLE_QUEUE.workerOptions)
export class AgentLifecycleProcessor extends WorkerHost {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly dbClient: DatabaseClient,
    private readonly ssh: SshService,
    private readonly secrets: SecretsService,
    private readonly config: ConfigService,
    @InjectLogger() private readonly logger: PinoLogger,
  ) {
    super();
  }

  async process(job: Job<AgentLifecycleJobPayload>): Promise<void> {
    const { agentId, action } = job.data;
    const [row] = await this.dbClient.db
      .select({ agent: agent, server: server })
      .from(agent)
      .innerJoin(server, eq(server.id, agent.serverId))
      .where(eq(agent.id, agentId))
      .limit(1);
    if (!row || row.agent.kind !== 'managed') return;

    const target = this.targetFor(row.server);
    try {
      if (action === 'start') await this.start(row.agent, target);
      else await this.stop(row.agent, target);
    } catch (error) {
      const detail = scrubDeployText((error as Error).message ?? 'lifecycle failed');
      await this.patch(row.agent.id, {
        status: 'error',
        log: appendDeployLog(row.agent.log, `\nERROR: ${detail}\n`),
      });
      this.logger.error({ agentId, action, err: detail.slice(0, 300) }, 'Agent lifecycle failed');
    }
  }

  private async start(row: AgentRow, target: SshTarget): Promise<void> {
    const ensure = await this.ssh.exec(target, 'ensure-runner', [row.name]);
    if (ensure.includes('AUTH_MISSING')) {
      await this.patch(row.id, {
        status: 'auth_needed',
        log: appendDeployLog(row.log, scrubDeployText(ensure)),
      });
      return;
    }

    if (!row.mcpKeyEnc) throw new Error('managed agent has no sealed key');
    const key = this.secrets.open(row.mcpKeyEnc);
    const baseUrl = this.config.get<string>('PUBLIC_BASE_URL')!;
    const dir = `specbook-runner/${row.name}`;
    await this.ssh.writeFile(target, `${dir}/.mcp.json`, renderRunnerMcpJson(baseUrl, key));
    await this.ssh.writeFile(target, `${dir}/runner-prompt.md`, renderRunnerPrompt(row.name));
    // Pre-approve the workdir's own MCP config so the CLI needs no
    // interactive consent for the server specbook itself just wrote.
    await this.ssh.writeFile(
      target,
      `${dir}/.claude/settings.json`,
      `${JSON.stringify({ enableAllProjectMcpServers: true }, null, 2)}\n`,
    );

    const out = await this.ssh.exec(target, 'runner-start', [row.name]);
    await this.patch(row.id, {
      status: 'idle',
      startedAt: new Date(),
      // The key is a literal in memory here — scrub defensively even though
      // the ops never echo it.
      log: appendDeployLog(row.log, scrubDeployText(`${ensure}${out}`, [key])),
    });
    this.logger.info({ agentId: row.id, name: row.name }, 'Managed agent started');
  }

  private async stop(row: AgentRow, target: SshTarget): Promise<void> {
    const out = await this.ssh.exec(target, 'runner-stop', [row.name]);
    await this.patch(row.id, {
      status: 'stopped',
      log: appendDeployLog(row.log, scrubDeployText(out)),
    });
    this.logger.info({ agentId: row.id, name: row.name }, 'Managed agent stopped');
  }

  private async patch(id: string, patch: Partial<AgentRow>): Promise<void> {
    await this.dbClient.db.update(agent).set(patch).where(eq(agent.id, id));
  }

  private targetFor(srv: Server): SshTarget {
    return {
      host: srv.host,
      port: srv.port,
      user: srv.sshUser,
      privateKey: this.secrets.open(srv.privateKeyEnc),
      hostFingerprint: srv.hostFingerprint,
    };
  }
}
