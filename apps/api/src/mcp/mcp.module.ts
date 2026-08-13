import { Module } from '@nestjs/common';
import { AgentModule } from '../agents';
import { ApiKeyModule } from '../api-key';
import { EnvironmentModule } from '../environments';
import { GithubModule } from '../github/github.module';
import { OrgModule } from '../org/org.module';
import { TasksModule } from '../tasks';
import { ResearchModule } from '../research';
import { McpController } from './mcp.controller';
import { McpServerFactory } from './mcp-server.factory';
import { McpTools } from './mcp-tools';

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
