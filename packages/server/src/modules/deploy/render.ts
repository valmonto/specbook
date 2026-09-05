import { createHash } from 'node:crypto';

/**
 * Rendering for the deploy slice: everything that becomes a FILE on the
 * target box is produced here, pure and unit-tested — the worker only
 * transports. Valmatic convention v1: images <unit>-{api,worker,web}:<sha>,
 * one nginx entrypoint routing /api and /health to the api and everything
 * else to the static web bundle; only nginx publishes a host port.
 */

/** Apps the valmatic convention knows how to build and run. */
export const VALMATIC_APPS = ['api', 'worker', 'web'] as const;

/**
 * Stable public port for an environment, derived from the unit name:
 * [20000, 27999], deterministic so redeploys never move the staging URL.
 */
export function derivePublicPort(unit: string): number {
  const digest = createHash('sha256').update(unit).digest();
  return 20000 + (digest.readUInt16BE(0) % 8000);
}

const escapeEnvValue = (value: string): string =>
  // .env parsers (docker compose) take the line verbatim; strip newlines —
  // a value with them would corrupt the file.
  value.replaceAll('\n', ' ').replaceAll('\r', '');

/**
 * The rendered .env: platform wiring + user secrets + the runtime constants
 * every valmatic app expects. Precedence: caller-provided entries win in the
 * order given (later overrides earlier) — the worker passes platform first,
 * then user, so a user secret may deliberately override platform wiring.
 */
export function renderDeployEnv(layers: Array<Record<string, string>>): string {
  const merged: Record<string, string> = {};
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer)) merged[key] = value;
  }
  return (
    Object.keys(merged)
      .sort()
      .map((key) => `${key}=${escapeEnvValue(merged[key]!)}`)
      .join('\n') + '\n'
  );
}

/**
 * nginx entrypoint: /api and /health to the api, the SPA for the rest.
 * Upstreams go through variables + docker's embedded DNS resolver ON
 * PURPOSE: nginx otherwise caches container IPs at startup, and a redeploy
 * that recreates api/web (but not the proxy) leaves it routing to whichever
 * container inherited the old address — observed live as inverted routes.
 */
export function renderProxyConf(): string {
  return `server {
  listen 3000;
  resolver 127.0.0.11 valid=10s;
  set $api_upstream http://api:3000;
  set $web_upstream http://web:3000;
  location /api { proxy_pass $api_upstream; proxy_set_header Host $host; proxy_set_header X-Forwarded-For $remote_addr; }
  location /health { proxy_pass $api_upstream; }
  location / { proxy_pass $web_upstream; }
}
`;
}

/**
 * One Caddy vhost: hostname in, the environment's internal nginx out. Caddy
 * resolves the upstream per request (container DNS), so the file is valid
 * even before the stack is up, and obtains/renews the certificate itself.
 */
export function renderCaddySite(unit: string, domain: string): string {
  return `${domain} {
  reverse_proxy specbook-ingress-${unit}:3000
}
`;
}

/**
 * The environment's compose file. Mirrors the valmatic staging topology
 * (migrate one-shot → api/worker/web) with two differences: images are
 * prebuilt (never built on the app server) and the data plane lives outside
 * on the external specbook-data network, so no postgres/redis here.
 *
 * With a domain, the proxy publishes NO host port: it joins the external
 * specbook-ingress network under a deterministic container_name instead, and
 * Caddy (the box's only public listener) routes the hostname to it.
 */
export function renderComposeFile(opts: {
  unit: string;
  sha: string;
  publicPort: number;
  /** Which of the valmatic apps exist in this repo (api required). */
  apps: readonly string[];
  /** When set, the vhost replaces the published port. */
  domain?: string | null;
}): string {
  const { unit, sha, publicPort, apps, domain } = opts;
  const image = (app: string) => `${unit}-${app}:${sha}`;
  const hasWorker = apps.includes('worker');
  const hasWeb = apps.includes('web');

  const lines: string[] = [];
  lines.push('services:');
  lines.push(`  migrate:
    image: ${image('api')}
    env_file: [.env]
    entrypoint: ['node', '/app/packages/database/dist/cli/migrate.mjs']
    networks: [default, specbook-data]
    restart: 'no'`);
  lines.push(`  api:
    image: ${image('api')}
    env_file: [.env]
    environment:
      PORT: 3000
    networks: [default, specbook-data]
    healthcheck:
      test: ['CMD', 'node', '-e', "fetch('http://127.0.0.1:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 30s
    depends_on:
      migrate:
        condition: service_completed_successfully
    restart: unless-stopped`);
  if (hasWorker) {
    lines.push(`  worker:
    image: ${image('worker')}
    env_file: [.env]
    networks: [default, specbook-data]
    depends_on:
      migrate:
        condition: service_completed_successfully
    restart: unless-stopped`);
  }
  if (hasWeb) {
    lines.push(`  web:
    image: ${image('web')}
    env_file: [.env]
    networks: [default]
    restart: unless-stopped`);
  }
  lines.push(`  proxy:
    image: nginx:alpine
    volumes:
      - ./nginx.conf:/etc/nginx/conf.d/default.conf:ro
${
  domain
    ? `    container_name: specbook-ingress-${unit}
    networks: [default, specbook-ingress]`
    : `    ports:
      - '${publicPort}:3000'
    networks: [default]`
}
    depends_on:
      api:
        condition: service_healthy
    restart: unless-stopped`);
  lines.push(`networks:
  specbook-data:
    external: true${
      domain
        ? `
  specbook-ingress:
    external: true`
        : ''
    }`);
  return lines.join('\n') + '\n';
}
