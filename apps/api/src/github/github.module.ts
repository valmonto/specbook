import { Module } from '@nestjs/common';
import { GithubAppService } from './github-app.service';
import { GithubWebhookController } from './github-webhook.controller';

@Module({
  // GithubWebhookProducer comes from the @Global QueuesModule.
  controllers: [GithubWebhookController],
  providers: [GithubAppService],
  exports: [GithubAppService],
})
export class GithubModule {}
