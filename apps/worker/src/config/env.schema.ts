import { z } from 'zod';

/**
 * Environment variable validation schema for the worker.
 * Validates all required and optional env vars at startup.
 */
export const envSchema = z.object({
  // Node environment
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  /**
   * Where managed agents reach THIS specbook (written into their .mcp.json).
   * Defaults to the production host so first deploys need no new env.
   */
  PUBLIC_BASE_URL: z.string().url().default('https://specbook.valmonto.com'),

  // Database
  // `.url()` alone accepts anything with a scheme — "A:" passes — so a typo'd
  // connection string survives startup and only fails on the first query.
  // Seals values the database holds but no API may return (server SSH keys,
  // environment secrets). 32 bytes, base64: `openssl rand -base64 32`.
  APP_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'APP_ENCRYPTION_KEY must be 32 bytes, base64-encoded'),
  DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\/.+/, 'DATABASE_URL must be a valid postgres:// connection URL'),
  DATABASE_MAX_CONNECTIONS: z.coerce.number().int().min(1).max(100).default(5),

  // BullMQ Redis (for job queues)
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().int().min(1).max(65535).default(6379),
  REDIS_PASSWORD: z.string().optional(),

  // Worker
  WORKER_PORT: z.coerce.number().int().min(1).max(65535).default(3001),

  // Logging — show NestJS framework bootstrap logs (module/route mapping). Off by default.
  LOG_FRAMEWORK: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // Telemetry — optional; absent = no-op
  SENTRY_DSN: z.string().url().optional(),
  POSTHOG_KEY: z.string().optional(),
  POSTHOG_HOST: z.string().url().default('https://eu.i.posthog.com'),
  // Object storage — the sweep deletes blobs alongside rows.
  STORAGE_ENDPOINT: z.string().url().default('http://localhost:9000'),
  STORAGE_REGION: z.string().default('us-east-1'),
  STORAGE_ACCESS_KEY_ID: z.string().default('specbook'),
  STORAGE_SECRET_ACCESS_KEY: z.string().default('specbook'),
  STORAGE_BUCKET: z.string().default('specbook-attachments'),

  // GitHub App — auto-mode progression merges PRs from the worker. All
  // optional; absent means auto modes annotate state but never merge (the
  // processor logs a warning). Same trio as the api: the private key arrives
  // base64-encoded and is decoded here.
  GITHUB_APP_ID: z.string().regex(/^\d+$/, 'GITHUB_APP_ID must be numeric').optional(),
  GITHUB_APP_SLUG: z.string().optional(),
  GITHUB_APP_PRIVATE_KEY: z
    .string()
    .optional()
    .transform((v) => {
      if (!v) return undefined;
      return v.includes('-----BEGIN') ? v : Buffer.from(v, 'base64').toString('utf8');
    }),
  GITHUB_API_BASE: z.string().url().default('https://api.github.com'),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Validates environment variables and returns typed config.
 * Throws descriptive errors if validation fails.
 */
export function validateEnv(config: Record<string, unknown>): Env {
  const result = envSchema.safeParse(config);

  if (!result.success) {
    const errors = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');

    throw new Error(`Environment validation failed:\n${errors}`);
  }

  return result.data;
}
