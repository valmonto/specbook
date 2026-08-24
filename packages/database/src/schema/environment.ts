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
import { ENVIRONMENT_NAMES, PROVISION_STATUSES } from '@pkg/contracts';
import { pk } from './helpers';
import { project } from './project';
import { server } from './server';

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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index('project_environment_project_id_idx').on(table.projectId),
    index('project_environment_server_id_idx').on(table.serverId),
    uniqueIndex('project_environment_project_name_uq').on(table.projectId, table.name),
    check(
      'project_environment_name_check',
      sql.raw(`name IN (${ENVIRONMENT_NAMES.map((v) => `'${v}'`).join(', ')})`),
    ),
    check(
      'project_environment_provision_status_check',
      sql.raw(`provision_status IN (${PROVISION_STATUSES.map((v) => `'${v}'`).join(', ')})`),
    ),
  ],
);

export type ProjectEnvironment = typeof projectEnvironment.$inferSelect;
export type NewProjectEnvironment = typeof projectEnvironment.$inferInsert;
