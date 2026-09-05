import { Module } from '@nestjs/common';
import { OrgController } from './org.controller.js';
import { AdminOrgController } from './admin-org.controller.js';
import { OrgService } from './org.service.js';
import { OrgRepository } from './org.repository.js';
import { IamService } from '@pkg/server';
import { GithubModule } from '../github/github.module.js';

@Module({
  imports: [GithubModule],
  controllers: [OrgController, AdminOrgController],
  providers: [OrgService, OrgRepository, IamService],
  exports: [OrgService],
})
export class OrgModule {}
