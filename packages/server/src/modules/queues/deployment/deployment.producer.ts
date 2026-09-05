import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { DEPLOYMENT_JOB_NAMES, DEPLOYMENT_QUEUE } from './deployment.constants.js';
import type { DeploymentJobPayload } from './deployment.types.js';

@Injectable()
export class DeploymentProducer {
  constructor(
    @InjectQueue(DEPLOYMENT_QUEUE.name)
    private readonly queue: Queue<DeploymentJobPayload>,
  ) {}

  async enqueueDeploy(deploymentId: string) {
    return this.queue.add(DEPLOYMENT_JOB_NAMES.DEPLOY, { deploymentId });
  }
}
