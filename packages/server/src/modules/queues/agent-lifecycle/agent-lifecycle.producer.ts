import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import { AGENT_LIFECYCLE_QUEUE } from './agent-lifecycle.constants';

export interface AgentLifecycleJobPayload {
  agentId: string;
  action: 'start' | 'stop';
}

@Injectable()
export class AgentLifecycleProducer {
  constructor(@InjectQueue(AGENT_LIFECYCLE_QUEUE.name) private readonly queue: Queue) {}

  async enqueue(payload: AgentLifecycleJobPayload): Promise<void> {
    await this.queue.add(`${payload.action}-${payload.agentId}`, payload);
  }
}
