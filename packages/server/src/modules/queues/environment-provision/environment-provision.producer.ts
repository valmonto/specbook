import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import {
  ENVIRONMENT_PROVISION_JOB_NAMES,
  ENVIRONMENT_PROVISION_QUEUE,
} from './environment-provision.constants.js';
import type { EnvironmentProvisionJobPayload } from './environment-provision.types.js';

@Injectable()
export class EnvironmentProvisionProducer {
  constructor(
    @InjectQueue(ENVIRONMENT_PROVISION_QUEUE.name)
    private readonly queue: Queue<EnvironmentProvisionJobPayload>,
  ) {}

  /** One provision per environment at a time — repeat clicks collapse. */
  async enqueueProvision(environmentId: string) {
    return this.queue.add(
      ENVIRONMENT_PROVISION_JOB_NAMES.PROVISION,
      { environmentId },
      { jobId: `environment-provision-${environmentId}` },
    );
  }

  /** Best-effort teardown from a pre-delete snapshot; placement servers get their role torn down too. */
  async enqueueDeprovision(
    serverId: string,
    unit: string,
    placement: { databaseServerId?: string | null; cacheServerId?: string | null } = {},
  ) {
    return this.queue.add(ENVIRONMENT_PROVISION_JOB_NAMES.DEPROVISION, {
      deprovision: { serverId, unit, ...placement },
    });
  }
}
