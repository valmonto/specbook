import { pgTable, uuid, varchar, text, timestamp, index } from 'drizzle-orm/pg-core';
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
    defaultBranch: varchar('default_branch', { length: 255 }).notNull().default('main'),
    // Checkout path on the machine agents run on — not meaningful to the web UI.
    workdir: varchar('workdir', { length: 500 }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [index('project_org_id_idx').on(table.orgId)],
);

export type Project = typeof project.$inferSelect;
export type NewProject = typeof project.$inferInsert;
