import { Module } from '@nestjs/common';
import { GithubAppModule } from '@pkg/server';
import { GithubWebhookController } from './github-webhook.controller.js';

@Module({
  // GithubWebhookProducer comes from the @Global QueuesModule; the GitHub
  // App seam itself lives in @pkg/server (shared with the worker).
  imports: [GithubAppModule],
  controllers: [GithubWebhookController],
  exports: [GithubAppModule],
})
export class GithubModule {}
