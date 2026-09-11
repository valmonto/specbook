import {
  boolean,
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
    /**
     * Something in front of this box already terminates TLS for its domains —
     * a hypervisor that owns :80/:443, a load balancer, a CDN origin. When set,
     * specbook's Caddy on this server serves the app over PLAIN HTTP and never
     * requests a certificate.
     *
     * Without it the two layers fight: the front redirects to HTTPS, specbook's
     * Caddy redirects to HTTPS again, and the ACME challenge that would end the
     * argument is itself redirected — so no certificate is ever issued and the
     * deploy fails as a health-check timeout with nothing naming the cause.
     */
    tlsTerminatedUpstream: boolean('tls_terminated_upstream').notNull().default(false),
    status: varchar('status', { length: 32 }).notNull().default('unverified'),
    /**
     * Why the last check failed, in the words of whatever refused us — an SSH
     * refusal, a TLS rejection, `permission denied for database "postgres"`.
     * Cleared on success. Without it "Unreachable" sends someone to the worker
     * logs to read a reason the check already had in hand.
     */
    lastCheckError: text('last_check_error'),
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
    // A runner hosts the agent CLI with permission prompts skipped, so it must
    // not share a box with anything specbook places. This is the same argument
    // as the credential check above — enforced in the database so no code path
    // can write the row, because here the consequence is an unattended agent
    // sitting next to production containers rather than a failed provision.
    check(
      'server_runner_exclusive_check',
      sql.raw(`NOT (roles @> '["runner"]'::jsonb) OR jsonb_array_length(roles) = 1`),
    ),
  ],
);

export type Server = typeof server.$inferSelect;
export type NewServer = typeof server.$inferInsert;
