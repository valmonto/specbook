import { Module } from '@nestjs/common';
import { SecretsModule } from '@pkg/server';
import { ApiKeyModule } from '../api-key/api-key.module.js';
import { AgentController } from './agent.controller.js';
import { AgentRepository } from './agent.repository.js';
import { AgentService } from './agent.service.js';

/**
 * Agents — the workers of the loop, presence-tracked by API-key identity.
 * External agents appear by calling MCP; managed agents are created here
 * (their key minted and sealed) and launched/stopped through the worker.
 */
@Module({
  imports: [ApiKeyModule, SecretsModule],
  controllers: [AgentController],
  providers: [AgentService, AgentRepository],
  exports: [AgentService],
})
export class AgentModule {}
