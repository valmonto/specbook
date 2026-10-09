import { describe, expect, it } from 'vitest';
import {
  deployHostnames,
  derivePublicPort,
  healthProbeArgs,
  hostnamesPending,
  renderCaddySite,
  renderComposeFile,
  renderDeployEnv,
  renderProxyConf,
  stackContainers,
} from '../../../src/modules/deploy/render.js';

describe('derivePublicPort', () => {
  it('is deterministic and stays in [20000, 27999]', () => {
    const port = derivePublicPort('acme_staging');
    expect(port).toBe(derivePublicPort('acme_staging'));
    expect(port).toBeGreaterThanOrEqual(20000);
    expect(port).toBeLessThan(28000);
  });

  it('different units land on different ports (overwhelmingly)', () => {
    expect(derivePublicPort('acme_staging')).not.toBe(derivePublicPort('other_staging'));
  });
});

describe('renderDeployEnv', () => {
  it('later layers override earlier ones and output is sorted KEY=value lines', () => {
    const out = renderDeployEnv([
      { B: 'platform', A: 'x' },
      { B: 'user-wins' },
      { NODE_ENV: 'production' },
    ]);
    expect(out).toBe('A=x\nB=user-wins\nNODE_ENV=production\n');
  });

  it('strips newlines from values — one line per variable, always', () => {
    const out = renderDeployEnv([{ EVIL: 'a\nB=injected' }]);
    expect(out).toBe('EVIL=a B=injected\n');
  });
});

describe('renderComposeFile', () => {
  /**
   * The migrate entrypoint follows the IMAGE layout. Runtime images are built
   * with `pnpm deploy --prod`, which flattens one package to the image root —
   * `/app/packages/**` does not exist in them.
   *
   * This path took production down once as a compose file, and again here as a
   * rendered one: fixing every app repo's compose.staging.yml does not fix
   * platform-deployed apps, because they are handed THIS file instead. lyceo
   * failed with `Cannot find module '/app/packages/database/dist/cli/migrate.mjs'`
   * long after the repo copies were corrected.
   */
  it('points migrate at the flattened image layout, not /app/packages', () => {
    const rendered = renderComposeFile({
      unit: 'unit_staging',
      sha: 'abc123',
      publicPort: 3010,
      apps: ['api', 'web'],
    });

    expect(rendered).toContain('/app/node_modules/@pkg/database/dist/cli/migrate.mjs');
    expect(rendered).not.toContain('/app/packages/database');
  });

  const compose = renderComposeFile({
    unit: 'acme_staging',
    sha: 'abc1234',
    publicPort: 21234,
    apps: ['api', 'worker', 'web'],
  });

  it('runs prebuilt images only — deploys never build', () => {
    expect(compose).toContain('image: acme_staging-api:abc1234');
    expect(compose).toContain('image: acme_staging-worker:abc1234');
    expect(compose).toContain('image: acme_staging-web:abc1234');
    expect(compose).not.toContain('build:');
  });

  it('migrate gates api/worker; only the proxy publishes the public port', () => {
    expect(compose).toContain('service_completed_successfully');
    expect(compose).toContain(`- '21234:3000'`);
    // exactly one ports: block — api/worker/web stay unpublished
    expect(compose.match(/ports:/g)).toHaveLength(1);
  });

  it('api and worker join the external data network; web does not need it', () => {
    expect(compose).toContain('specbook-data:\n    external: true');
    const webBlock = compose.slice(compose.indexOf('  web:'), compose.indexOf('  proxy:'));
    expect(webBlock).not.toContain('specbook-data');
  });

  it('a worker-less repo renders without a worker service', () => {
    const slim = renderComposeFile({
      unit: 'u_staging',
      sha: 'def5678',
      publicPort: 22000,
      apps: ['api', 'web'],
    });
    expect(slim).not.toContain('worker');
  });

  describe('with a domain', () => {
    const domained = renderComposeFile({
      unit: 'acme_staging',
      sha: 'abc1234',
      publicPort: 21234,
      apps: ['api', 'worker', 'web'],
      domain: 'acme.stg.example.com',
    });

    it('publishes NO host port — Caddy is the only public listener', () => {
      expect(domained).not.toContain('ports:');
      expect(domained).not.toContain('21234');
    });

    it('the proxy joins the external ingress network under its deterministic name', () => {
      expect(domained).toContain('container_name: specbook-ingress-acme_staging');
      expect(domained).toContain('networks: [default, specbook-ingress]');
      expect(domained).toContain('specbook-ingress:\n    external: true');
    });

    it('a null domain renders identically to no domain — existing envs unchanged', () => {
      const plain = renderComposeFile({
        unit: 'acme_staging',
        sha: 'abc1234',
        publicPort: 21234,
        apps: ['api', 'worker', 'web'],
      });
      const nulled = renderComposeFile({
        unit: 'acme_staging',
        sha: 'abc1234',
        publicPort: 21234,
        apps: ['api', 'worker', 'web'],
        domain: null,
      });
      expect(nulled).toBe(plain);
    });
  });
});

describe('renderCaddySite', () => {
  it('routes the hostname to the unit proxy on the ingress network', () => {
    expect(renderCaddySite('acme_staging', 'acme.stg.example.com')).toBe(
      'acme.stg.example.com {\n  reverse_proxy specbook-ingress-acme_staging:3000\n}\n',
    );
  });
});

describe('renderProxyConf', () => {
  it('routes /api and /health to the api and everything else to the web bundle', () => {
    const conf = renderProxyConf();
    expect(conf).toMatch(/location \/api \{ [^}]*proxy_pass \$api_upstream;/);
    expect(conf).toContain('location /health { proxy_pass $api_upstream; }');
    expect(conf).toContain('location / { proxy_pass $web_upstream; }');
  });

  /**
   * nginx's default is 1 MB and it answers 413 itself: an upload the api
   * would have taken never reached it.
   */
  it('lets an upload bigger than nginx’s 1 MB default through to the api, and only there', () => {
    const conf = renderProxyConf([
      { domain: 'api.example.com', app: 'api', withApi: true },
      { domain: 'docs.example.com', app: 'docs', withApi: true },
      { domain: 'plain.example.com', app: 'landing', withApi: false },
    ]);
    const apiLocations = conf.match(/location \/api \{[^}]*\}/g) ?? [];
    expect(apiLocations).toHaveLength(3);
    for (const location of apiLocations) expect(location).toContain('client_max_body_size 64m;');
    expect(conf.match(/client_max_body_size/g)).toHaveLength(3);
  });

  it('re-resolves upstreams via docker DNS — stale-IP inversion regression', () => {
    const conf = renderProxyConf();
    expect(conf).toContain('resolver 127.0.0.11');
    expect(conf).toContain('set $api_upstream http://api:3000;');
    expect(conf).toContain('set $web_upstream http://web:3000;');
  });
});

const PEM = `-----BEGIN CERTIFICATE-----
MIIBkTCB+wIJAKZ0F2hOexample1234567890abcdefghijklmnopqrstuvwxyzAB
CDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/==
-----END CERTIFICATE-----
`;

/**
 * Reads a `key: |` block back the way YAML does — strip the common indent,
 * keep the newlines. Asserting on this rather than on the raw text is what
 * makes the test about the CONTRACT (the container gets a parseable PEM)
 * instead of about the exact spacing of the renderer.
 */
function readBlockScalar(compose: string, key: string): string {
  const lines = compose.split('\n');
  const start = lines.findIndex((l) => l.trim() === `${key}: |`);
  if (start === -1) throw new Error(`no block scalar for ${key}`);
  const indent = /^(\s*)/.exec(lines[start + 1]!)![1]!;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith(indent) || line.trim() === '') break;
    body.push(line.slice(indent.length));
  }
  return body.join('\n') + '\n';
}

/**
 * A PEM is multi-line and a .env value is a line. Flattening the newlines
 * produced a certificate OpenSSL could not parse, so verification fell back to
 * the system trust store and every connection died with
 * UNABLE_TO_VERIFY_LEAF_SIGNATURE — an error naming the certificate rather
 * than the transport that had mangled it. It cost a day of deploys.
 */
describe('the database CA survives rendering', () => {
  it('never reaches .env, where newlines cannot survive', () => {
    const env = renderDeployEnv([{ DATABASE_URL: 'postgres://x', DATABASE_CA_CERT: PEM }]);

    expect(env).not.toContain('DATABASE_CA_CERT');
    expect(env).toContain('DATABASE_URL=postgres://x');
  });

  it('reaches every database-connected service through compose, byte for byte', () => {
    const compose = renderComposeFile({
      unit: 'acme_staging',
      sha: 'abc123',
      publicPort: 20001,
      apps: ['api', 'worker', 'web'],
      caCert: PEM,
    });

    expect(readBlockScalar(compose, 'DATABASE_CA_CERT')).toBe(PEM);
    // migrate is the one that used to fail: it runs FIRST, so a stack whose
    // certificate is wrong never gets as far as starting api or worker.
    expect(compose.split('DATABASE_CA_CERT: |').length - 1).toBe(3);
  });

  it('adds nothing when the database needs no private CA', () => {
    const compose = renderComposeFile({
      unit: 'acme_staging',
      sha: 'abc123',
      publicPort: 20001,
      apps: ['api', 'worker', 'web'],
    });

    expect(compose).not.toContain('DATABASE_CA_CERT');
  });
});

/**
 * Behind a front that already owns :80/:443, specbook's Caddy must NOT try to
 * get its own certificate. Both layers otherwise redirect to HTTPS, and the
 * ACME challenge that would settle it is redirected too — so no certificate is
 * ever issued and the deploy fails as a health-check timeout, naming the
 * certificate rather than the layer that ate the challenge.
 */
describe('renderCaddySite behind an upstream terminator', () => {
  it('asks for a certificate when this box owns the public ports', () => {
    const site = renderCaddySite('acme_staging', 'acme.example.com');

    expect(site.startsWith('acme.example.com {')).toBe(true);
    expect(site).not.toContain('http://');
  });

  it('serves plain HTTP when something in front terminates TLS', () => {
    const site = renderCaddySite('acme_staging', 'acme.example.com', true);

    // The `http://` prefix is what disables automatic HTTPS in Caddy: no ACME,
    // and no :80 -> :443 redirect to collide with the front's.
    expect(site.startsWith('http://acme.example.com {')).toBe(true);
  });

  it('routes to the same ingress container either way', () => {
    for (const upstream of [false, true]) {
      expect(renderCaddySite('acme_staging', 'acme.example.com', upstream)).toContain(
        'reverse_proxy specbook-ingress-acme_staging:3000',
      );
    }
  });
});

describe('several hostnames on one environment', () => {
  const extras = [
    { domain: 'app.example.com', serves: 'api' },
    { domain: 'www.example.com', serves: 'web' },
    { domain: 'example.com', serves: 'landing' },
  ];

  it('lists the main domain first, then the extras, with the app each one serves', () => {
    expect(deployHostnames('admin.example.com', extras)).toEqual({
      all: ['admin.example.com', 'app.example.com', 'www.example.com', 'example.com'],
      routes: [
        { domain: 'app.example.com', app: 'api', withApi: true },
        { domain: 'www.example.com', app: 'web', withApi: true },
        { domain: 'example.com', app: 'landing', withApi: false },
      ],
      extraApps: ['landing'],
    });
  });

  /**
   * Extra apps are built only because a hostname names them. The valmatic
   * three are never "extra", however many names point at them.
   */
  it('names each extra app once, and never the built-in ones', () => {
    const h = deployHostnames('admin.example.com', [
      { domain: 'a.example.com', serves: 'docs' },
      { domain: 'b.example.com', serves: 'landing' },
      { domain: 'c.example.com', serves: 'landing' },
      { domain: 'd.example.com', serves: 'web' },
      { domain: 'e.example.com', serves: 'api' },
    ]);
    expect(h.extraApps).toEqual(['docs', 'landing']);
  });

  /**
   * Without a main domain the stack is reached on its published port and no
   * vhost is written. Extras must not produce one on their own — a half-applied
   * list would serve names the environment page says it has no domain for.
   */
  it('drops the extras — and their apps — when there is no main domain', () => {
    expect(deployHostnames(null, extras)).toEqual({ all: [], routes: [], extraApps: [] });
  });

  it('never lists a hostname twice, and an extra cannot redefine the main domain', () => {
    const h = deployHostnames('admin.example.com', [
      { domain: 'admin.example.com', serves: 'landing' },
      { domain: 'app.example.com', serves: 'api' },
      { domain: 'app.example.com', serves: 'landing' },
    ]);
    expect(h.all).toEqual(['admin.example.com', 'app.example.com']);
    expect(h.routes).toEqual([{ domain: 'app.example.com', app: 'api', withApi: true }]);
    expect(h.extraApps).toEqual([]);
  });

  /** An explicit choice beats the app's default, in both directions. */
  it('honours an explicit withApi over the default for the app', () => {
    const h = deployHostnames('admin.example.com', [
      { domain: 'a.example.com', serves: 'web', withApi: false },
      { domain: 'b.example.com', serves: 'landing', withApi: true },
    ]);
    expect(h.routes.map((r) => r.withApi)).toEqual([false, true]);
  });

  it('puts every hostname in one Caddy site, so each gets its own certificate', () => {
    expect(renderCaddySite('acme_production', ['admin.example.com', 'app.example.com'])).toBe(
      'admin.example.com, app.example.com {\n  reverse_proxy specbook-ingress-acme_production:3000\n}\n',
    );
  });

  /** Behind an upstream TLS terminator EVERY name needs the http:// form. */
  it('writes the http:// form for every hostname behind an upstream terminator', () => {
    expect(renderCaddySite('acme_production', ['a.example.com', 'b.example.com'], true)).toContain(
      'http://a.example.com, http://b.example.com {',
    );
  });
});

describe('healthProbeArgs — what the deploy probes on each hostname', () => {
  /** A landing page has no /health; probing it there would fail every deploy. */
  it('probes /health where the api is, and the front page where it is not', () => {
    const hostnames = deployHostnames('app.example.com', [
      { domain: 'api.example.com', serves: 'api' },
      { domain: 'example.com', serves: 'landing' },
      { domain: 'docs.example.com', serves: 'docs', withApi: true },
      { domain: 'static.example.com', serves: 'web', withApi: false },
    ]);
    expect(healthProbeArgs(hostnames)).toEqual([
      'app.example.com',
      'api.example.com',
      'example.com=/',
      'docs.example.com',
      'static.example.com=/',
    ]);
  });

  it('is empty without a main domain', () => {
    expect(healthProbeArgs(deployHostnames(null, []))).toEqual([]);
  });
});

describe('renderProxyConf with extra hostnames', () => {
  const servers = (conf: string): string[] => conf.split(/(?=^server \{)/m);

  it('renders exactly as before when there are none', () => {
    expect(renderProxyConf([])).toBe(renderProxyConf());
    expect(servers(renderProxyConf())).toHaveLength(1);
  });

  /** A plain alias is what the catch-all already serves; a block of its own could only drift. */
  it('adds no block for an alias of the main domain', () => {
    expect(renderProxyConf([{ domain: 'www.example.com', app: 'web', withApi: true }])).toBe(
      renderProxyConf(),
    );
  });

  it('keeps the catch-all first, so an unnamed Host still reaches the main app', () => {
    const [catchAll] = servers(
      renderProxyConf([{ domain: 'example.com', app: 'landing', withApi: false }]),
    );
    expect(catchAll).not.toContain('server_name');
    expect(catchAll).toContain('location / { proxy_pass $web_upstream; }');
  });

  it('gives an api hostname the api and a 404 for everything else', () => {
    const [, apiOnly] = servers(
      renderProxyConf([{ domain: 'app.example.com', app: 'api', withApi: true }]),
    );
    expect(apiOnly).toContain('server_name app.example.com;');
    expect(apiOnly).toMatch(/location \/api \{ [^}]*proxy_pass \$api_upstream;/);
    expect(apiOnly).toContain('location /health { proxy_pass $api_upstream; }');
    expect(apiOnly).toContain('location / { return 404; }');
    // An api-only server must not be able to reach the web app at all.
    expect(apiOnly).not.toContain('web_upstream');
  });

  /** A landing page must not expose the api on the public marketing address. */
  it('sends a hostname to its own app, with no api unless asked', () => {
    const [, landing] = servers(
      renderProxyConf([{ domain: 'example.com', app: 'landing', withApi: false }]),
    );
    expect(landing).toContain('server_name example.com;');
    expect(landing).toContain('set $app_upstream http://landing:3000;');
    expect(landing).toContain('location / { proxy_pass $app_upstream;');
    expect(landing).not.toContain('/api');
    expect(landing).not.toContain('/health');
    expect(landing).not.toContain('web_upstream');
  });

  it('adds the api beside another app when asked', () => {
    const [, docs] = servers(
      renderProxyConf([{ domain: 'docs.example.com', app: 'docs', withApi: true }]),
    );
    expect(docs).toContain('set $app_upstream http://docs:3000;');
    expect(docs).toMatch(/location \/api \{ [^}]*proxy_pass \$api_upstream;/);
  });

  it('serves the web app without the api when the route says so', () => {
    const [, bare] = servers(
      renderProxyConf([{ domain: 'static.example.com', app: 'web', withApi: false }]),
    );
    expect(bare).toContain('set $app_upstream http://web:3000;');
    expect(bare).not.toContain('location /api');
  });

  /** Upstreams must go through a variable, or nginx pins the container IP at startup. */
  it('resolves every upstream per request', () => {
    const conf = renderProxyConf([
      { domain: 'example.com', app: 'landing', withApi: false },
      { domain: 'app.example.com', app: 'api', withApi: true },
    ]);
    expect(conf).not.toMatch(/proxy_pass http:/);
    expect(conf.match(/resolver 127\.0\.0\.11/g)).toHaveLength(3);
  });
});

describe('renderComposeFile with extra apps', () => {
  const compose = renderComposeFile({
    unit: 'acme_production',
    sha: 'abc1234',
    publicPort: 21000,
    apps: ['api', 'worker', 'web', 'landing'],
    domain: 'admin.example.com',
  });
  const service = (name: string): string =>
    compose.split(/(?=^  [a-z-]+:\n)/m).find((block) => block.startsWith(`  ${name}:`)) ?? '';

  it('runs an extra app from its own image', () => {
    expect(service('landing')).toContain('image: acme_production-landing:abc1234');
    expect(service('landing')).toContain('restart: unless-stopped');
  });

  /**
   * A landing page or docs site has no business holding the database
   * password or reaching Postgres.
   */
  it('gives an extra app no secrets and no path to the data plane', () => {
    expect(service('landing')).not.toContain('env_file');
    expect(service('landing')).not.toContain('specbook-data');
    expect(service('landing')).toContain('networks: [default]');
  });

  it('leaves the file untouched when there are none', () => {
    const opts = { unit: 'u', sha: 'abc1234', publicPort: 21000, domain: 'a.example.com' };
    expect(renderComposeFile({ ...opts, apps: ['api', 'web'] })).not.toContain('landing');
  });
});

describe('hostnamesPending — does the row differ from what is live?', () => {
  const live = {
    domain: 'admin.example.com',
    extraDomains: [{ domain: 'app.example.com', serves: 'api' }],
  };

  it('is false when the row matches the last healthy deploy', () => {
    expect(hostnamesPending(live, live)).toBe(false);
  });

  it('is true when an extra hostname was added, removed, or points at another app', () => {
    expect(hostnamesPending({ ...live, extraDomains: [] }, live)).toBe(true);
    expect(
      hostnamesPending(
        {
          ...live,
          extraDomains: [...live.extraDomains, { domain: 'x.example.com', serves: 'web' }],
        },
        live,
      ),
    ).toBe(true);
    expect(
      hostnamesPending(
        { ...live, extraDomains: [{ domain: 'app.example.com', serves: 'landing' }] },
        live,
      ),
    ).toBe(true);
  });

  it('is true when only the /api routing of a hostname changed', () => {
    const row = (withApi?: boolean) => ({
      domain: 'admin.example.com',
      extraDomains: [{ domain: 'example.com', serves: 'landing', withApi }],
    });
    expect(hostnamesPending(row(true), row(false))).toBe(true);
  });

  /** Compared by effect: spelling out the default changes nothing on the server. */
  it('treats an unset withApi and its explicit default as the same thing', () => {
    const row = (serves: string, withApi?: boolean) => ({
      domain: 'admin.example.com',
      extraDomains: [{ domain: 'x.example.com', serves, withApi }],
    });
    expect(hostnamesPending(row('web'), row('web', true))).toBe(false);
    expect(hostnamesPending(row('landing'), row('landing', false))).toBe(false);
  });

  it('ignores the order of the extras', () => {
    const two = [
      { domain: 'a.example.com', serves: 'web' },
      { domain: 'b.example.com', serves: 'api' },
    ];
    expect(
      hostnamesPending(
        { domain: 'm.example.com', extraDomains: two },
        { domain: 'm.example.com', extraDomains: [...two].reverse() },
      ),
    ).toBe(false);
  });

  it('treats never-deployed as serving nothing', () => {
    expect(hostnamesPending({ domain: null, extraDomains: [] }, null)).toBe(false);
    expect(hostnamesPending({ domain: 'a.example.com', extraDomains: [] }, null)).toBe(true);
  });

  /** Rows written before the column existed carry no list at all. */
  it('reads a missing list as empty', () => {
    expect(hostnamesPending({ domain: 'a.example.com' }, { domain: 'a.example.com' })).toBe(false);
  });
});

describe('stackContainers', () => {
  it('names the three core containers the way compose does, and the ingress by its fixed name', () => {
    expect(stackContainers('acme_production', 'app.example.com', [])).toEqual([
      { app: 'api', name: 'acme_production-api-1' },
      { app: 'worker', name: 'acme_production-worker-1' },
      { app: 'web', name: 'acme_production-web-1' },
      { app: 'proxy', name: 'specbook-ingress-acme_production' },
    ]);
  });

  it('includes an app a hostname asks for, once', () => {
    const names = stackContainers('acme_production', 'app.example.com', [
      { domain: 'example.com', serves: 'landing' },
      { domain: 'www.example.com', serves: 'landing' },
    ]).map((c) => c.name);
    expect(names.filter((n) => n === 'acme_production-landing-1')).toHaveLength(1);
  });

  /** The names must be the ones the rendered compose file actually produces. */
  it('agrees with the compose file about the ingress name', () => {
    const [proxy] = stackContainers('acme_production', 'app.example.com', []).slice(-1);
    const compose = renderComposeFile({
      unit: 'acme_production',
      sha: 'a'.repeat(40),
      publicPort: 20001,
      apps: ['api', 'worker', 'web'],
      domain: 'app.example.com',
      caCert: null,
    });
    expect(compose).toContain(`container_name: ${proxy!.name}`);
  });

  it('without a domain the proxy is an ordinary compose service, and extras are dropped', () => {
    expect(
      stackContainers('acme_staging', null, [{ domain: 'x.example.com', serves: 'landing' }]),
    ).toEqual([
      { app: 'api', name: 'acme_staging-api-1' },
      { app: 'worker', name: 'acme_staging-worker-1' },
      { app: 'web', name: 'acme_staging-web-1' },
      { app: 'proxy', name: 'acme_staging-proxy-1' },
    ]);
  });
});
