import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createSign } from 'node:crypto';
import axios, { AxiosError, type AxiosInstance } from 'axios';
import type { GithubRepo } from '@pkg/contracts';

export interface GithubInstallation {
  id: number;
  accountLogin: string;
  /** True when the installation granted Administration write — repo provisioning. */
  canCreateRepos: boolean;
}

export interface GithubRepoToken {
  token: string;
  /** ISO timestamp from GitHub — installation tokens live one hour. */
  expiresAt: string;
}

const b64url = (input: string | Buffer): string =>
  Buffer.from(input).toString('base64url');

/**
 * The ONLY code path that talks to GitHub. Everything is keyed off the three
 * GITHUB_APP_* env vars: absent → `enabled` is false and every feature built
 * on top degrades to pre-integration behaviour (the org settings card says
 * "not configured", the project form keeps its free-text repo URL).
 *
 * Auth model: a short-lived RS256 App JWT (hand-rolled with node:crypto — the
 * payload is three claims, not worth a dependency) authenticates App-level
 * calls; installation tokens are minted per call for repo-level reads and
 * NEVER cached or persisted — a leaked one is one installation for one hour.
 *
 * GITHUB_API_BASE exists so integration tests and local browser verification
 * can point this whole seam at a stub server; production leaves it default.
 */
@Injectable()
export class GithubAppService {
  private readonly appId?: string;
  private readonly slug?: string;
  private readonly privateKey?: string;
  private readonly http: AxiosInstance;

  constructor(config: ConfigService) {
    this.appId = config.get<string>('GITHUB_APP_ID');
    this.slug = config.get<string>('GITHUB_APP_SLUG');
    this.privateKey = config.get<string>('GITHUB_APP_PRIVATE_KEY');
    this.http = axios.create({
      baseURL: config.get<string>('GITHUB_API_BASE', 'https://api.github.com'),
      timeout: 10_000,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
  }

  get enabled(): boolean {
    return Boolean(this.appId && this.slug && this.privateKey);
  }

  /** Where "Connect GitHub" sends the browser; GitHub returns to the App's Setup URL. */
  installUrl(): string | null {
    return this.slug ? `https://github.com/apps/${this.slug}/installations/new` : null;
  }

  /**
   * The installation an org claims to have connected, or null if it does not
   * exist / does not belong to this App — the null path is what stops a
   * malicious installation_id in the callback from binding someone else's
   * installation to an org.
   */
  async getInstallation(installationId: number): Promise<GithubInstallation | null> {
    try {
      const { data } = await this.http.get<{
        id: number;
        account: { login: string } | null;
        permissions?: Record<string, string>;
      }>(`/app/installations/${installationId}`, {
        headers: { Authorization: `Bearer ${this.appJwt()}` },
      });
      return {
        id: data.id,
        accountLogin: data.account?.login ?? '',
        canCreateRepos: data.permissions?.administration === 'write',
      };
    } catch (error) {
      if (error instanceof AxiosError && error.response?.status === 404) return null;
      throw error;
    }
  }

  /** Exactly the repositories the installation grants — GitHub enforces the boundary. */
  async listRepositories(installationId: number): Promise<GithubRepo[]> {
    const token = await this.installationToken(installationId);
    const repos: GithubRepo[] = [];
    for (let page = 1; page <= 10; page++) {
      const { data } = await this.http.get<{
        repositories: Array<{
          id: number;
          full_name: string;
          html_url: string;
          private: boolean;
          default_branch: string;
          is_template?: boolean;
        }>;
        total_count: number;
      }>('/installation/repositories', {
        params: { per_page: 100, page },
        headers: { Authorization: `Bearer ${token}` },
      });
      repos.push(
        ...data.repositories.map((repo) => ({
          id: repo.id,
          fullName: repo.full_name,
          htmlUrl: repo.html_url,
          private: repo.private,
          defaultBranch: repo.default_branch,
          isTemplate: repo.is_template ?? false,
        })),
      );
      if (repos.length >= data.total_count || data.repositories.length === 0) break;
    }
    return repos;
  }

  /**
   * A 1-hour agent credential: restricted at MINT TIME to one repository and
   * to { contents, pull_requests } write — GitHub enforces the boundary, so a
   * leaked token is one repo for one hour, nothing more. Never cached, never
   * persisted. Null means GitHub refused the restriction (404/422) — the repo
   * was dropped from the installation's grant since the project bound it.
   */
  async mintRepoToken(
    installationId: number,
    repoFullName: string,
  ): Promise<GithubRepoToken | null> {
    // GitHub's access_tokens body takes repo SHORT names (no owner).
    const shortName = repoFullName.split('/').pop() ?? repoFullName;
    try {
      const { data } = await this.http.post<{ token: string; expires_at: string }>(
        `/app/installations/${installationId}/access_tokens`,
        {
          repositories: [shortName],
          permissions: { contents: 'write', pull_requests: 'write' },
        },
        { headers: { Authorization: `Bearer ${this.appJwt()}` } },
      );
      return { token: data.token, expiresAt: data.expires_at };
    } catch (error) {
      if (
        error instanceof AxiosError &&
        (error.response?.status === 404 || error.response?.status === 422)
      ) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Provision a repository for a project: private, generated from the
   * template when one is configured, otherwise created bare in the
   * installation's account.
   *
   * The Administration-capable token minted here is downscoped to exactly
   * what the call needs, lives inside this method, and is never returned,
   * logged or persisted — no caller (MCP or HTTP) ever receives an
   * admin-capable credential.
   */
  async createProjectRepo(
    installationId: number,
    opts: { owner: string; name: string; templateFullName: string | null },
  ): Promise<GithubRepo> {
    const token = await this.installationToken(installationId, {
      administration: 'write',
      contents: 'write',
    });
    const auth = { headers: { Authorization: `Bearer ${token}` } };

    const map = (repo: {
      id: number;
      full_name: string;
      html_url: string;
      private: boolean;
      default_branch: string;
      is_template?: boolean;
    }): GithubRepo => ({
      id: repo.id,
      fullName: repo.full_name,
      htmlUrl: repo.html_url,
      private: repo.private,
      defaultBranch: repo.default_branch,
      isTemplate: repo.is_template ?? false,
    });

    if (opts.templateFullName) {
      const { data } = await this.http.post(
        `/repos/${opts.templateFullName}/generate`,
        { owner: opts.owner, name: opts.name, private: true },
        auth,
      );
      return map(data);
    }

    const { data } = await this.http.post(`/orgs/${opts.owner}/repos`, { name: opts.name, private: true }, auth);
    return map(data);
  }

  /**
   * Every provisioned repo is born protected: the same ruleset the human
   * applies by hand to existing repos — no force pushes, no deletions, PRs
   * only into the default branch. Applied before the repo is bound to a
   * project, so no window exists where agents work in an unprotected repo.
   */
  async applyProtectionRuleset(installationId: number, repoFullName: string): Promise<void> {
    const token = await this.installationToken(installationId, { administration: 'write' });
    await this.http.post(
      `/repos/${repoFullName}/rulesets`,
      {
        name: 'protect-main',
        target: 'branch',
        enforcement: 'active',
        conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
        rules: [
          { type: 'deletion' },
          { type: 'non_fast_forward' },
          {
            type: 'pull_request',
            parameters: {
              required_approving_review_count: 0,
              dismiss_stale_reviews_on_push: false,
              require_code_owner_review: false,
              require_last_push_approval: false,
              required_review_thread_resolution: false,
              allowed_merge_methods: ['merge', 'squash', 'rebase'],
            },
          },
        ],
      },
      { headers: { Authorization: `Bearer ${token}` } },
    );
  }

  /**
   * Tokens are downscoped per call: an omitted permissions object inherits
   * the installation's full grant (read paths), an explicit one narrows to
   * exactly what the operation needs.
   */
  private async installationToken(
    installationId: number,
    permissions?: Record<string, string>,
  ): Promise<string> {
    const { data } = await this.http.post<{ token: string }>(
      `/app/installations/${installationId}/access_tokens`,
      permissions ? { permissions } : {},
      { headers: { Authorization: `Bearer ${this.appJwt()}` } },
    );
    return data.token;
  }

  /**
   * RS256 App JWT per GitHub's spec: iat backdated 60s against clock drift,
   * 9-minute expiry (GitHub's cap is 10), iss = App id.
   */
  private appJwt(): string {
    if (!this.appId || !this.privateKey) {
      throw new Error('GitHub App is not configured');
    }
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = b64url(
      JSON.stringify({ iat: now - 60, exp: now + 540, iss: this.appId }),
    );
    const signature = createSign('RSA-SHA256')
      .update(`${header}.${payload}`)
      .sign(this.privateKey, 'base64url');
    return `${header}.${payload}.${signature}`;
  }
}
