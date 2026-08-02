import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  index,
  uniqueIndex,
  bigint,
  integer,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { PROJECT_MODES } from '@pkg/contracts';
import { pk } from './helpers';
import { organization } from './organization';
import { user } from './user';

/**
 * A project is the container AND the brain: `context` is the product's
 * constitution (what it is, stack, conventions, boundaries) that an agent
 * reads once at session start. The repo pointer is what lets a cold session
 * start work without being told where the code lives.
 */
export const project = pgTable(
  'project',
  {
    id: pk(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    context: text('context'),
    repoUrl: varchar('repo_url', { length: 500 }),
    // Set when the repo came from the org's GitHub installation — the hook
    // later tickets use to restrict minted tokens to exactly this repository.
    githubRepoId: bigint('github_repo_id', { mode: 'number' }),
    githubRepoFullName: varchar('github_repo_full_name', { length: 255 }),
    defaultBranch: varchar('default_branch', { length: 255 }).notNull().default('main'),
    // Checkout path on the machine agents run on — not meaningful to the web UI.
    workdir: varchar('workdir', { length: 500 }),
    // The automation trust dial (varchar + CHECK; value set from @pkg/contracts).
    mode: varchar('mode', { length: 16 }).notNull().default('manual'),
    // Per-project claim cap for the agent queue; null = no project cap.
    maxParallel: integer('max_parallel'),
    // Circuit breaker: set while the default branch is red; auto modes hold.
    autoPausedAt: timestamp('auto_paused_at', { withTimezone: true }),
    // Archived projects keep their history but leave every active surface:
    // lists, dispatch, auto-progression. Archiving also frees the name.
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index('project_org_id_idx').on(table.orgId),
    // Names are unique per org among LIVE projects only (case-insensitive) —
    // archiving frees the name for reuse.
    uniqueIndex('project_org_name_active_uq')
      .on(table.orgId, sql`lower(name)`)
      .where(sql`archived_at IS NULL`),
    check(
      'project_mode_check',
      sql.raw(`mode IN (${PROJECT_MODES.map((v) => `'${v}'`).join(', ')})`),
    ),
    check(
      'project_max_parallel_check',
      sql.raw('max_parallel IS NULL OR (max_parallel BETWEEN 1 AND 10)'),
    ),
  ],
);

export type Project = typeof project.$inferSelect;
export type NewProject = typeof project.$inferInsert;
