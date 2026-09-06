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
import { SERVER_MODES, SERVER_STATUSES } from '@pkg/contracts';
import { pk } from './helpers.js';
import { organization } from './organization.js';
import { user } from './user.js';

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
    /**
     * How specbook reaches this box — @pkg/contracts SERVER_MODES. Defaults to
     * 'specbook' so every pre-existing row keeps its exact meaning.
     */
    mode: varchar('mode', { length: 16 }).notNull().default('specbook'),
    /**
     * Where the server is. For a 'specbook' server that is its SSH endpoint;
     * for an 'external' one there is no SSH, so it is the address and port
     * APPLICATIONS connect to (e.g. a Postgres published on a non-default
     * port). One field, because an external server has only one address that
     * specbook cares about.
     */
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
    /**
     * Sealed JSON of the shared data-plane's root credentials on this box
     * (generated at first provision). Write-only like every sealed column.
     */
    dataRootEnvEnc: text('data_root_env_enc'),
    /**
     * EXTERNAL servers only — the role specbook authenticates as to provision
     * tenants (CREATEDB + CREATEROLE; never a superuser). Its password is
     * sealed like every other credential and never serialized outward.
     */
    adminUser: varchar('admin_user', { length: 64 }),
    adminSecretEnc: text('admin_secret_enc'),
    /**
     * PEM of the CA that signed the server's certificate, so connections can
     * use sslmode=verify-full. A certificate is PUBLIC by design — it is
     * stored and returned in the clear, unlike everything above it. The CA's
     * private key never enters specbook.
     */
    caCert: text('ca_cert'),
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
    check('server_mode_check', sql.raw(`mode IN (${SERVER_MODES.map((v) => `'${v}'`).join(', ')})`)),
    // An external server is useless without the credential it authenticates
    // with, and a managed one must never carry one. Enforced here rather than
    // only in the service, so no code path can write a half-configured row.
    check(
      'server_external_credential_check',
      sql.raw(
        `(mode = 'external' AND admin_user IS NOT NULL AND admin_secret_enc IS NOT NULL) OR ` +
          `(mode <> 'external' AND admin_user IS NULL AND admin_secret_enc IS NULL)`,
      ),
    ),
  ],
);

export type Server = typeof server.$inferSelect;
export type NewServer = typeof server.$inferInsert;
