/**
 * Deploy environments a project can define. 'production' exists as a NAME so
 * config can be modeled, but specbook does not deploy production — prod
 * deploys live outside the platform on purpose.
 */
export const ENVIRONMENT_NAMES = ['staging', 'production'] as const;
export type EnvironmentName = (typeof ENVIRONMENT_NAMES)[number];

/** Env var names follow the POSIX convention the deploy renderer relies on. */
export const ENV_VAR_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/**
 * Environment domains become Caddy vhosts and shell arguments on the target
 * box, so the shape is strict: lowercase dns labels, at least two of them.
 */
export const ENVIRONMENT_DOMAIN_PATTERN =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * Data-plane provisioning lifecycle of an environment. 'provisioned' means
 * platform_env holds working wiring; 'failed' carries provision_error.
 */
export const PROVISION_STATUSES = [
  'unprovisioned',
  'provisioning',
  'provisioned',
  'failed',
] as const;
export type ProvisionStatus = (typeof PROVISION_STATUSES)[number];
