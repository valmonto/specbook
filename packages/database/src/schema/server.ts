import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  integer,
  jsonb,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { SERVER_STATUSES } from '@pkg/contracts';
import { pk } from './helpers';
import { organization } from './organization';
import { user } from './user';

/**
 * An org's machine for the deploy platform (agentless — targets need only
 * sshd + docker). Specbook GENERATES the keypair: the public half installs
 * into authorized_keys, the private half is sealed with APP_ENCRYPTION_KEY
 * and is write-only by construction — no API surface ever returns it.
 */
export const server = pgTable(
  'server',
  {
    id: pk(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    host: varchar('host', { length: 255 }).notNull(),
    port: integer('port').notNull().default(22),
    sshUser: varchar('ssh_user', { length: 64 }).notNull().default('deploy'),
    /** ['build','app','data'] — values from @pkg/contracts SERVER_ROLES. */
    roles: jsonb('roles').notNull(),
    publicKey: text('public_key').notNull(),
    /** Sealed (SecretsService v1 format). Never serialized outward. */
    privateKeyEnc: text('private_key_enc').notNull(),
    /** SHA256 host-key fingerprint, pinned on first successful connect. */
    hostFingerprint: varchar('host_fingerprint', { length: 128 }),
    status: varchar('status', { length: 32 }).notNull().default('unverified'),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
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
    index('server_org_id_idx').on(table.orgId),
    uniqueIndex('server_org_name_uq').on(table.orgId, sql`lower(name)`),
    check(
      'server_status_check',
      sql.raw(`status IN (${SERVER_STATUSES.map((v) => `'${v}'`).join(', ')})`),
    ),
  ],
);

export type Server = typeof server.$inferSelect;
export type NewServer = typeof server.$inferInsert;
