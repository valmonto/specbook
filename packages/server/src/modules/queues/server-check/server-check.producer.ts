import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { SERVER_CHECK_JOB_NAMES, SERVER_CHECK_QUEUE } from './server-check.constants';
import type { ServerCheckJobPayload } from './server-check.types';

@Injectable()
export class ServerCheckProducer {
  constructor(
    @InjectQueue(SERVER_CHECK_QUEUE.name)
    private readonly queue: Queue<ServerCheckJobPayload>,
  ) {}

  /** One check per server at a time — repeat clicks collapse. */
  async enqueueCheck(serverId: string) {
    return this.queue.add(
      SERVER_CHECK_JOB_NAMES.CHECK,
      { serverId },
      { jobId: `server-check-${serverId}` },
    );
  }

  /**
   * Recurring sweep keeping every status chip honest. A job scheduler, not
   * the legacy `repeat` option — bullmq 6 removed that from `JobsOptions`;
   * the scheduler is idempotent on its id, so re-registering on every boot
   * is safe.
   */
  async scheduleSweep(everyMs: number) {
    return this.queue.upsertJobScheduler(
      'server-check-sweep',
      { every: everyMs },
      { name: SERVER_CHECK_JOB_NAMES.SWEEP, data: { sweep: true } },
    );
  }
}
