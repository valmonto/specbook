import { createHash } from 'node:crypto';
import { routesApi } from '@pkg/contracts';

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

/**
 * The name of the one platform variable that CANNOT travel in .env.
 *
 * A `.env` line is a line: docker compose reads it verbatim, so a value
 * containing newlines has to be flattened or it corrupts the file. A PEM
 * certificate is inherently multi-line, and flattening it produces a string
 * OpenSSL cannot parse — at which point verification silently falls back to
 * the system trust store and every TLS connection fails with
 * UNABLE_TO_VERIFY_LEAF_SIGNATURE, naming the certificate rather than the
 * transport that mangled it. It travels in compose.yml instead, where YAML
 * block scalars carry newlines exactly. See renderComposeFile.
 */
export const COMPOSE_ONLY_ENV = ['DATABASE_CA_CERT'] as const;

const escapeEnvValue = (value: string): string =>
  // .env parsers (docker compose) take the line verbatim; strip newlines —
  // a value with them would corrupt the file. Anything that genuinely needs
  // newlines belongs in COMPOSE_ONLY_ENV, not here.
  value.replaceAll('\n', ' ').replaceAll('\r', '');

/** Indents a multi-line value under a YAML block scalar (`key: |`). */
const yamlBlock = (value: string, indent: string): string =>
  value
    .replaceAll('\r\n', '\n')
    .replace(/\n+$/, '')
    .split('\n')
    .map((line) => `${indent}${line}`)
    .join('\n');

/**
 * The rendered .env: platform wiring + user secrets + the runtime constants
 * every valmatic app expects. Precedence: caller-provided entries win in the
 * order given (later overrides earlier) — the worker passes platform first,
 * then user, so a user secret may deliberately override platform wiring.
 */
export function renderDeployEnv(layers: Array<Record<string, string>>): string {
  const merged: Record<string, string> = {};
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer)) {
      // Omitted rather than flattened: a mangled certificate is worse than an
      // absent one, because it fails as a trust error instead of a missing
      // variable. renderComposeFile carries these.
      if ((COMPOSE_ONLY_ENV as readonly string[]).includes(key)) continue;
      merged[key] = value;
    }
  }
  return (
    Object.keys(merged)
      .sort()
      .map((key) => `${key}=${escapeEnvValue(merged[key]!)}`)
      .join('\n') + '\n'
  );
}

/**
 * One extra hostname as the renderer needs it: which app answers `/`, and
 * whether `/api` and `/health` go to the api as well. `app === 'api'` is the
 * api-only case: there is no other app behind it, so `/` is a 404.
 */
export interface HostRoute {
  domain: string;
  app: string;
  withApi: boolean;
}

/** The largest request body the ingress lets through to an api. */
export const API_MAX_BODY = '64m';

/**
 * nginx entrypoint: /api and /health to the api, the SPA for the rest.
 * Upstreams go through variables + docker's embedded DNS resolver ON
 * PURPOSE: nginx otherwise caches container IPs at startup, and a redeploy
 * that recreates api/web (but not the proxy) leaves it routing to whichever
 * container inherited the old address — observed live as inverted routes.
 *
 * Extra hostnames each get a `server_name` block AFTER the catch-all: nginx
 * sends any Host it has no server_name for to the first server on the port,
 * and that is where the main domain, plain aliases of it and the
 * published-port case all belong. Caddy forwards the original Host, so nginx
 * can tell the hostnames apart.
 */
export function renderProxyConf(routes: readonly HostRoute[] = []): string {
  const head = `  listen 3000;
  resolver 127.0.0.11 valid=10s;`;
  // `client_max_body_size`: nginx refuses a body over 1 MB unless told
  // otherwise, and answers 413 before the api has seen a byte — a 1.18 MB
  // upload to an app whose api allowed 64 MB died here (xket, 2026-10-09).
  // This is only the outer wall, on /api alone; each api keeps its own,
  // smaller limits per route.
  const api = `  location /api { client_max_body_size ${API_MAX_BODY}; proxy_pass $api_upstream; proxy_set_header Host $host; proxy_set_header X-Forwarded-For $remote_addr; }
  location /health { proxy_pass $api_upstream; }`;
  const blocks = [
    `server {
${head}
  set $api_upstream http://api:3000;
  set $web_upstream http://web:3000;
${api}
  location / { proxy_pass $web_upstream; }
}
`,
  ];
  for (const route of routes) {
    // An alias of the main domain needs no block of its own: the catch-all
    // already serves exactly that, and one fewer block is one fewer place
    // for the two to drift apart.
    if (route.app === 'web' && route.withApi) continue;
    const lines = [`server {`, head, `  server_name ${route.domain};`];
    if (route.app === 'api') {
      // Nothing but the api. Without this the name would fall through to
      // the catch-all and serve a second copy of the web app on a hostname
      // nobody meant it to live on.
      lines.push(`  set $api_upstream http://api:3000;`, api, `  location / { return 404; }`);
    } else {
      if (route.withApi) lines.push(`  set $api_upstream http://api:3000;`);
      lines.push(`  set $app_upstream http://${route.app}:3000;`);
      if (route.withApi) lines.push(api);
      // Host and the client address are forwarded: an app that builds
      // absolute links or logs visitors needs the name it was reached on.
      lines.push(
        `  location / { proxy_pass $app_upstream; proxy_set_header Host $host; proxy_set_header X-Forwarded-For $remote_addr; }`,
      );
    }
    lines.push(`}`, ``);
    blocks.push(lines.join('\n'));
  }
  return blocks.join('');
}

/**
 * One Caddy vhost: hostname in, the environment's internal nginx out. Caddy
 * resolves the upstream per request (container DNS), so the file is valid
 * even before the stack is up, and obtains/renews the certificate itself.
 */
/**
 * The site file for one environment, imported by the box's Caddy.
 *
 * `tlsTerminatedUpstream` writes the `http://` form, which turns OFF Caddy's
 * automatic HTTPS: no certificate is requested and no :80 → :443 redirect is
 * installed. That is required whenever something in front already owns the
 * public ports — a hypervisor, a load balancer, a CDN origin.
 *
 * Getting this wrong does not fail loudly. Both layers redirect to HTTPS, and
 * the ACME challenge that would settle it is redirected too, so Let's Encrypt
 * fetches the challenge over a connection with no certificate yet and reports
 * a TLS error. The deploy then fails as a health-check timeout, naming the
 * certificate rather than the layer that ate the challenge.
 */
export function renderCaddySite(
  unit: string,
  domain: string | readonly string[],
  tlsTerminatedUpstream = false,
): string {
  // Several hostnames share one site block: Caddy obtains a certificate for
  // each and sends them all to the same ingress, where nginx tells them apart.
  const domains = typeof domain === 'string' ? [domain] : domain;
  const site = domains.map((d) => (tlsTerminatedUpstream ? `http://${d}` : d)).join(', ');
  return `${site} {
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
 * The migrate entrypoint path FOLLOWS THE IMAGE LAYOUT and must change with
 * it. The runtime images are built with `pnpm deploy --prod`, which flattens
 * one package to the image root — `/app/packages/**` does not exist in them.
 * This is rendered here rather than read from the repo's compose.staging.yml,
 * so fixing that file in every app repo (as was done when this same path took
 * production down) does NOT fix platform-deployed apps: they get THIS file.
 * The two must be kept in step.
 *
 * With a domain, the proxy publishes NO host port: it joins the external
 * specbook-ingress network under a deterministic container_name instead, and
 * Caddy (the box's only public listener) routes the hostname to it.
 */
type StoredExtraDomain = { domain: string; serves: string; withApi?: boolean | null };

/**
 * Everything the deploy needs to know about an environment's hostnames:
 *
 *  - `all` — every name it answers on, main domain first. One Caddy site,
 *    one DNS check and one health probe each.
 *  - `routes` — the extra names with the app each one serves.
 *  - `extraApps` — apps beyond the valmatic three that a hostname asks for.
 *    They are built and run ONLY because a route names them; a repo's other
 *    Dockerfiles (an e2e runner, say) are never picked up by accident.
 *
 * Extra hostnames only exist behind a main domain: without one the stack is
 * reached on its published port and no vhost is written at all, so they are
 * dropped rather than half-applied.
 */
export function deployHostnames(
  domain: string | null | undefined,
  extraDomains: ReadonlyArray<StoredExtraDomain> | null | undefined,
): { all: string[]; routes: HostRoute[]; extraApps: string[] } {
  if (!domain) return { all: [], routes: [], extraApps: [] };
  const seen = new Set<string>([domain]);
  const routes: HostRoute[] = [];
  for (const extra of extraDomains ?? []) {
    // The main domain always serves the whole app; an extra cannot redefine
    // it, and a name listed twice keeps its first meaning.
    if (seen.has(extra.domain)) continue;
    seen.add(extra.domain);
    routes.push({ domain: extra.domain, app: extra.serves, withApi: routesApi(extra) });
  }
  const core: readonly string[] = VALMATIC_APPS;
  return {
    all: [...seen],
    routes,
    extraApps: [...new Set(routes.map((r) => r.app).filter((app) => !core.includes(app)))].sort(),
  };
}

/**
 * The hostname arguments for the `deploy-stack` op: what to probe after the
 * stack is up. A name with the api behind it is probed on `/health`; one
 * without (a landing page) has no `/health`, so it is written `name=/` and
 * probed on its front page instead — otherwise a healthy landing page would
 * fail every deploy for not being an api.
 */
export function healthProbeArgs(hostnames: { all: string[]; routes: HostRoute[] }): string[] {
  const noApi = new Set(hostnames.routes.filter((r) => !r.withApi).map((r) => r.domain));
  return hostnames.all.map((name) => (noApi.has(name) ? `${name}=/` : name));
}

/**
 * The containers an environment's stack runs, by the names docker knows them
 * under — what `docker exec` and `docker logs` take. Derived exactly as
 * `renderComposeFile` and `deploy-stack` name them: compose prefixes each
 * service with the project (`-p <unit>`), and the ingress carries a fixed
 * `container_name`. Without a main domain the proxy is an ordinary service.
 *
 * The list is what a deploy WOULD run for these hostnames; it does not say
 * anything is up.
 */
export function stackContainers(
  unit: string,
  domain: string | null | undefined,
  extraDomains: ReadonlyArray<StoredExtraDomain> | null | undefined,
): Array<{ app: string; name: string }> {
  const apps = [...VALMATIC_APPS, ...deployHostnames(domain, extraDomains).extraApps];
  return [
    ...apps.map((app) => ({ app, name: `${unit}-${app}-1` })),
    { app: 'proxy', name: domain ? `specbook-ingress-${unit}` : `${unit}-proxy-1` },
  ];
}

/**
 * Do the environment's hostnames differ from what the running stack serves?
 *
 * `live` is the latest HEALTHY run's snapshot (null when there has never been
 * one). Extra hostnames are compared as a set with what each one serves, so
 * reordering the list is not a pending change but pointing a name at another
 * app, or switching its /api routing, is. Extras without a main domain serve
 * nothing, on either side, and are ignored.
 */
export function hostnamesPending(
  row: { domain: string | null; extraDomains?: ReadonlyArray<StoredExtraDomain> | null },
  live: { domain: string | null; extraDomains?: ReadonlyArray<StoredExtraDomain> | null } | null,
): boolean {
  const key = (e: {
    domain: string | null;
    extraDomains?: ReadonlyArray<StoredExtraDomain> | null;
  }): string =>
    JSON.stringify([
      e.domain ?? null,
      deployHostnames(e.domain, e.extraDomains)
        // Compared by EFFECT: an unset withApi and its explicit default are
        // the same routing, and must not read as a pending change.
        .routes.map((r) => `${r.domain}=${r.app}${r.withApi ? '+api' : ''}`)
        .sort(),
    ]);
  return key(row) !== key(live ?? { domain: null });
}

export function renderComposeFile(opts: {
  unit: string;
  sha: string;
  publicPort: number;
  /**
   * Which apps were built for this run: the valmatic ones present in the
   * repo (api required), plus any extra app a hostname asks for.
   */
  apps: readonly string[];
  /** When set, the vhost replaces the published port. */
  domain?: string | null;
  /**
   * PEM of the CA that signed an external database's certificate. It is
   * rendered here, not into .env, because it is the one value with newlines
   * that must survive intact — see COMPOSE_ONLY_ENV.
   */
  caCert?: string | null;
}): string {
  const { unit, sha, publicPort, apps, domain, caCert } = opts;
  const image = (app: string) => `${unit}-${app}:${sha}`;
  const hasWorker = apps.includes('worker');
  const hasWeb = apps.includes('web');
  // Only the services that open a database connection need it.
  const caEnv = caCert ? `\n      DATABASE_CA_CERT: |\n${yamlBlock(caCert, '        ')}` : '';

  const lines: string[] = [];
  lines.push('services:');
  lines.push(`  migrate:
    image: ${image('api')}
    env_file: [.env]
    entrypoint: ['node', '/app/node_modules/@pkg/database/dist/cli/migrate.mjs']
    networks: [default, specbook-data]${caEnv ? `\n    environment:${caEnv}` : ''}
    restart: 'no'`);
  lines.push(`  api:
    image: ${image('api')}
    env_file: [.env]
    environment:
      PORT: 3000${caEnv}
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
    env_file: [.env]${caEnv ? `\n    environment:${caEnv}` : ''}
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
  // Extra apps: whatever a hostname points at beyond the valmatic three. They
  // get NO .env and no data network on purpose — a landing page or docs site
  // has no business holding the database password or reaching Postgres, and
  // an app that does need them is not an extra app, it is part of the product.
  const core: readonly string[] = VALMATIC_APPS;
  for (const app of apps.filter((a) => !core.includes(a))) {
    lines.push(`  ${app}:
    image: ${image(app)}
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
