import { pgTable, uuid, varchar, text, timestamp, check, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { AGENT_KINDS, AGENT_STATUSES } from '@pkg/contracts';
import { pk } from './helpers.js';
import { apiKey } from './api-key.js';
import { organization } from './organization.js';
import { server } from './server.js';
import { task } from './task.js';

/**
 * An agent is a WORKER — distinct from server (a machine). Identity is the
 * API key it calls with (unique: one agent per credential). server_id is
 * NULLABLE on purpose: null = external agent an operator runs themselves;
 * set = managed agent specbook launched there (lifecycle in a later slice).
 */
export const agent = pgTable(
  'agent',
  {
    id: pk(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 64 }).notNull(),
    apiKeyId: uuid('api_key_id')
      .notNull()
      .references(() => apiKey.id, { onDelete: 'cascade' }),
    serverId: uuid('server_id').references(() => server.id, { onDelete: 'set null' }),
    /** Values from @pkg/contracts AGENT_KINDS. */
    kind: varchar('kind', { length: 16 }).notNull().default('external'),
    /** Values from @pkg/contracts AGENT_STATUSES; presence reads derive offline from last_seen_at. */
    status: varchar('status', { length: 16 }).notNull().default('offline'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    currentTaskId: uuid('current_task_id').references(() => task.id, { onDelete: 'set null' }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    /** Managed agents: scrubbed, tail-capped tmux capture (write-boundary rule). */
    log: text('log'),
    /** Managed agents: the sealed MCP key materialized onto the box at start. Write-only. */
    mcpKeyEnc: text('mcp_key_enc'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('agent_api_key_id_uq').on(table.apiKeyId),
    uniqueIndex('agent_org_name_uq').on(table.orgId, table.name),
    check('agent_kind_check', sql.raw(`kind IN (${AGENT_KINDS.map((v) => `'${v}'`).join(', ')})`)),
    check(
      'agent_status_check',
      sql.raw(`status IN (${AGENT_STATUSES.map((v) => `'${v}'`).join(', ')})`),
    ),
  ],
);

export type AgentRow = typeof agent.$inferSelect;
export type NewAgentRow = typeof agent.$inferInsert;
