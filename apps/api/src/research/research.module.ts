import { Module } from '@nestjs/common';
import { QueuesModule } from '@pkg/server';
import { TasksModule } from '../tasks';
import { ResearchController } from './research.controller';
import { ResearchRepository } from './research.repository';
import { ResearchService } from './research.service';

/**
 * Research module. Imports TasksModule for the org-scoped ProjectRepository
 * (ticket-cut target validation) and TaskRepository (creating the draft
 * tasks), and QueuesModule for the agent-turn enqueue.
 */
@Module({
  imports: [QueuesModule, TasksModule],
  controllers: [ResearchController],
  providers: [ResearchService, ResearchRepository],
  // Exported for the MCP module: research tools wrap the same service.
  exports: [ResearchService, ResearchRepository],
})
export class ResearchModule {}
