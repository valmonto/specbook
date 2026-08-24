import { z } from 'zod';
import {
  ENV_VAR_CLASSIFICATIONS,
  ENV_VAR_NAME_PATTERN,
  ENVIRONMENT_DOMAIN_PATTERN,
  ENVIRONMENT_NAMES,
  PROVISION_STATUSES,
} from '../constants/environment';
import {
  DEPLOYMENT_PHASES,
  DEPLOYMENT_STATUSES,
  DEPLOYMENT_TRIGGERS,
} from '../constants/deployment';

export const EnvironmentNameSchema = z.enum(ENVIRONMENT_NAMES);
export const ProvisionStatusSchema = z.enum(PROVISION_STATUSES);
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
