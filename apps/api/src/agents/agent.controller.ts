import { Controller, Get } from '@nestjs/common';
import { ActiveUser, Permissions } from '@pkg/server';
import type { ActiveUser as ActiveUserType, ListAgentsResponse } from '@pkg/contracts';
import { AgentService } from './agent.service';

@Controller('agents')
export class AgentController {
  constructor(private readonly agentService: AgentService) {}

  /** The fleet strip: whoever can see the board can see who works it. */
  @Get()
  @Permissions('task:list')
  async list(@ActiveUser() activeUser: ActiveUserType): Promise<ListAgentsResponse> {
    return this.agentService.list(activeUser);
  }
}
