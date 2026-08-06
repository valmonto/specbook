/**
 * Agents — the WORKERS of the loop, distinct from servers (the machines).
 * An agent's identity is its API key; not every agent is specbook-launched.
 */

/** external = operator-run (e.g. their own Claude Code session); managed = specbook-launched on a server. */
export const AGENT_KINDS = ['external', 'managed'] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

/**
 * offline | idle | working are presence states every agent has; the rest are
 * lifecycle states reserved for MANAGED agents (the launch slice) so the
 * value set never needs a second migration.
 */
export const AGENT_STATUSES = [
  'offline',
  'idle',
  'working',
  'stopped',
  'starting',
  'auth_needed',
  'error',
] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

/** Silence longer than this reads as offline on every presence surface. */
export const AGENT_OFFLINE_AFTER_MS = 10 * 60 * 1000;

/**
 * An in_progress claim whose agent has been silent this long returns to
 * ready (never touching blocked — silence there is expected).
 */
export const STALE_CLAIM_AFTER_MS = 30 * 60 * 1000;
