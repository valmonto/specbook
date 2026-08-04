import { z } from 'zod';
import {
  ENV_VAR_NAME_PATTERN,
  ENVIRONMENT_NAMES,
  PROVISION_STATUSES,
} from '../constants/environment';

export const EnvironmentNameSchema = z.enum(ENVIRONMENT_NAMES);
export const ProvisionStatusSchema = z.enum(PROVISION_STATUSES);

const EnvVarNameSchema = z.string().min(1).max(128).regex(ENV_VAR_NAME_PATTERN);

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
  /** Names of user secrets. Values never appear in any response. */
  userEnvNames: z.array(z.string()),
  /** Data-plane lifecycle; error carries a k.* key or short detail. */
  provisionStatus: ProvisionStatusSchema,
  provisionError: z.string().nullable(),
  provisionedAt: z.string().nullable(),
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
    domain: z.string().min(1).max(255).optional(),
    deployPath: z.string().min(1).max(500).optional(),
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
    domain: z.string().max(255).nullable().optional(),
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

// --- Set a user env var (create or replace; the value is WRITE-ONLY) ---
export const SetEnvVarRequestSchema = z
  .object({
    projectId: z.string().uuid(),
    id: z.string().uuid(),
    name: EnvVarNameSchema,
    value: z.string().min(1).max(8192),
  })
  .strict();
export const SetEnvVarResponseSchema = EnvironmentSchema;
export type SetEnvVarRequest = z.infer<typeof SetEnvVarRequestSchema>;
export type SetEnvVarResponse = z.infer<typeof SetEnvVarResponseSchema>;

// --- Provision (enqueues the data-plane job; result lands on the row) ---
export const ProvisionEnvironmentRequestSchema = z
  .object({ projectId: z.string().uuid(), id: z.string().uuid() })
  .strict();
export const ProvisionEnvironmentResponseSchema = EnvironmentSchema;
export type ProvisionEnvironmentRequest = z.infer<typeof ProvisionEnvironmentRequestSchema>;
export type ProvisionEnvironmentResponse = z.infer<typeof ProvisionEnvironmentResponseSchema>;

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
