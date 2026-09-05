import type { McpAccessMode } from '@pkg/contracts';

/** The grant columns as stored (rows predating the columns read as 'none'). */
export interface StoredMcpAccess {
  mcpAccess?: string | null;
  mcpAccessUntil?: Date | null;
  mcpAccessBy?: string | null;
  mcpAccessReason?: string | null;
}

export interface EffectiveMcpAccess {
  mode: McpAccessMode;
  until: Date | null;
  by: string | null;
  reason: string | null;
}

/**
 * The grant AS IT STANDS at `now`. Expiry is a property of the clock, not of
 * a column somebody remembered to clear: a window whose `until` has passed
 * (or a mode with no `until` at all) IS 'none', with every companion field
 * null — so a lapsed grant is indistinguishable from one never opened, in
 * every reader (the executor, the API shape, the UI).
 */
export function effectiveMcpAccess(row: StoredMcpAccess, now: Date): EffectiveMcpAccess {
  const mode = row.mcpAccess === 'read' || row.mcpAccess === 'write' ? row.mcpAccess : 'none';
  const until = row.mcpAccessUntil ?? null;
  if (mode === 'none' || !until || until.getTime() <= now.getTime()) {
    return { mode: 'none', until: null, by: null, reason: null };
  }
  return { mode, until, by: row.mcpAccessBy ?? null, reason: row.mcpAccessReason ?? null };
}
