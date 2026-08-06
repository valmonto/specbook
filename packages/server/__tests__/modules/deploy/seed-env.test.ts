import { describe, expect, it } from 'vitest';
import { seedEnvDefaults } from '../../../src/modules/deploy/seed-env';
import { renderDeployEnv } from '../../../src/modules/deploy/render';

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
});
