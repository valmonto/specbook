/**
 * The single source of truth for an environment's deploy directory — the
 * folder on the app server that holds the rendered .env / compose.yml / proxy
 * config. Provisioning creates and hands it to the SSH user HERE, and the
 * deploy slice writes into it, so both MUST agree on the exact path: a shared
 * helper keeps them from drifting.
 *
 * A trailing slash is trimmed so `/srv/app/` and `/srv/app` name one dir; an
 * unset deployPath falls back to a per-unit folder under the SSH user's HOME
 * (`apps/<unit>`, relative — needs no privileged setup).
 */
export function resolveDeployDir(deployPath: string | null | undefined, unit: string): string {
  return deployPath?.replace(/\/+$/, '') || `apps/${unit}`;
}
