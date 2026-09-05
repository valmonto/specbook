import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, type OnModuleInit } from '@nestjs/common';
import { Queue, type Job } from 'bullmq';
import { DATABASE_CLIENT, type DatabaseClient, server, eq, type Server } from '@pkg/database';
import {
  InjectLogger,
  PinoLogger,
  SecretsService,
  SshService,
  SERVER_CHECK_QUEUE,
  type ServerCheckJobPayload,
} from '@pkg/server';

const SWEEP_EVERY_MS = 10 * 60 * 1000;

/**
 * The only place SSH ever happens for server checks. Unseals the key just
 * long enough to connect, pins the host fingerprint on first success, and
 * writes an honest status back to the row:
 *  - reachable            connect ok, fingerprint matches (or first pin)
 *  - unreachable          network/auth failure
 *  - fingerprint_mismatch host key changed since the pin — NEVER silently
 *    re-pinned; a human re-earns trust by editing the host (which resets it)
 */
@Processor(SERVER_CHECK_QUEUE.name, SERVER_CHECK_QUEUE.workerOptions)
export class ServerCheckProcessor extends WorkerHost implements OnModuleInit {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly dbClient: DatabaseClient,
    private readonly ssh: SshService,
    private readonly secrets: SecretsService,
    @InjectQueue(SERVER_CHECK_QUEUE.name) private readonly queue: Queue,
    @InjectLogger() private readonly logger: PinoLogger,
  ) {
    super();
  }

  /** Self-scheduling, like every sweep (bullmq 6 dropped the legacy `repeat` option). */
  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(
      'server-check-sweep',
      { every: SWEEP_EVERY_MS },
      { name: 'sweep-all', data: { sweep: true } },
    );
  }

  async process(job: Job<ServerCheckJobPayload>): Promise<void> {
    if (job.data.sweep) {
      const rows = await this.dbClient.db.select({ id: server.id }).from(server);
      for (const row of rows) {
        await this.checkOne(row.id);
      }
      return;
    }
    if (job.data.serverId) {
      await this.checkOne(job.data.serverId);
    }
  }

  private async checkOne(id: string): Promise<void> {
    const [row] = await this.dbClient.db.select().from(server).where(eq(server.id, id)).limit(1);
    if (!row) return;

    const result = await this.ssh.testConnection({
      host: row.host,
      port: row.port,
      user: row.sshUser,
      privateKey: this.secrets.open(row.privateKeyEnc),
      hostFingerprint: row.hostFingerprint,
    });

    const patch: Partial<Server> = { lastCheckedAt: new Date() };
    if (result.ok) {
      patch.status = 'reachable';
      if (!row.hostFingerprint && result.fingerprint) {
        patch.hostFingerprint = result.fingerprint; // pin on first contact
      }
    } else {
      patch.status =
        result.reason === 'fingerprint_mismatch' ? 'fingerprint_mismatch' : 'unreachable';
    }

    await this.dbClient.db.update(server).set(patch).where(eq(server.id, id));
    this.logger.info(
      {
        serverId: id,
        host: row.host,
        status: patch.status,
        pinned: Boolean(patch.hostFingerprint),
      },
      'Server check finished',
    );
  }
}
