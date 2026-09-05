import { Controller, Get, Post } from '@nestjs/common';
import { ActiveUser, Permissions, ZodRequest } from '@pkg/server';
import {
  AgentActionRequestSchema,
  CreateManagedAgentRequestSchema,
  type ActiveUser as ActiveUserType,
  type AgentActionRequest,
  type AgentActionResponse,
  type CreateManagedAgentRequest,
  type CreateManagedAgentResponse,
  type ListAgentsResponse,
} from '@pkg/contracts';
import { AgentService } from './agent.service.js';

@Controller('agents')
export class AgentController {
  constructor(private readonly agentService: AgentService) {}

  /** The fleet strip: whoever can see the board can see who works it. */
  @Get()
  @Permissions('task:list')
  async list(@ActiveUser() activeUser: ActiveUserType): Promise<ListAgentsResponse> {
    return this.agentService.list(activeUser);
  }

  /** Managed lifecycle is infrastructure territory, like servers. */
  @Post('managed')
  @Permissions('settings:update')
  async createManaged(
    @ZodRequest(CreateManagedAgentRequestSchema) dto: CreateManagedAgentRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<CreateManagedAgentResponse> {
    return this.agentService.createManaged(activeUser, dto);
  }

  @Post(':id/start')
  @Permissions('settings:update')
  async start(
    @ZodRequest(AgentActionRequestSchema) dto: AgentActionRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<AgentActionResponse> {
    return this.agentService.start(activeUser, dto);
  }

  @Post(':id/stop')
  @Permissions('settings:update')
  async stop(
    @ZodRequest(AgentActionRequestSchema) dto: AgentActionRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<AgentActionResponse> {
    return this.agentService.stop(activeUser, dto);
  }
}
