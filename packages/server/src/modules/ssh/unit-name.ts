/**
 * The name of an environment's isolated share of the data plane — Postgres
 * role, database, and Redis container all carry it. Derived SERVER-SIDE from
 * the project and environment names, never from user input, and constrained
 * to what the remote-op scripts accept verbatim: ^[a-z][a-z0-9_]{0,47}$.
 * Unique per server because project names are unique per org and servers are
 * org-scoped.
 */
export function dataPlaneUnitName(projectName: string, environmentName: string): string {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .replace(/_{2,}/g, '_');
  const project = slug(projectName).slice(0, 32) || 'project';
  const env = slug(environmentName).slice(0, 12) || 'env';
  const name = `${project}_${env}`.replace(/_{2,}/g, '_');
  return (/^[a-z]/.test(name) ? name : `p_${name}`).slice(0, 48);
}
