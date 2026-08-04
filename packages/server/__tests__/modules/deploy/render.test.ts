import { describe, expect, it } from 'vitest';
import {
  derivePublicPort,
  renderComposeFile,
  renderDeployEnv,
  renderProxyConf,
} from '../../../src/modules/deploy/render';

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
