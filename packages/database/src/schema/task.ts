import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  jsonb,
  timestamp,
  index,
  check,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { TASK_STATUSES } from '@pkg/contracts';
import { pk } from './helpers';
import { project } from './project';
import { user } from './user';

export interface AcceptanceCriterion {
  text: string;
  done: boolean;
}

/**
 * The unit of agent work, calibrated to one session / one PR.
 *
 * Acceptance criteria replace subtasks: below the unit-of-work, granularity
 * is a checklist the agent ticks — "all boxes ticked" is a machine-checkable
 * definition of done. `claimed_*` makes ready→in_progress an atomic claim
 * and stale claims visible; `branch`/`pr_url` are required at review time so
 * review is "open task → click PR → check criteria", not comment-grepping.
 */
export const task = pgTable(
  'task',
  {
    id: pk(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'cascade' }),
    title: varchar('title', { length: 500 }).notNull(),
    context: text('context'),
    outOfScope: text('out_of_scope'),
    acceptanceCriteria: jsonb('acceptance_criteria')
      .$type<AcceptanceCriterion[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    // varchar + CHECK, not pgEnum — see user.ts. Value set from @pkg/contracts.
    status: varchar('status', { length: 32 }).notNull().default('draft'),
    priority: integer('priority').notNull().default(0),
    claimedBy: uuid('claimed_by').references(() => user.id, { onDelete: 'set null' }),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    branch: varchar('branch', { length: 255 }),
    prUrl: varchar('pr_url', { length: 500 }),
    statusChangedBy: uuid('status_changed_by').references(() => user.id, { onDelete: 'set null' }),
    statusChangedAt: timestamp('status_changed_at', { withTimezone: true }),
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
    index('task_project_id_idx').on(table.projectId),
    // The queue query: ready tasks by priority within a project.
    index('task_project_status_idx').on(table.projectId, table.status, table.priority),
    check(
      'task_status_check',
      sql.raw(`status IN (${TASK_STATUSES.map((v) => `'${v}'`).join(', ')})`),
    ),
  ],
);

/**
 * The autonomy engine: the agent queue is "ready AND no unfinished
 * dependencies" — sequencing the human draws as arrows, not nesting.
 */
export const taskDependency = pgTable(
  'task_dependency',
  {
    taskId: uuid('task_id')
      .notNull()
      .references(() => task.id, { onDelete: 'cascade' }),
    dependsOnTaskId: uuid('depends_on_task_id')
      .notNull()
      .references(() => task.id, { onDelete: 'cascade' }),
  },
  (table) => [
    primaryKey({ columns: [table.taskId, table.dependsOnTaskId] }),
    index('task_dependency_depends_on_idx').on(table.dependsOnTaskId),
    check('task_dependency_no_self_check', sql.raw('task_id <> depends_on_task_id')),
  ],
);

export type Task = typeof task.$inferSelect;
export type NewTask = typeof task.$inferInsert;
export type TaskDependency = typeof taskDependency.$inferSelect;
