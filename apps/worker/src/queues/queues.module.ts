import { Module } from '@nestjs/common';
import { GithubAppModule, QueuesModule as SharedQueuesModule } from '@pkg/server';
import { ExampleProcessor } from './example/example.processor';
import { ExampleListener } from './example/example.listener';
import { NotificationRepository } from './example/notification.repository';
import { AttachmentsSweepProcessor } from './attachments-sweep/attachments-sweep.processor';
import { GithubWebhookProcessor } from './github-webhook/github-webhook.processor';

/**
 * Worker queues module.
 * Imports shared queue configuration and registers processors.
 *
 * Add new processors here as you create them.
 */
@Module({
  imports: [SharedQueuesModule, GithubAppModule],
  providers: [
    // Register all processors
    ExampleProcessor,
    // Register event listeners
    ExampleListener,
    // Repositories
    NotificationRepository,
    // Storage GC
    AttachmentsSweepProcessor,
    // GitHub webhook → live task PR/CI state
    GithubWebhookProcessor,
  ],
})
export class WorkerQueuesModule {}
