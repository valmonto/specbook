import { describe, expect, it } from 'vitest';
import {
  derivePublicPort,
  renderCaddySite,
  renderComposeFile,
  renderDeployEnv,
  renderProxyConf,
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
    expect(conf).toContain('location /api { proxy_pass $api_upstream;');
    expect(conf).toContain('location /health { proxy_pass $api_upstream; }');
    expect(conf).toContain('location / { proxy_pass $web_upstream; }');
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
