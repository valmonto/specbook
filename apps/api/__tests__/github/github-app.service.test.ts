import { createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { GithubAppService } from '@pkg/server';

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

  it('createProjectRepo generates from the template with an admin-downscoped token', async () => {
    const service = configured();
    const http = { get: vi.fn(), post: vi.fn() };
    Object.assign(service, { http });

    http.post
      .mockResolvedValueOnce({ data: { token: 'ghs_admin' } }) // access_tokens
      .mockResolvedValueOnce({
        data: {
          id: 99,
          full_name: 'valmonto/new-product',
          html_url: 'https://github.com/valmonto/new-product',
          private: true,
          default_branch: 'main',
        },
      });

    const repo = await service.createProjectRepo(777, {
      owner: 'valmonto',
      name: 'new-product',
      // The template is the ORG's setting, passed in explicitly.
      templateFullName: 'valmonto/valmatic',
    });

    expect(repo.fullName).toBe('valmonto/new-product');
    // The admin token is DOWNSCOPED at mint time to exactly the call's needs.
    expect(http.post).toHaveBeenNthCalledWith(
      1,
      '/app/installations/777/access_tokens',
      { permissions: { administration: 'write', contents: 'write' } },
      expect.anything(),
    );
    expect(http.post).toHaveBeenNthCalledWith(
      2,
      '/repos/valmonto/valmatic/generate',
      { owner: 'valmonto', name: 'new-product', private: true },
      expect.objectContaining({ headers: { Authorization: 'Bearer ghs_admin' } }),
    );
  });

  it('createProjectRepo without a template creates a bare private org repo', async () => {
    const service = configured();
    const http = { get: vi.fn(), post: vi.fn() };
    Object.assign(service, { http });
    http.post
      .mockResolvedValueOnce({ data: { token: 'ghs_admin' } })
      .mockResolvedValueOnce({
        data: {
          id: 99,
          full_name: 'valmonto/bare',
          html_url: 'https://github.com/valmonto/bare',
          private: true,
          default_branch: 'main',
        },
      });

    await service.createProjectRepo(777, { owner: 'valmonto', name: 'bare', templateFullName: null });
    expect(http.post).toHaveBeenNthCalledWith(
      2,
      '/orgs/valmonto/repos',
      { name: 'bare', private: true },
      expect.anything(),
    );
  });

  it('applyProtectionRuleset applies the born-protected rules with an admin-only token', async () => {
    const service = configured();
    const http = { get: vi.fn(), post: vi.fn() };
    Object.assign(service, { http });
    http.post
      .mockResolvedValueOnce({ data: { token: 'ghs_admin_only' } })
      .mockResolvedValueOnce({ data: { id: 1 } });

    await service.applyProtectionRuleset(777, 'valmonto/new-product');

    expect(http.post).toHaveBeenNthCalledWith(
      1,
      '/app/installations/777/access_tokens',
      { permissions: { administration: 'write' } },
      expect.anything(),
    );
    const [url, body] = http.post.mock.calls[1] as [string, { rules: Array<{ type: string }> }];
    expect(url).toBe('/repos/valmonto/new-product/rulesets');
    expect(body.rules.map((rule) => rule.type).sort()).toEqual([
      'deletion',
      'non_fast_forward',
      'pull_request',
    ]);
  });

  it('exposes NO destructive repository method — a tested invariant, not a convention', () => {
    const service = configured();
    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(service)).filter(
      (name) => name !== 'constructor' && typeof (service as never)[name] === 'function',
    );
    for (const method of surface) {
      expect(method).not.toMatch(/delete|remove|destroy|archive|transfer|rename/i);
    }
    // The surface stays enumerated so a new method is a conscious addition here.
    expect(surface.sort()).toEqual([
      'appJwt',
      'applyProtectionRuleset',
      'createProjectRepo',
      'createPullRequest',
      'getInstallation',
      'getPullRequest',
      'git',
      'gitHost',
      'installUrl',
      'installationToken',
      'listBranches',
      'listRepositories',
      // Read-only jobs fetch for the CI failure classifier.
      'listWorkflowJobs',
      'mergePullRequest',
      'mintRepoToken',
      // Additive only: refuses repos that already have commits.
      'populateFromTemplate',
      // Re-runs failed jobs of an existing run — no repo mutation.
      'rerunFailedJobs',
    ]);
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
        isTemplate: false,
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

  it('mints a repo token restricted to the repo SHORT name and write permissions', async () => {
    const service = configured();
    const http = { get: vi.fn(), post: vi.fn() };
    Object.assign(service, { http });

    http.post.mockResolvedValueOnce({
      data: { token: 'ghs_scoped', expires_at: '2026-08-01T13:00:00Z' },
    });

    await expect(service.mintRepoToken(777, 'valmonto/specbook')).resolves.toEqual({
      token: 'ghs_scoped',
      expiresAt: '2026-08-01T13:00:00Z',
    });

    expect(http.post).toHaveBeenCalledWith(
      '/app/installations/777/access_tokens',
      {
        repositories: ['specbook'],
        permissions: { contents: 'write', pull_requests: 'write' },
      },
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: expect.stringMatching(/^Bearer /) }),
      }),
    );
  });

  it('treats a 404/422 on the restricted mint as dropped-from-grant (null), rethrows the rest', async () => {
    const service = configured();
    const http = { get: vi.fn(), post: vi.fn() };
    Object.assign(service, { http });

    const { AxiosError } = await import('axios');
    http.post.mockRejectedValueOnce(
      new AxiosError('gone', '404', undefined, undefined, { status: 404 } as never),
    );
    await expect(service.mintRepoToken(1, 'valmonto/specbook')).resolves.toBeNull();

    http.post.mockRejectedValueOnce(
      new AxiosError('unprocessable', '422', undefined, undefined, { status: 422 } as never),
    );
    await expect(service.mintRepoToken(1, 'valmonto/specbook')).resolves.toBeNull();

    http.post.mockRejectedValueOnce(new Error('network down'));
    await expect(service.mintRepoToken(1, 'valmonto/specbook')).rejects.toThrow('network down');
  });
});
