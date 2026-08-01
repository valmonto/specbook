import { createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { GithubAppService } from '@/github/github-app.service';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const configWith = (values: Record<string, string | undefined>) =>
  ({
    get: (key: string, def?: unknown) => values[key] ?? def,
  }) as unknown as ConfigService;

const configured = () =>
  new GithubAppService(
    configWith({
      GITHUB_APP_ID: '12345',
      GITHUB_APP_SLUG: 'valmonto-specbook',
      GITHUB_APP_PRIVATE_KEY: PEM,
    }),
  );

describe('GithubAppService', () => {
  it('is disabled when env is absent, with no install URL', () => {
    const service = new GithubAppService(configWith({}));
    expect(service.enabled).toBe(false);
    expect(service.installUrl()).toBeNull();
  });

  it('builds the install URL from the slug', () => {
    expect(configured().installUrl()).toBe(
      'https://github.com/apps/valmonto-specbook/installations/new',
    );
  });

  it('signs a valid RS256 App JWT: verifiable signature, iss = app id, ≤10min expiry', () => {
    const service = configured();
    const jwt = (service as unknown as { appJwt(): string }).appJwt();
    const [header, payload, signature] = jwt.split('.');

    expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });

    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString()) as {
      iat: number;
      exp: number;
      iss: string;
    };
    const now = Math.floor(Date.now() / 1000);
    expect(claims.iss).toBe('12345');
    expect(claims.iat).toBeLessThan(now); // backdated against clock drift
    expect(claims.exp - now).toBeLessThanOrEqual(600); // GitHub's hard cap

    const verified = createVerify('RSA-SHA256')
      .update(`${header}.${payload}`)
      .verify(publicKey, Buffer.from(signature!, 'base64url'));
    expect(verified).toBe(true);
  });

  it('returns null for an installation GitHub does not know (404), rethrows the rest', async () => {
    const service = configured();
    const http = { get: vi.fn(), post: vi.fn() };
    Object.assign(service, { http });

    const { AxiosError } = await import('axios');
    http.get.mockRejectedValueOnce(
      new AxiosError('nope', '404', undefined, undefined, { status: 404 } as never),
    );
    await expect(service.getInstallation(1)).resolves.toBeNull();

    http.get.mockRejectedValueOnce(new Error('network down'));
    await expect(service.getInstallation(1)).rejects.toThrow('network down');
  });

  it('lists repositories via a minted installation token, mapped to the contract shape', async () => {
    const service = configured();
    const http = { get: vi.fn(), post: vi.fn() };
    Object.assign(service, { http });

    http.post.mockResolvedValueOnce({ data: { token: 'ghs_short_lived' } });
    http.get.mockResolvedValueOnce({
      data: {
        total_count: 1,
        repositories: [
          {
            id: 42,
            full_name: 'valmonto/specbook',
            html_url: 'https://github.com/valmonto/specbook',
            private: true,
            default_branch: 'main',
          },
        ],
      },
    });

    await expect(service.listRepositories(777)).resolves.toEqual([
      {
        id: 42,
        fullName: 'valmonto/specbook',
        htmlUrl: 'https://github.com/valmonto/specbook',
        private: true,
        defaultBranch: 'main',
      },
    ]);

    expect(http.post).toHaveBeenCalledWith(
      '/app/installations/777/access_tokens',
      {},
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: expect.stringMatching(/^Bearer /) }) }),
    );
    expect(http.get).toHaveBeenCalledWith(
      '/installation/repositories',
      expect.objectContaining({
        headers: { Authorization: 'Bearer ghs_short_lived' },
        params: { per_page: 100, page: 1 },
      }),
    );
  });
});
