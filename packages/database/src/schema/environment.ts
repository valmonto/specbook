import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  boolean,
  jsonb,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import {
  DATA_TRANSPORTS,
  ENVIRONMENT_NAMES,
  MCP_ACCESS_MODES,
  PROVISION_STATUSES,
} from '@pkg/contracts';
import { pk } from './helpers.js';
import { project } from './project.js';
import { server } from './server.js';
import { user } from './user.js';

/**
 * Where a project RUNS: an environment binds a project to a server and holds
 * its configuration in two layers. platform_env is machine-owned wiring
 * (filled by data-plane provisioning; humans see it, never edit it).
 * user_env_enc is one sealed JSON map of human-owned secrets whose VALUES are
 * write-only through every surface — only the deploy job renders them, server-side.
 */
export const projectEnvironment = pgTable(
  'project_environment',
  {
    id: pk(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => project.id, { onDelete: 'cascade' }),
    /** Values from @pkg/contracts ENVIRONMENT_NAMES. */
    name: varchar('name', { length: 32 }).notNull(),
    // RESTRICT: a server hosting environments cannot be deleted out from
    // under them — detach the environments first.
    serverId: uuid('server_id')
      .notNull()
      .references(() => server.id, { onDelete: 'restrict' }),
    /**
     * Data-plane placement, ADDITIVE: NULL keeps today's behaviour (the role
     * lives on the app server under its combined `data` role, container-DNS
     * wiring). Set = that role is provisioned on the named server, which must
     * hold the matching granular role. RESTRICT for the same reason as
     * serverId — a server hosting an environment's database cannot vanish.
     */
    databaseServerId: uuid('database_server_id').references(() => server.id, {
      onDelete: 'restrict',
    }),
    cacheServerId: uuid('cache_server_id').references(() => server.id, { onDelete: 'restrict' }),
    storageServerId: uuid('storage_server_id').references(() => server.id, {
      onDelete: 'restrict',
    }),
    /** Values from @pkg/contracts DATA_TRANSPORTS; required when any placement is set. */
    dataTransport: varchar('data_transport', { length: 16 }),
    domain: varchar('domain', { length: 255 }),
    deployPath: varchar('deploy_path', { length: 500 }),
    /** Declared now, inert until the auto-deploy task ships its behavior. */
    autoDeploy: boolean('auto_deploy').notNull().default(false),
    /** Machine-owned { NAME: value } wiring; read-only to humans. */
    platformEnv: jsonb('platform_env').notNull().default({}),
    /**
     * Sealed (SecretsService v1) JSON map of ALL user vars { NAME: value },
     * both secret and config; null when no user vars are set. The deploy
     * renderer reads this verbatim — its shape must not change.
     */
    userEnvEnc: text('user_env_enc'),
    /**
     * Plaintext { NAME: 'secret' | 'config' } classification for the user
     * vars. Names are non-secret (already listed in responses) and the label
     * is not sensitive, so this stays visible jsonb. A name missing here is
     * treated as 'secret' — the safe default for rows predating this column.
     */
    userEnvClass: jsonb('user_env_class').notNull().default({}),
    /** Data-plane lifecycle — values from @pkg/contracts PROVISION_STATUSES. */
    provisionStatus: varchar('provision_status', { length: 16 }).notNull().default('unprovisioned'),
    /** A k.* key or short detail from the last failed provision run. */
    provisionError: text('provision_error'),
    provisionedAt: timestamp('provisioned_at', { withTimezone: true }),
    /**
     * Agent (MCP) data-plane access — default DENIED. A human opens a window
     * ('read', until mcp_access_until) and it closes by itself: the executor
     * checks the clock on every call, so an expired grant IS 'none'. Values
     * from @pkg/contracts MCP_ACCESS_MODES. Every existing row is 'none'.
     */
    mcpAccess: varchar('mcp_access', { length: 8 }).notNull().default('none'),
    mcpAccessUntil: timestamp('mcp_access_until', { withTimezone: true }),
    /** Who opened the window (SET NULL if that user goes; the audit keeps the name). */
    mcpAccessBy: uuid('mcp_access_by').references(() => user.id, { onDelete: 'set null' }),
    /** Recorded reason — required for production windows. */
    mcpAccessReason: text('mcp_access_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index('project_environment_project_id_idx').on(table.projectId),
    index('project_environment_server_id_idx').on(table.serverId),
    index('project_environment_database_server_id_idx').on(table.databaseServerId),
    index('project_environment_cache_server_id_idx').on(table.cacheServerId),
    index('project_environment_storage_server_id_idx').on(table.storageServerId),
    uniqueIndex('project_environment_project_name_uq').on(table.projectId, table.name),
    check(
      'project_environment_name_check',
      sql.raw(`name IN (${ENVIRONMENT_NAMES.map((v) => `'${v}'`).join(', ')})`),
    ),
    check(
      'project_environment_data_transport_check',
      sql.raw(
        `data_transport IS NULL OR data_transport IN (${DATA_TRANSPORTS.map((v) => `'${v}'`).join(', ')})`,
      ),
    ),
    check(
      'project_environment_mcp_access_check',
      sql.raw(`mcp_access IN (${MCP_ACCESS_MODES.map((v) => `'${v}'`).join(', ')})`),
    ),
    check(
      'project_environment_provision_status_check',
      sql.raw(`provision_status IN (${PROVISION_STATUSES.map((v) => `'${v}'`).join(', ')})`),
    ),
  ],
);

export type ProjectEnvironment = typeof projectEnvironment.$inferSelect;
export type NewProjectEnvironment = typeof projectEnvironment.$inferInsert;
