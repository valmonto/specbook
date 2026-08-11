import { pgTable, uuid, varchar, text, integer, timestamp, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { RESEARCH_STATUSES, TASK_AUTHOR_TYPES } from '@pkg/contracts';
import { pk } from './helpers';
import { organization } from './organization';
import { project } from './project';
import { user } from './user';

/**
 * A first-class, durable, versioned research document produced through an
 * async agent conversation. Loosely associated with a project (null = an
 * org-level document); the natural output of an accepted document is a set of
 * DRAFT tasks "cut" from it, each carrying `source_research_id` lineage.
 *
 * Unlike a task, its evidence of "done" is the document itself: `body_markdown`
 * is the deliverable, `version` bumps each time the agent publishes a new
 * draft, and `status` (varchar + CHECK, value set from @pkg/contracts) is the
 * researching → needs_review → accepted lifecycle.
 */
export const research = pgTable(
  'research',
  {
    id: pk(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    // The associated project (ticket-cut target defaults here). Nullable —
    // an org-level document has none; set null on project delete keeps history.
    projectId: uuid('project_id').references(() => project.id, { onDelete: 'set null' }),
    title: varchar('title', { length: 500 }).notNull(),
    // varchar + CHECK, not pgEnum — value set from @pkg/contracts.
    status: varchar('status', { length: 32 }).notNull().default('researching'),
    // The living document — empty until the first agent draft lands.
    bodyMarkdown: text('body_markdown'),
    version: integer('version').notNull().default(0),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index('research_project_id_idx').on(table.projectId),
    // The keyset listing order: (updated_at desc, id) — a covering index so
    // infinite scroll is a range scan, not a sort.
    index('research_org_updated_idx').on(table.orgId, table.updatedAt.desc(), table.id),
    check(
      'research_status_check',
      sql.raw(`status IN (${RESEARCH_STATUSES.map((v) => `'${v}'`).join(', ')})`),
    ),
  ],
);

/**
 * One turn in a research conversation. `author_type` distinguishes the human
 * from an agent session even though both resolve to a user id (MCP keys
 * authenticate as their owning user), reusing TASK_AUTHOR_TYPES. `org_id` is
 * denormalized so every message read/write is org-scoped without a join.
 */
export const researchMessage = pgTable(
  'research_message',
  {
    id: pk(),
    researchId: uuid('research_id')
      .notNull()
      .references(() => research.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    authorType: varchar('author_type', { length: 16 }).notNull().default('user'),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Chronological keyset paging within a document (id is uuidv7 = time-sorted).
    index('research_message_research_id_idx').on(table.researchId, table.id),
    check(
      'research_message_author_type_check',
      sql.raw(`author_type IN (${TASK_AUTHOR_TYPES.map((v) => `'${v}'`).join(', ')})`),
    ),
  ],
);

export type Research = typeof research.$inferSelect;
export type NewResearch = typeof research.$inferInsert;
export type ResearchMessage = typeof researchMessage.$inferSelect;
export type NewResearchMessage = typeof researchMessage.$inferInsert;
