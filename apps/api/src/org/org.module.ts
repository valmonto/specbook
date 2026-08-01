import { Module } from '@nestjs/common';
import { OrgController } from './org.controller';
import { AdminOrgController } from './admin-org.controller';
import { OrgService } from './org.service';
import { OrgRepository } from './org.repository';
import { IamService } from '@pkg/server';
import { GithubModule } from '../github/github.module';

@Module({
  imports: [GithubModule],
  controllers: [OrgController, AdminOrgController],
  providers: [OrgService, OrgRepository, IamService],
  exports: [OrgService],
})
export class OrgModule {}
