import { z } from 'zod';
import { AGENT_KINDS, AGENT_STATUSES } from '../constants/agent';

/**
 * The public agent shape: presence and identity, never credentials — the
 * API key behind an agent is not part of any response.
 */
export const AgentSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  kind: z.enum(AGENT_KINDS),
  /**
   * Presence-resolved state: stored lifecycle overridden to 'offline' when
   * last_seen_at is older than AGENT_OFFLINE_AFTER_MS.
   */
  status: z.enum(AGENT_STATUSES),
  serverId: z.string().uuid().nullable(),
  serverName: z.string().nullable(),
  currentTaskId: z.string().uuid().nullable(),
  currentTaskTitle: z.string().nullable(),
  lastSeenAt: z.string().nullable(),
  startedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type Agent = z.infer<typeof AgentSchema>;

export const ListAgentsRequestSchema = z.object({}).strict();
export type ListAgentsRequest = z.infer<typeof ListAgentsRequestSchema>;
export const ListAgentsResponseSchema = z.object({ data: z.array(AgentSchema) });
export type ListAgentsResponse = z.infer<typeof ListAgentsResponseSchema>;
