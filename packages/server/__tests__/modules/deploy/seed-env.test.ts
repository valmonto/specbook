import { describe, expect, it } from 'vitest';
import { seedEnvDefaults } from '../../../src/modules/deploy/seed-env.js';
import { renderDeployEnv } from '../../../src/modules/deploy/render.js';

const generate = () => 'generated-password';

describe('seedEnvDefaults', () => {
  it('generates both credentials when no layer defines them', () => {
    const added = seedEnvDefaults({
      platformEnv: { IAM_JWT_SECRET: 'x' },
      userEnvNames: [],
      domain: 'vxi.stg.valmonto.com',
      generate,
    });
    expect(added).toEqual({
      SEED_INITIAL_EMAIL: 'admin@vxi.stg.valmonto.com',
      SEED_INITIAL_PASSWORD: 'generated-password',
    });
  });

  it('falls back to staging.local when the environment has no domain', () => {
    const added = seedEnvDefaults({
      platformEnv: {},
      userEnvNames: [],
      domain: null,
      generate,
    });
    expect(added.SEED_INITIAL_EMAIL).toBe('admin@staging.local');
  });

  it('skips a name the user secret layer already defines', () => {
    const added = seedEnvDefaults({
      platformEnv: {},
      userEnvNames: ['SEED_INITIAL_PASSWORD'],
      domain: null,
      generate,
    });
    expect(added).toEqual({ SEED_INITIAL_EMAIL: 'admin@staging.local' });
  });

  it('skips a name platform_env already carries (no rotation on redeploy)', () => {
    const added = seedEnvDefaults({
      platformEnv: {
        SEED_INITIAL_EMAIL: 'admin@kept.example',
        SEED_INITIAL_PASSWORD: 'kept',
      },
      userEnvNames: [],
      domain: 'new-domain.example',
      generate,
    });
    expect(added).toEqual({});
  });

  it('user layer wins over the generated value in the rendered env file', () => {
    const platformEnv = { SEED_INITIAL_EMAIL: 'admin@staging.local' };
    const out = renderDeployEnv([platformEnv, { SEED_INITIAL_EMAIL: 'me@real.example' }]);
    expect(out).toContain('SEED_INITIAL_EMAIL=me@real.example');
    expect(out).not.toContain('admin@staging.local');
  });

  // Precedence contract for the seed-cred override path (a Secret with the
  // same name as a platform variable). It holds at BOTH layers the worker
  // stacks, so a user's SEED_INITIAL_PASSWORD Secret always wins:
  it('a same-named Secret overrides the platform seed value, at both layers', () => {
    // Layer 1 — seed skips the name entirely when the user secret defines it,
    // so no platform value is ever generated to compete.
    const added = seedEnvDefaults({
      platformEnv: {},
      userEnvNames: ['SEED_INITIAL_PASSWORD'],
      domain: null,
      generate,
    });
    expect(added).not.toHaveProperty('SEED_INITIAL_PASSWORD');

    // Layer 2 — even against an ALREADY-persisted platform value, the render
    // order [platform, user, …] lets the user Secret override it in the .env.
    const out = renderDeployEnv([
      { SEED_INITIAL_PASSWORD: 'platform-generated' },
      { SEED_INITIAL_PASSWORD: 'operator-secret' },
    ]);
    expect(out).toContain('SEED_INITIAL_PASSWORD=operator-secret');
    expect(out).not.toContain('platform-generated');
  });
});
