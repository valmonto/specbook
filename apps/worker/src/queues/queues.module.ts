import { Module } from '@nestjs/common';
import { GithubAppModule, QueuesModule as SharedQueuesModule, SecretsModule, SshModule } from '@pkg/server';
import { ExampleProcessor } from './example/example.processor';
import { ExampleListener } from './example/example.listener';
import { NotificationRepository } from './example/notification.repository';
import { AgentSweepProcessor } from './agent-sweep/agent-sweep.processor';
import { AttachmentsSweepProcessor } from './attachments-sweep/attachments-sweep.processor';
import { GithubWebhookProcessor } from './github-webhook/github-webhook.processor';
import { ServerCheckProcessor } from './server-check/server-check.processor';
import { EnvironmentProvisionProcessor } from './environment-provision/environment-provision.processor';
import { DeploymentProcessor } from './deployment/deployment.processor';

/**
 * Worker queues module.
 * Imports shared queue configuration and registers processors.
 *
 * Add new processors here as you create them.
 */
@Module({
  imports: [SharedQueuesModule, GithubAppModule, SecretsModule, SshModule],
  providers: [
    // Register all processors
    ExampleProcessor,
    // Register event listeners
    ExampleListener,
    // Repositories
    NotificationRepository,
    // Storage GC
    AttachmentsSweepProcessor,

    AgentSweepProcessor,
    // GitHub webhook → live task PR/CI state
    GithubWebhookProcessor,
    // Server reachability + host-key pinning
    ServerCheckProcessor,
    // Data-plane provisioning (per-environment Postgres/Redis)
    EnvironmentProvisionProcessor,
    // Build + deploy runs (images over SSH, health-gated compose up)
    DeploymentProcessor,
  ],
})
export class WorkerQueuesModule {}
