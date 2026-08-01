import { Module } from '@nestjs/common';
import { GithubAppService } from './github-app.service';

@Module({
  providers: [GithubAppService],
  exports: [GithubAppService],
})
export class GithubModule {}
