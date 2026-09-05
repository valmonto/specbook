import { Module } from '@nestjs/common';
import { AgentModule } from '../agents/index.js';
import { ApiKeyModule } from '../api-key/index.js';
import { EnvironmentModule } from '../environments/index.js';
import { GithubModule } from '../github/github.module.js';
import { OrgModule } from '../org/org.module.js';
import { TasksModule } from '../tasks/index.js';
import { ResearchModule } from '../research/index.js';
import { McpController } from './mcp.controller.js';
import { McpServerFactory } from './mcp-server.factory.js';
import { McpTools } from './mcp-tools.js';

@Module({
  imports: [
    ApiKeyModule,
    GithubModule,
    OrgModule,
    TasksModule,
    ResearchModule,
    AgentModule,
    EnvironmentModule,
  ],
  controllers: [McpController],
  providers: [McpServerFactory, McpTools],
})
export class McpModule {}
