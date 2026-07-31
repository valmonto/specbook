import { pgTable, varchar, timestamp, uuid } from 'drizzle-orm/pg-core';
import { pk } from './helpers';
import { organization } from './organization';
import { user } from './user';

/**
 * Machine API keys for the MCP endpoint. The plaintext is shown once at
 * creation; only its sha256 hex lives here, with `prefix` kept so a key can be
 * recognised in a list. `scopes` is the exposure choice made at creation —
 * which MCP tools this key can see — validated against MCP_SCOPES in
 * @pkg/contracts (varchar array, not pgEnum, per this package's rules).
 *
 * `orgId` binds the key to the organization it was minted in: org-scoped MCP
 * tools (tasks) act as the owning user inside that org. Nullable because
 * platform-scope keys (orgs:read, platform:read) need no tenant; an unbound
 * key simply never sees org-scoped tools.
 */
export const apiKey = pgTable('api_key', {
  id: pk(),
  name: varchar('name', { length: 64 }).notNull(),
  prefix: varchar('prefix', { length: 16 }).notNull(),
  hashedKey: varchar('hashed_key', { length: 64 }).notNull().unique(),
  scopes: varchar('scopes', { length: 32 }).array().notNull(),
  userId: uuid('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').references(() => organization.id, { onDelete: 'cascade' }),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type ApiKeyRow = typeof apiKey.$inferSelect;
export type NewApiKeyRow = typeof apiKey.$inferInsert;
