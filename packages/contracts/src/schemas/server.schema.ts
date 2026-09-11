import { z } from 'zod';
import {
  EXTERNAL_SERVER_ROLES,
  SERVER_MODES,
  SERVER_ROLES,
  SERVER_STATUSES,
} from '../constants/index.js';
import { PaginatedRequestSchema, PaginatedResponseSchema } from './pagination.schema.js';

export const ServerRoleSchema = z.enum(SERVER_ROLES);
export const ServerStatusSchema = z.enum(SERVER_STATUSES);
export const ServerModeSchema = z.enum(SERVER_MODES);

/** PEM is pasted by a human — accept surrounding whitespace, reject anything else. */
const CaCertSchema = z
  .string()
  .trim()
  .max(16_384)
  .refine(
    (v) => v.startsWith('-----BEGIN CERTIFICATE-----') && v.includes('-----END CERTIFICATE-----'),
    'must be a PEM certificate',
  );

/**
 * An external server is reached over the network, not over SSH: it needs the
 * credential specbook authenticates with, and it may only hold the roles that
 * require no local execution.
 *
 * CREATE ONLY, deliberately: these rules all branch on `mode`, and an update
 * request carries no mode — the stored row holds it. Applying them to a patch
 * would read every update as managed and reject an external server's own
 * credentials. Role rules that do NOT depend on mode belong in
 * `refineRunnerExclusive`, which both requests share.
 */
const externalShape = {
  mode: ServerModeSchema.optional(),
  tlsTerminatedUpstream: z.boolean().optional(),
  adminUser: z.string().min(1).max(64).optional(),
  adminSecret: z.string().min(1).max(512).optional(),
  caCert: CaCertSchema.optional(),
};

interface ModeShape {
  mode?: string;
  adminUser?: string;
  adminSecret?: string;
  caCert?: string;
  roles?: readonly string[];
}

function refineMode<T extends z.ZodObject<z.ZodRawShape>>(schema: T) {
  return schema.superRefine((value, ctx) => {
    const v = value as ModeShape;
    const external = v.mode === 'external';
    if (external && !v.adminUser) {
      ctx.addIssue({ code: 'custom', path: ['adminUser'], message: 'required for an external server' });
    }
    if (external && !v.adminSecret) {
      ctx.addIssue({ code: 'custom', path: ['adminSecret'], message: 'required for an external server' });
    }
    if (!external && (v.adminUser || v.adminSecret || v.caCert)) {
      ctx.addIssue({
        code: 'custom',
        path: ['mode'],
        message: 'credentials and CA apply only to an external server',
      });
    }
    const roles = v.roles;
    if (external && roles) {
      const bad = roles.filter((r) => !(EXTERNAL_SERVER_ROLES as readonly string[]).includes(r));
      if (bad.length) {
        ctx.addIssue({
          code: 'custom',
          path: ['roles'],
          message: `an external server cannot hold ${bad.join(', ')} — those need SSH`,
        });
      }
    }
  });
}

/**
 * A runner hosts the agent CLI unattended with permission prompts skipped
 * (remote-ops `runner-start`: IS_SANDBOX=1 --dangerously-skip-permissions).
 * That is only defensible on a box dedicated to it — otherwise an agent that
 * can run anything sits beside the app and data containers it could reach.
 *
 * Separate from `refineMode` because it depends only on `roles`: update can
 * carry roles without a mode, so this rule applies to BOTH requests while the
 * mode-dependent ones genuinely cannot.
 */
function refineRunnerExclusive<T extends z.ZodTypeAny>(schema: T) {
  return schema.superRefine((value, ctx) => {
    const roles = (value as { roles?: readonly string[] }).roles;
    if (!roles?.includes('runner') || roles.length === 1) return;
    const others = roles.filter((r) => r !== 'runner');
    ctx.addIssue({
      code: 'custom',
      path: ['roles'],
      message: `a runner runs agents with permissions skipped, so it needs a box of its own — remove ${others.join(', ')}`,
    });
  });
}

// --- Server Entity (public shape — key material NEVER appears here) ---
export const ServerSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  name: z.string(),
  host: z.string(),
  port: z.number().int(),
  sshUser: z.string(),
  /** How specbook reaches it. Pre-existing servers read as 'specbook'. */
  mode: ServerModeSchema,
  roles: z.array(ServerRoleSchema),
  /** External only — the provisioning role. Its password is never returned. */
  adminUser: z.string().nullable(),
  /** Public by design: a certificate is meant to be distributed. */
  caCert: z.string().nullable(),
  /**
   * Something in front of this box already terminates TLS for its domains —
   * a hypervisor, a load balancer, a CDN origin. specbook's own Caddy then
   * serves plain HTTP and never asks for a certificate.
   */
  tlsTerminatedUpstream: z.boolean(),
  /** Installed into authorized_keys on the target — safe to show freely. */
  publicKey: z.string(),
  /** SHA256 fingerprint pinned on first successful connect; null before. */
  hostFingerprint: z.string().nullable(),
  status: ServerStatusSchema,
  /** Why the last check failed; null when it passed or has not run. */
  lastCheckError: z.string().nullable(),
  lastCheckedAt: z.string().nullable(),
  createdBy: z.string().uuid(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Server = z.infer<typeof ServerSchema>;

// --- Create ---
export const CreateServerRequestSchema = refineRunnerExclusive(
  refineMode(
    z
      .object({
        name: z.string().min(1).max(255),
        /** SSH endpoint when managed; the address applications dial when external. */
        host: z.string().min(1).max(255),
        port: z.number().int().min(1).max(65535).optional(),
        sshUser: z.string().min(1).max(64).optional(),
        roles: z.array(ServerRoleSchema).min(1),
        ...externalShape,
      })
      .strict(),
  ),
);
export const CreateServerResponseSchema = ServerSchema;
export type CreateServerRequest = z.infer<typeof CreateServerRequestSchema>;
export type CreateServerResponse = z.infer<typeof CreateServerResponseSchema>;

// --- Update ---
export const UpdateServerRequestSchema = refineRunnerExclusive(
  z
    .object({
      id: z.string().uuid(),
      name: z.string().min(1).max(255).optional(),
      host: z.string().min(1).max(255).optional(),
      port: z.number().int().min(1).max(65535).optional(),
      sshUser: z.string().min(1).max(64).optional(),
      roles: z.array(ServerRoleSchema).min(1).optional(),
      /** Omit to leave the stored password untouched; a value replaces it. */
      adminUser: z.string().min(1).max(64).optional(),
      adminSecret: z.string().min(1).max(512).optional(),
      caCert: CaCertSchema.optional(),
      tlsTerminatedUpstream: z.boolean().optional(),
    })
    .strict(),
);
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
