import { Module } from '@nestjs/common';
import { AgentController } from './agent.controller';
import { AgentRepository } from './agent.repository';
import { AgentService } from './agent.service';

/**
 * Agents — the workers of the loop, presence-tracked by API-key identity.
 * Rows are created and stamped from the MCP surface (heartbeat + implicit
 * stamping); this module's HTTP side is read-only.
 */
@Module({
  controllers: [AgentController],
  providers: [AgentService, AgentRepository],
  exports: [AgentService],
})
export class AgentModule {}
