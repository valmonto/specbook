import { pgTable, uuid, varchar, text, timestamp, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { TASK_AUTHOR_TYPES, TASK_COMMENT_KINDS } from '@pkg/contracts';
import { pk } from './helpers';
import { task } from './task';
import { user } from './user';

/**
 * The work log, typed: `progress` is agent narration mid-flight, `question`
 * pairs with the `blocked` status, `answer` unblocks it. Together with the
 * status_changed_* columns on task this is the audit trail — a three-round
 * review negotiation stays on the record.
 *
 * `author_type` distinguishes the human from an agent session even though
 * both resolve to a user id (MCP keys authenticate as their owning user).
 */
export const taskComment = pgTable(
  'task_comment',
  {
    id: pk(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => task.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    authorType: varchar('author_type', { length: 16 }).notNull().default('user'),
    kind: varchar('kind', { length: 16 }).notNull().default('comment'),
    body: text('body').notNull(),
    // kind 'note' only: when the claiming agent read it (get_notes stamps
    // this). Null on an unacked note — the needs_review gate keys off it.
    ackedAt: timestamp('acked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('task_comment_task_id_idx').on(table.taskId),
    check(
      'task_comment_kind_check',
      sql.raw(`kind IN (${TASK_COMMENT_KINDS.map((v) => `'${v}'`).join(', ')})`),
    ),
    check(
      'task_comment_author_type_check',
      sql.raw(`author_type IN (${TASK_AUTHOR_TYPES.map((v) => `'${v}'`).join(', ')})`),
    ),
  ],
);

export type TaskComment = typeof taskComment.$inferSelect;
export type NewTaskComment = typeof taskComment.$inferInsert;
