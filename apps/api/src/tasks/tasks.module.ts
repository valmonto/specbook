import { Module } from '@nestjs/common';
import { NotificationModule } from '../notifications';
import { GithubModule } from '../github/github.module';
import { OrgModule } from '../org/org.module';
import { ProjectController } from './project.controller';
import { ProjectRepository } from './project.repository';
import { ProjectService } from './project.service';
import { TaskController } from './task.controller';
import { TaskRepository } from './task.repository';
import { TaskService } from './task.service';

@Module({
  imports: [NotificationModule, GithubModule, OrgModule],
  controllers: [ProjectController, TaskController],
  providers: [ProjectService, ProjectRepository, TaskService, TaskRepository],
  // Exported for the MCP module: tools wrap the same services with actor 'agent'.
  exports: [ProjectService, TaskService, TaskRepository],
})
export class TasksModule {}
