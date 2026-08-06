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
  /** Managed agents: scrubbed tmux capture tail. Null for external agents. */
  log: z.string().nullable(),
  createdAt: z.string(),
});
export type Agent = z.infer<typeof AgentSchema>;

/** Managed-agent names become tmux session + directory names on the box. */
export const AGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,46}$/;

// --- Create a managed agent (server must hold the runner role) ---
export const CreateManagedAgentRequestSchema = z
  .object({
    serverId: z.string().uuid(),
    name: z.string().regex(AGENT_NAME_PATTERN),
    /** A server already hosting a managed agent needs an explicit confirm. */
    confirmAdditional: z.boolean().optional(),
  })
  .strict();
export const CreateManagedAgentResponseSchema = AgentSchema;
export type CreateManagedAgentRequest = z.infer<typeof CreateManagedAgentRequestSchema>;
export type CreateManagedAgentResponse = z.infer<typeof CreateManagedAgentResponseSchema>;

// --- Start / stop a managed agent ---
export const AgentActionRequestSchema = z.object({ id: z.string().uuid() }).strict();
export const AgentActionResponseSchema = AgentSchema;
export type AgentActionRequest = z.infer<typeof AgentActionRequestSchema>;
export type AgentActionResponse = z.infer<typeof AgentActionResponseSchema>;

export const ListAgentsRequestSchema = z.object({}).strict();
export type ListAgentsRequest = z.infer<typeof ListAgentsRequestSchema>;
export const ListAgentsResponseSchema = z.object({ data: z.array(AgentSchema) });
export type ListAgentsResponse = z.infer<typeof ListAgentsResponseSchema>;
