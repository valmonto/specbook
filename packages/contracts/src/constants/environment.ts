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

/**
 * How a user env var's VALUE is treated. Both are stored encrypted at rest in
 * the same sealed blob — the difference is only whether the API will ever
 * decode a value back to an authorized human:
 *   - 'secret' — write-only; the value is NEVER returned by any endpoint.
 *   - 'config' — readable (masked-until-revealed) by an env-editor/admin via
 *     an explicit server-side decode. Still encrypted at rest.
 * A var with no recorded classification is treated as 'secret' — the safe
 * default that preserves the historical write-only guarantee for old rows.
 */
export const ENV_VAR_CLASSIFICATIONS = ['secret', 'config'] as const;
export type EnvVarClassification = (typeof ENV_VAR_CLASSIFICATIONS)[number];

/**
 * Names that smell like a credential default to 'secret' on import/add. A
 * substring match (case-insensitive) is deliberately broad — over-sealing is
 * the safe error, and the user can flip any row to 'config'.
 */
export const SECRET_NAME_PATTERN = /(key|secret|password|token|credential)/i;

/** Smart default classification for a freshly seen variable name. */
export function classifyEnvVarName(name: string): EnvVarClassification {
  return SECRET_NAME_PATTERN.test(name) ? 'secret' : 'config';
}

/** One parsed `.env` line: an uppercased name and its dequoted value. */
export interface ParsedEnvEntry {
  name: string;
  value: string;
}

/** One line the parser rejected — `line` is 1-based; `reason` is a code the UI maps to k.*. */
export interface DotenvParseError {
  line: number;
  raw: string;
  reason: 'missingEquals' | 'emptyKey' | 'badName' | 'duplicate';
}

export type DotenvParseResult =
  | { ok: true; entries: ParsedEnvEntry[] }
  | { ok: false; errors: DotenvParseError[] };

/** Strip one layer of matching surrounding single or double quotes. */
function dequote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && ((v[0] === '"' && v.at(-1) === '"') || (v[0] === "'" && v.at(-1) === "'"))) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * Parse a pasted `.env` blob into reviewable rows. Blank lines and `#`
 * comments are ignored; an optional leading `export ` is tolerated; names are
 * uppercased and must match {@link ENV_VAR_NAME_PATTERN}. ANY bad line fails
 * the WHOLE parse (never a partial apply) — every offending line is reported
 * so the user can fix them all at once.
 */
export function parseDotenv(blob: string): DotenvParseResult {
  const entries: ParsedEnvEntry[] = [];
  const errors: DotenvParseError[] = [];
  const seen = new Set<string>();

  blob.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const body = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
    const eq = body.indexOf('=');
    if (eq === -1) {
      errors.push({ line, raw, reason: 'missingEquals' });
      return;
    }
    const name = body.slice(0, eq).trim().toUpperCase();
    if (!name) {
      errors.push({ line, raw, reason: 'emptyKey' });
      return;
    }
    if (!ENV_VAR_NAME_PATTERN.test(name)) {
      errors.push({ line, raw, reason: 'badName' });
      return;
    }
    if (seen.has(name)) {
      errors.push({ line, raw, reason: 'duplicate' });
      return;
    }
    seen.add(name);
    entries.push({ name, value: dequote(body.slice(eq + 1)) });
  });

  if (errors.length) return { ok: false, errors };
  return { ok: true, entries };
}
