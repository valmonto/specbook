import { z } from 'zod';
import { SERVER_ROLES, SERVER_STATUSES } from '../constants/index.js';
import { PaginatedRequestSchema, PaginatedResponseSchema } from './pagination.schema.js';

export const ServerRoleSchema = z.enum(SERVER_ROLES);
export const ServerStatusSchema = z.enum(SERVER_STATUSES);

// --- Server Entity (public shape — key material NEVER appears here) ---
export const ServerSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  name: z.string(),
  host: z.string(),
  port: z.number().int(),
  sshUser: z.string(),
  roles: z.array(ServerRoleSchema),
  /** Installed into authorized_keys on the target — safe to show freely. */
  publicKey: z.string(),
  /** SHA256 fingerprint pinned on first successful connect; null before. */
  hostFingerprint: z.string().nullable(),
  status: ServerStatusSchema,
  lastCheckedAt: z.string().nullable(),
  createdBy: z.string().uuid(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Server = z.infer<typeof ServerSchema>;

// --- Create ---
export const CreateServerRequestSchema = z
  .object({
    name: z.string().min(1).max(255),
    host: z.string().min(1).max(255),
    port: z.number().int().min(1).max(65535).optional(),
    sshUser: z.string().min(1).max(64).optional(),
    roles: z.array(ServerRoleSchema).min(1),
  })
  .strict();
export const CreateServerResponseSchema = ServerSchema;
export type CreateServerRequest = z.infer<typeof CreateServerRequestSchema>;
export type CreateServerResponse = z.infer<typeof CreateServerResponseSchema>;

// --- Update ---
export const UpdateServerRequestSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1).max(255).optional(),
    host: z.string().min(1).max(255).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    sshUser: z.string().min(1).max(64).optional(),
    roles: z.array(ServerRoleSchema).min(1).optional(),
  })
  .strict();
export const UpdateServerResponseSchema = ServerSchema;
export type UpdateServerRequest = z.infer<typeof UpdateServerRequestSchema>;
export type UpdateServerResponse = z.infer<typeof UpdateServerResponseSchema>;

// --- List / Get / Delete ---
export const ListServersRequestSchema = PaginatedRequestSchema.strict();
export const ListServersResponseSchema = PaginatedResponseSchema(ServerSchema);
export type ListServersRequest = z.infer<typeof ListServersRequestSchema>;
export type ListServersResponse = z.infer<typeof ListServersResponseSchema>;

export const GetServerByIdRequestSchema = z.object({ id: z.string().uuid() }).strict();
export const GetServerByIdResponseSchema = ServerSchema;
export type GetServerByIdRequest = z.infer<typeof GetServerByIdRequestSchema>;
export type GetServerByIdResponse = z.infer<typeof GetServerByIdResponseSchema>;

export const DeleteServerRequestSchema = z.object({ id: z.string().uuid() }).strict();
export const DeleteServerResponseSchema = z.object({});
export type DeleteServerRequest = z.infer<typeof DeleteServerRequestSchema>;
export type DeleteServerResponse = z.infer<typeof DeleteServerResponseSchema>;

// --- Test connection (enqueues a worker check; result lands on the row) ---
export const TestServerRequestSchema = z.object({ id: z.string().uuid() }).strict();
export const TestServerResponseSchema = ServerSchema;
export type TestServerRequest = z.infer<typeof TestServerRequestSchema>;
export type TestServerResponse = z.infer<typeof TestServerResponseSchema>;

// --- Hosted environments (the shared-instance view) ---
export const ServerEnvironmentsRequestSchema = z.object({ id: z.string().uuid() }).strict();
/** One environment that uses this server for some role; `roles` says which. */
export const HostedEnvironmentSchema = z.object({
  environmentId: z.string().uuid(),
  environmentName: z.string(),
  projectId: z.string().uuid(),
  projectName: z.string(),
  /** Which of this server's capabilities the environment uses. */
  roles: z.array(z.enum(['app', 'database', 'cache', 'storage'])),
  /** The Postgres role + database name when this server hosts its database. */
  databaseName: z.string().nullable(),
  provisionStatus: z.string(),
});
export const ServerEnvironmentsResponseSchema = z.object({
  data: z.array(HostedEnvironmentSchema),
});
export type ServerEnvironmentsRequest = z.infer<typeof ServerEnvironmentsRequestSchema>;
export type HostedEnvironment = z.infer<typeof HostedEnvironmentSchema>;
export type ServerEnvironmentsResponse = z.infer<typeof ServerEnvironmentsResponseSchema>;
