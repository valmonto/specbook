import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  integer,
  index,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { DATA_ACCESS_OUTCOMES, DATA_PLANE_RESOURCES } from '@pkg/contracts';
import { pk } from './helpers.js';
import { apiKey } from './api-key.js';
import { organization } from './organization.js';
import { projectEnvironment } from './environment.js';
import { task } from './task.js';
import { user } from './user.js';

/**
 * The audit trail of agent access to APPLICATION data: one row per executor
 * call (allowed, denied or failed) and per human grant/revoke. It must answer
 * "who read what, where, when" AFTER the grant lapsed and even after the
 * environment is gone — so the environment link is SET NULL and the project /
 * environment names are snapshotted; the same for the key and the task.
 * Append-only by convention: nothing updates or deletes these rows.
 */
export const dataAccessAudit = pgTable(
  'data_access_audit',
  {
    id: pk(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    environmentId: uuid('environment_id').references(() => projectEnvironment.id, {
      onDelete: 'set null',
    }),
    projectName: varchar('project_name', { length: 255 }).notNull(),
    environmentName: varchar('environment_name', { length: 32 }).notNull(),
    /** The calling MCP key — the agent's identity; null on human grant/revoke rows. */
    apiKeyId: uuid('api_key_id').references(() => apiKey.id, { onDelete: 'set null' }),
    agentName: varchar('agent_name', { length: 64 }),
    /** The human behind a grant/revoke; null on agent calls. */
    userId: uuid('user_id').references(() => user.id, { onDelete: 'set null' }),
    userName: varchar('user_name', { length: 255 }),
    taskId: uuid('task_id').references(() => task.id, { onDelete: 'set null' }),
    /** 'database' | 'cache' | 'storage' for executor calls, 'grant' for the human door. */
    resource: varchar('resource', { length: 16 }).notNull(),
    /** e.g. 'sql', 'get', 'scan', 'list', 'head', 'grant', 'revoke'. */
    operation: varchar('operation', { length: 32 }).notNull(),
    /** What was addressed: the statement, the key/pattern, the object key, the window. */
    target: text('target'),
    /** Values from @pkg/contracts DATA_ACCESS_OUTCOMES. */
    outcome: varchar('outcome', { length: 16 }).notNull(),
    /** A k.* denial key or a scrubbed error excerpt. */
    detail: text('detail'),
    durationMs: integer('duration_ms'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('data_access_audit_environment_idx').on(table.environmentId, table.createdAt),
    index('data_access_audit_org_idx').on(table.orgId, table.createdAt),
    check(
      'data_access_audit_resource_check',
      sql.raw(
        `resource IN (${[...DATA_PLANE_RESOURCES, 'grant'].map((v) => `'${v}'`).join(', ')})`,
      ),
    ),
    check(
      'data_access_audit_outcome_check',
      sql.raw(`outcome IN (${DATA_ACCESS_OUTCOMES.map((v) => `'${v}'`).join(', ')})`),
    ),
  ],
);

export type DataAccessAuditRow = typeof dataAccessAudit.$inferSelect;
export type NewDataAccessAuditRow = typeof dataAccessAudit.$inferInsert;
