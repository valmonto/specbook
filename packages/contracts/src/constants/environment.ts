/**
 * Deploy environments a project can define. 'production' exists as a NAME so
 * config can be modeled, but specbook does not deploy production — prod
 * deploys live outside the platform on purpose.
 */
export const ENVIRONMENT_NAMES = ['staging', 'production'] as const;
export type EnvironmentName = (typeof ENVIRONMENT_NAMES)[number];

/** Env var names follow the POSIX convention the deploy renderer relies on. */
export const ENV_VAR_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
