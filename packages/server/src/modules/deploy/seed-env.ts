/**
 * The valmatic template REQUIRES seed credentials in production mode; a
 * first deploy that omits them boot-loops with an env-validation error the
 * operator has to diagnose (observed live on VXI's first deploy). This
 * fills them in exactly once, only when nothing else defines them.
 */

export interface SeedEnvInput {
  /** The platform layer being built for this deploy (mutated copy). */
  platformEnv: Record<string, string>;
  /** Names present in the user secret layer — user values always win. */
  userEnvNames: readonly string[];
  /** The environment's domain, when set — makes the email readable. */
  domain: string | null;
  /** Password generator, injected for testability. */
  generate: () => string;
}

/**
 * Returns the entries to persist into platform_env (empty when nothing is
 * missing). VISIBLE by design: the seed login is what the human uses to
 * enter the fresh staging — same accepted-tradeoff class as the database
 * password already documented in the README.
 */
export function seedEnvDefaults({
  platformEnv,
  userEnvNames,
  domain,
  generate,
}: SeedEnvInput): Record<string, string> {
  const defined = (key: string): boolean => key in platformEnv || userEnvNames.includes(key);

  const added: Record<string, string> = {};
  if (!defined('SEED_INITIAL_EMAIL')) {
    added.SEED_INITIAL_EMAIL = `admin@${domain ?? 'staging.local'}`;
  }
  if (!defined('SEED_INITIAL_PASSWORD')) {
    added.SEED_INITIAL_PASSWORD = generate();
  }
  return added;
}
