import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue, type JobsOptions } from 'bullmq';
import { GITHUB_WEBHOOK_JOB_NAMES, GITHUB_WEBHOOK_QUEUE } from './github-webhook.constants';
import type { GithubWebhookJobPayload } from './github-webhook.types';
import { InjectLogger, PinoLogger } from '../../logging';

@Injectable()
export class GithubWebhookProducer {
  constructor(
    @InjectLogger() private readonly logger: PinoLogger,
    @InjectQueue(GITHUB_WEBHOOK_QUEUE.name)
    private readonly queue: Queue<GithubWebhookJobPayload>,
  ) {}

  async enqueue(payload: GithubWebhookJobPayload) {
    // The delivery id as job id: GitHub redeliveries (retries, manual
    // redelivery from the App UI) collapse into one processed job.
    const jobOptions: JobsOptions = { jobId: `gh-${payload.deliveryId}` };

    const job = await this.queue.add(GITHUB_WEBHOOK_JOB_NAMES.PROCESS, payload, jobOptions);

    this.logger.info(
      { kind: payload.kind, repo: payload.repoFullName, deliveryId: payload.deliveryId },
      'Enqueued GitHub webhook event',
    );

    return job;
  }
}
