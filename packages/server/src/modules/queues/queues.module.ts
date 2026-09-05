import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DEFAULT_JOB_OPTIONS } from './queues.config.js';
import { EXAMPLE_QUEUE, ExampleProducer } from './example/index.js';
import { AGENT_LIFECYCLE_QUEUE, AgentLifecycleProducer } from './agent-lifecycle/index.js';
import { AGENT_SWEEP_QUEUE } from './agent-sweep/index.js';
import { ATTACHMENTS_SWEEP_QUEUE } from './attachments-sweep/index.js';
import { GITHUB_WEBHOOK_QUEUE, GithubWebhookProducer } from './github-webhook/index.js';
import { SERVER_CHECK_QUEUE, ServerCheckProducer } from './server-check/index.js';
import {
  ENVIRONMENT_PROVISION_QUEUE,
  EnvironmentProvisionProducer,
} from './environment-provision/index.js';
import { DEPLOYMENT_QUEUE, DeploymentProducer } from './deployment/index.js';

/**
 * Shared queues module.
 * Registers BullMQ with Redis connection and all queue producers.
 *
 * Import this module in your API app to enqueue jobs.
 *
 * @example
 * ```typescript
 * // apps/api/src/app.module.ts
 * @Module({
 *   imports: [QueuesModule],
 * })
 * export class AppModule {}
 * ```
 */
@Global()
@Module({
  imports: [
    // Register BullMQ with Redis connection
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get<string>('REDIS_HOST', 'localhost'),
          port: config.get<number>('REDIS_PORT', 6379),
          password: config.get<string>('REDIS_PASSWORD'),
          maxRetriesPerRequest: null,
        },
        defaultJobOptions: DEFAULT_JOB_OPTIONS,
      }),
    }),

    // Register queues
    BullModule.registerQueue({ name: EXAMPLE_QUEUE.name }),
    BullModule.registerQueue({ name: ATTACHMENTS_SWEEP_QUEUE.name }),
    BullModule.registerQueue({ name: AGENT_SWEEP_QUEUE.name }),
    BullModule.registerQueue({ name: AGENT_LIFECYCLE_QUEUE.name }),
    BullModule.registerQueue({ name: GITHUB_WEBHOOK_QUEUE.name }),
    BullModule.registerQueue({ name: SERVER_CHECK_QUEUE.name }),
    BullModule.registerQueue({ name: ENVIRONMENT_PROVISION_QUEUE.name }),
    BullModule.registerQueue({ name: DEPLOYMENT_QUEUE.name }),
  ],
  providers: [ExampleProducer, GithubWebhookProducer, ServerCheckProducer, EnvironmentProvisionProducer, DeploymentProducer, AgentLifecycleProducer],
  exports: [
    BullModule,
    ExampleProducer,
    AgentLifecycleProducer,
    GithubWebhookProducer,
    ServerCheckProducer,
    EnvironmentProvisionProducer,
    DeploymentProducer,
  ],
})
export class QueuesModule {}
