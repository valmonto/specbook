import { Module } from '@nestjs/common';
import { NotificationModule } from '../notifications/index.js';
import { GithubModule } from '../github/github.module.js';
import { OrgModule } from '../org/org.module.js';
import { ProjectController } from './project.controller.js';
import { ProjectRepository } from './project.repository.js';
import { ProjectMemberRepository } from './project-member.repository.js';
import { ProjectService } from './project.service.js';
import { TaskController } from './task.controller.js';
import { TaskRepository } from './task.repository.js';
import { TaskService } from './task.service.js';

@Module({
  imports: [NotificationModule, GithubModule, OrgModule],
  controllers: [ProjectController, TaskController],
  providers: [
    ProjectService,
    ProjectRepository,
    ProjectMemberRepository,
    TaskService,
    TaskRepository,
  ],
  // Exported for the MCP module: tools wrap the same services with actor
  // 'agent'. ProjectRepository is exported for the research module, which
  // validates a ticket-cut target project through the same org-scoped lookup.
  exports: [ProjectService, TaskService, TaskRepository, ProjectRepository],
})
export class TasksModule {}
