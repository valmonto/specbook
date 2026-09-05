import { pgTable, uuid, varchar, text, timestamp, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { DEPLOYMENT_PHASES, DEPLOYMENT_STATUSES, DEPLOYMENT_TRIGGERS } from '@pkg/contracts';
import { pk } from './helpers.js';
import { projectEnvironment } from './environment.js';
import { user } from './user.js';

/**
 * One build-and-deploy run of an environment. Rollback is just deploying an
 * older sha — images are retained on the servers, not here.
 */
export const deployment = pgTable(
  'deployment',
  {
    id: pk(),
    environmentId: uuid('environment_id')
      .notNull()
      .references(() => projectEnvironment.id, { onDelete: 'cascade' }),
    sha: varchar('sha', { length: 64 }).notNull(),
    /** Values from @pkg/contracts DEPLOYMENT_STATUSES. */
    status: varchar('status', { length: 16 }).notNull().default('queued'),
    /** 'manual' (a human clicked Deploy) or 'auto' (the merge webhook). */
    trigger: varchar('trigger', { length: 8 }).notNull().default('manual'),
    /**
     * Snapshot of the environment's domain at deploy time — what the running
     * stack actually serves, so the UI can tell a live domain from a pending
     * edit that only takes effect on the next deploy.
     */
    domain: varchar('domain', { length: 255 }),
    /** What the run is doing right now; status stays the coarse state. */
    phase: varchar('phase', { length: 16 }),
    /** Scrubbed remote output, tail-capped — see appendDeployLog. */
    log: text('log'),
    /** Failure detail — a k.* key or a scrubbed logs excerpt. */
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('deployment_environment_id_idx').on(table.environmentId, table.createdAt),
    check(
      'deployment_status_check',
      sql.raw(`status IN (${DEPLOYMENT_STATUSES.map((v) => `'${v}'`).join(', ')})`),
    ),
    check(
      'deployment_trigger_check',
      sql.raw(`trigger IN (${DEPLOYMENT_TRIGGERS.map((v) => `'${v}'`).join(', ')})`),
    ),
    check(
      'deployment_phase_check',
      sql.raw(`phase IS NULL OR phase IN (${DEPLOYMENT_PHASES.map((v) => `'${v}'`).join(', ')})`),
    ),
  ],
);

export type Deployment = typeof deployment.$inferSelect;
export type NewDeployment = typeof deployment.$inferInsert;
