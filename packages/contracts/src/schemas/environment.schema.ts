import { z } from 'zod';
import {
  DATA_ACCESS_OUTCOMES,
  DATA_PLANE_RESOURCES,
  ENV_VAR_CLASSIFICATIONS,
  ENV_VAR_NAME_PATTERN,
  ENVIRONMENT_DOMAIN_PATTERN,
  ENVIRONMENT_NAMES,
  GRANTABLE_MCP_ACCESS_MODES,
  MCP_ACCESS_MIN_MINUTES,
  MCP_ACCESS_MODES,
  PROVISION_STATUSES,
} from '../constants/environment.js';
import {
  DEPLOYMENT_PHASES,
  DEPLOYMENT_STATUSES,
  DEPLOYMENT_TRIGGERS,
} from '../constants/deployment.js';
import { DATA_TRANSPORTS } from '../constants/server.js';

export const EnvironmentNameSchema = z.enum(ENVIRONMENT_NAMES);
export const ProvisionStatusSchema = z.enum(PROVISION_STATUSES);
export const DataTransportSchema = z.enum(DATA_TRANSPORTS);
export const McpAccessModeSchema = z.enum(MCP_ACCESS_MODES);
export const DeploymentStatusSchema = z.enum(DEPLOYMENT_STATUSES);

/** One deployment run; environments expose their latest. */
export const DeploymentSchema = z.object({
  id: z.string().uuid(),
  environmentId: z.string().uuid(),
  sha: z.string(),
  status: DeploymentStatusSchema,
  trigger: z.enum(DEPLOYMENT_TRIGGERS),
  /** What the machine is doing right now (null before the run starts). */
  phase: z.enum(DEPLOYMENT_PHASES).nullable(),
  /** Scrubbed, tail-capped remote output — the run's own story. */
  log: z.string().nullable(),
  error: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  createdBy: z.string().uuid(),
  createdAt: z.string(),
});
export type Deployment = z.infer<typeof DeploymentSchema>;

const EnvVarNameSchema = z.string().min(1).max(128).regex(ENV_VAR_NAME_PATTERN);
const EnvVarValueSchema = z.string().min(1).max(8192);
export const EnvVarClassificationSchema = z.enum(ENV_VAR_CLASSIFICATIONS);

/** One user var as it appears in a response: name + how its value is treated. */
export const UserEnvVarSchema = z.object({
  name: z.string(),
  classification: EnvVarClassificationSchema,
});
export type UserEnvVar = z.infer<typeof UserEnvVarSchema>;

// --- Environment Entity (public shape) ---
// platformEnv is fully visible (machine-owned wiring, humans debug against it).
// user_env appears as NAMES ONLY — values are write-only through every surface.
export const EnvironmentSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  name: EnvironmentNameSchema,
  serverId: z.string().uuid(),
  /** Denormalized for display; the server row stays the source of truth. */
  serverName: z.string(),
  /**
   * Data-plane placement. NULL = today's behaviour: the role lives on the app
   * server under its combined `data` role, wired over container DNS. Set =
   * that role is provisioned on the named server (which must hold the
   * matching granular role) and reached over `dataTransport`.
   */
  databaseServerId: z.string().uuid().nullable(),
  databaseServerName: z.string().nullable(),
  cacheServerId: z.string().uuid().nullable(),
  cacheServerName: z.string().nullable(),
  storageServerId: z.string().uuid().nullable(),
  storageServerName: z.string().nullable(),
  /** Required whenever any placement points at a server other than the app server. */
  dataTransport: DataTransportSchema.nullable(),
  domain: z.string().nullable(),
  deployPath: z.string().nullable(),
  /** Inert until the auto-deploy task ships behavior for it. */
  autoDeploy: z.boolean(),
  /** Machine-owned; read-only to humans. */
  platformEnv: z.record(z.string(), z.string()),
  /**
   * Names of user vars. SECRET values never appear in any response; CONFIG
   * values are fetched separately (and only on demand) via the reveal route.
   */
  userEnvNames: z.array(z.string()),
  /** Each user var's name + classification, sorted by name. */
  userEnvVars: z.array(UserEnvVarSchema),
  /** Data-plane lifecycle; error carries a k.* key or short detail. */
  provisionStatus: ProvisionStatusSchema,
  provisionError: z.string().nullable(),
  provisionedAt: z.string().nullable(),
  /** The most recent deployment run, if any. */
  latestDeployment: DeploymentSchema.nullable(),
  /** True when the redeploy breaker tripped: two consecutive auto-deploys failed. */
  autoDeployPaused: z.boolean(),
  /**
   * True while the domain field differs from what the running stack serves —
   * a set/changed/removed domain only takes effect on the next deploy, and
   * the UI must say so instead of showing the edit as if it were live.
   */
  domainPending: z.boolean(),
  /** Where the running staging answers (set while the latest deploy is healthy). */
  publicUrl: z.string().nullable(),
  /**
   * Agent data-plane access, as it stands NOW: a lapsed window reads as 'none'
   * with every companion field null — the server computes this against the
   * clock, so the UI never shows a dead grant as open.
   */
  mcpAccess: McpAccessModeSchema,
  mcpAccessUntil: z.string().nullable(),
  mcpAccessBy: z.string().uuid().nullable(),
  mcpAccessByName: z.string().nullable(),
  mcpAccessReason: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Environment = z.infer<typeof EnvironmentSchema>;

// --- List ---
export const ListEnvironmentsRequestSchema = z.object({ projectId: z.string().uuid() }).strict();
export const ListEnvironmentsResponseSchema = z.object({ data: z.array(EnvironmentSchema) });
export type ListEnvironmentsRequest = z.infer<typeof ListEnvironmentsRequestSchema>;
export type ListEnvironmentsResponse = z.infer<typeof ListEnvironmentsResponseSchema>;

// --- Create ---
export const CreateEnvironmentRequestSchema = z
  .object({
    projectId: z.string().uuid(),
    name: EnvironmentNameSchema,
    serverId: z.string().uuid(),
    domain: z.string().min(1).max(255).regex(ENVIRONMENT_DOMAIN_PATTERN).optional(),
    deployPath: z.string().min(1).max(500).optional(),
    autoDeploy: z.boolean().optional(),
    /** Omitted or null = same as the app server (the legacy `data` path). */
    databaseServerId: z.string().uuid().nullable().optional(),
    cacheServerId: z.string().uuid().nullable().optional(),
    storageServerId: z.string().uuid().nullable().optional(),
    dataTransport: DataTransportSchema.nullable().optional(),
  })
  .strict();
export const CreateEnvironmentResponseSchema = EnvironmentSchema;
export type CreateEnvironmentRequest = z.infer<typeof CreateEnvironmentRequestSchema>;
export type CreateEnvironmentResponse = z.infer<typeof CreateEnvironmentResponseSchema>;

// --- Update ---
export const UpdateEnvironmentRequestSchema = z
  .object({
    projectId: z.string().uuid(),
    id: z.string().uuid(),
    name: EnvironmentNameSchema.optional(),
    serverId: z.string().uuid().optional(),
    domain: z.string().max(255).regex(ENVIRONMENT_DOMAIN_PATTERN).nullable().optional(),
    deployPath: z.string().max(500).nullable().optional(),
    autoDeploy: z.boolean().optional(),
    databaseServerId: z.string().uuid().nullable().optional(),
    cacheServerId: z.string().uuid().nullable().optional(),
    storageServerId: z.string().uuid().nullable().optional(),
    dataTransport: DataTransportSchema.nullable().optional(),
  })
  .strict();
export const UpdateEnvironmentResponseSchema = EnvironmentSchema;
export type UpdateEnvironmentRequest = z.infer<typeof UpdateEnvironmentRequestSchema>;
export type UpdateEnvironmentResponse = z.infer<typeof UpdateEnvironmentResponseSchema>;

// --- Delete ---
export const DeleteEnvironmentRequestSchema = z
  .object({ projectId: z.string().uuid(), id: z.string().uuid() })
  .strict();
export const DeleteEnvironmentResponseSchema = z.object({});
export type DeleteEnvironmentRequest = z.infer<typeof DeleteEnvironmentRequestSchema>;
export type DeleteEnvironmentResponse = z.infer<typeof DeleteEnvironmentResponseSchema>;

// --- Set a user env var (create or replace one) ---
export const SetEnvVarRequestSchema = z
  .object({
    projectId: z.string().uuid(),
    id: z.string().uuid(),
    name: EnvVarNameSchema,
    value: EnvVarValueSchema,
    /** How the value is treated; defaults to a smart guess from the name. */
    classification: EnvVarClassificationSchema.optional(),
  })
  .strict();
export const SetEnvVarResponseSchema = EnvironmentSchema;
export type SetEnvVarRequest = z.infer<typeof SetEnvVarRequestSchema>;
export type SetEnvVarResponse = z.infer<typeof SetEnvVarResponseSchema>;

// --- Bulk set: atomically REPLACE the whole user-var set (add/rename/delete) ---
// One row of the desired end-state. `value` present = (re)seal it; `value`
// null = carry the existing sealed value over from `from` (the row's previous
// name — supports rename without ever resurfacing a secret). A new row must
// carry a value. The write is atomic: it rebuilds the sealed map in one pass.
export const EnvVarInputSchema = z
  .object({
    name: EnvVarNameSchema,
    classification: EnvVarClassificationSchema,
    value: EnvVarValueSchema.nullable(),
    /** The name this row previously had, when its value is being carried over. */
    from: EnvVarNameSchema.nullable(),
  })
  .strict();
export type EnvVarInput = z.infer<typeof EnvVarInputSchema>;

export const BulkSetEnvVarsRequestSchema = z
  .object({
    projectId: z.string().uuid(),
    id: z.string().uuid(),
    vars: z.array(EnvVarInputSchema).max(500),
  })
  .strict()
  .refine((dto) => new Set(dto.vars.map((v) => v.name)).size === dto.vars.length, {
    message: 'environments.errors.duplicateVar',
    path: ['vars'],
  });
export const BulkSetEnvVarsResponseSchema = EnvironmentSchema;
export type BulkSetEnvVarsRequest = z.infer<typeof BulkSetEnvVarsRequestSchema>;
export type BulkSetEnvVarsResponse = z.infer<typeof BulkSetEnvVarsResponseSchema>;

// --- Reveal: decode CONFIG values only (secrets are never included) ---
export const RevealEnvVarsRequestSchema = z
  .object({ projectId: z.string().uuid(), id: z.string().uuid() })
  .strict();
export const RevealEnvVarsResponseSchema = z.object({
  /** name -> decoded value, for config-classified vars only. */
  data: z.record(z.string(), z.string()),
});
export type RevealEnvVarsRequest = z.infer<typeof RevealEnvVarsRequestSchema>;
export type RevealEnvVarsResponse = z.infer<typeof RevealEnvVarsResponseSchema>;

// --- Provision (enqueues the data-plane job; result lands on the row) ---
export const ProvisionEnvironmentRequestSchema = z
  .object({ projectId: z.string().uuid(), id: z.string().uuid() })
  .strict();
export const ProvisionEnvironmentResponseSchema = EnvironmentSchema;
export type ProvisionEnvironmentRequest = z.infer<typeof ProvisionEnvironmentRequestSchema>;
export type ProvisionEnvironmentResponse = z.infer<typeof ProvisionEnvironmentResponseSchema>;

// --- Deploy (enqueues build+deploy of the default branch's HEAD) ---
export const DeployEnvironmentRequestSchema = z
  .object({ projectId: z.string().uuid(), id: z.string().uuid() })
  .strict();
export const DeployEnvironmentResponseSchema = EnvironmentSchema;
export type DeployEnvironmentRequest = z.infer<typeof DeployEnvironmentRequestSchema>;
export type DeployEnvironmentResponse = z.infer<typeof DeployEnvironmentResponseSchema>;

// --- Delete a user env var ---
export const DeleteEnvVarRequestSchema = z
  .object({
    projectId: z.string().uuid(),
    id: z.string().uuid(),
    name: EnvVarNameSchema,
  })
  .strict();
export const DeleteEnvVarResponseSchema = EnvironmentSchema;
export type DeleteEnvVarRequest = z.infer<typeof DeleteEnvVarRequestSchema>;
export type DeleteEnvVarResponse = z.infer<typeof DeleteEnvVarResponseSchema>;

// --- Agent data-plane access: open a window / close it / read the audit ---
/**
 * Open an expiring grant. `minutes` is bounded per environment by
 * MCP_ACCESS_MAX_MINUTES (checked in the service, which knows the environment).
 * Production additionally requires `confirm` to equal the environment name and a
 * `reason` — the louder confirmation the owner chose over a structural ban.
 * Only GRANTABLE modes are accepted; 'write' is a later, separate decision.
 */
export const GrantMcpAccessRequestSchema = z
  .object({
    projectId: z.string().uuid(),
    id: z.string().uuid(),
    mode: z.enum(GRANTABLE_MCP_ACCESS_MODES),
    minutes: z
      .number()
      .int()
      .min(MCP_ACCESS_MIN_MINUTES)
      .max(24 * 60),
    reason: z.string().trim().max(500).optional(),
    /** Typed environment name; required for production. */
    confirm: z.string().max(32).optional(),
  })
  .strict();
export const GrantMcpAccessResponseSchema = EnvironmentSchema;
export type GrantMcpAccessRequest = z.infer<typeof GrantMcpAccessRequestSchema>;
export type GrantMcpAccessResponse = z.infer<typeof GrantMcpAccessResponseSchema>;

export const RevokeMcpAccessRequestSchema = z
  .object({ projectId: z.string().uuid(), id: z.string().uuid() })
  .strict();
export const RevokeMcpAccessResponseSchema = EnvironmentSchema;
export type RevokeMcpAccessRequest = z.infer<typeof RevokeMcpAccessRequestSchema>;
export type RevokeMcpAccessResponse = z.infer<typeof RevokeMcpAccessResponseSchema>;

/** One audited data-plane call (or grant/revoke) — who, what, where, when, outcome. */
export const DataAccessAuditEntrySchema = z.object({
  id: z.string().uuid(),
  environmentId: z.string().uuid().nullable(),
  projectName: z.string(),
  environmentName: z.string(),
  /** The calling MCP key (null for human grant/revoke rows). */
  apiKeyId: z.string().uuid().nullable(),
  agentName: z.string().nullable(),
  /** The human behind a grant/revoke row (null for agent calls). */
  userId: z.string().uuid().nullable(),
  userName: z.string().nullable(),
  taskId: z.string().uuid().nullable(),
  resource: z.enum([...DATA_PLANE_RESOURCES, 'grant']),
  operation: z.string(),
  target: z.string().nullable(),
  outcome: z.enum(DATA_ACCESS_OUTCOMES),
  detail: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  createdAt: z.string(),
});
export type DataAccessAuditEntry = z.infer<typeof DataAccessAuditEntrySchema>;

export const ListDataAccessAuditRequestSchema = z
  .object({
    projectId: z.string().uuid(),
    id: z.string().uuid(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();
export const ListDataAccessAuditResponseSchema = z.object({
  data: z.array(DataAccessAuditEntrySchema),
});
export type ListDataAccessAuditRequest = z.infer<typeof ListDataAccessAuditRequestSchema>;
export type ListDataAccessAuditResponse = z.infer<typeof ListDataAccessAuditResponseSchema>;
