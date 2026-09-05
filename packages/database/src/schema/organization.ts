import { pgTable, uuid, varchar, timestamp, index, bigint } from 'drizzle-orm/pg-core';
import { pk } from './helpers.js';
import { user } from './user.js';

export const organization = pgTable(
  'organization',
  {
    id: pk(),
    name: varchar('name', { length: 255 }).notNull(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    // GitHub App connection — one installation per org (the v2 scope guard).
    // The id is the tenancy boundary, not a secret; the App private key never
    // touches the database.
    githubInstallationId: bigint('github_installation_id', { mode: 'number' }),
    githubAccountLogin: varchar('github_account_login', { length: 255 }),
    githubConnectedAt: timestamp('github_connected_at', { withTimezone: true }),
    // owner/repo new projects are generated from — org-scoped because the
    // template must live in THIS org's installation grant. Null = no template
    // chosen; picking one is a conscious act in the settings card.
    githubTemplateRepo: varchar('github_template_repo', { length: 255 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [index('organization_owner_id_idx').on(table.ownerId)],
);

export type Organization = typeof organization.$inferSelect;
export type NewOrganization = typeof organization.$inferInsert;
