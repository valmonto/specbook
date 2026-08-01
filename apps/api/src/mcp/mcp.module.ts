import { Module } from '@nestjs/common';
import { ApiKeyModule } from '../api-key';
import { GithubModule } from '../github/github.module';
import { OrgModule } from '../org/org.module';
import { TasksModule } from '../tasks';
import { McpController } from './mcp.controller';
import { McpServerFactory } from './mcp-server.factory';
import { McpTools } from './mcp-tools';

@Module({
  imports: [ApiKeyModule, GithubModule, OrgModule, TasksModule],
  controllers: [McpController],
  providers: [McpServerFactory, McpTools],
})
export class McpModule {}
