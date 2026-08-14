import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createSign } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

export interface GithubPullRequest {
  number: number;
  url: string;
  state: 'open' | 'merged' | 'closed';
  additions: number;
  deletions: number;
  changedFiles: number;
  /** Top-level workspace paths the diff touches, e.g. "apps/web". */
  areas: string[];
}

const b64url = (input: string | Buffer): string =>
  Buffer.from(input).toString('base64url');

/** "apps/web/src/x.ts" → "apps/web"; "README.md" → "README.md". */
const topLevelArea = (filename: string): string => {
  const parts = filename.split('/');
  if (parts.length === 1) return parts[0]!;
  return parts[0] === 'apps' || parts[0] === 'packages'
    ? parts.slice(0, 2).join('/')
    : parts[0]!;
};

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
   * to { contents, pull_requests, workflows } write — GitHub enforces the
   * boundary, so a leaked token is one repo for one hour, nothing more.
   * `workflows` is what lets an agent create/update `.github/workflows/*`
   * (without it GitHub 403s those paths). Every requested scope must be one
   * the installation actually holds, or GitHub 422s the whole mint (returns
   * null here) — so this set stays to what the App is granted. Never cached,
   * never persisted. Null also means GitHub refused the restriction (404/422)
   * — the repo was dropped from the installation's grant since the project
   * bound it.
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
          permissions: {
            contents: 'write',
            pull_requests: 'write',
            workflows: 'write',
          },
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
   * Pushes the template's tree as a single "initial commit from template"
   * into an EMPTY repository — specbook's own replacement for GitHub's
   * /generate endpoint, which is unreliable with App installation tokens.
   * Strictly additive: a repo that already has commits is left untouched,
   * so this can only ever create history, never rewrite it. Callers must
   * run it BEFORE applyProtectionRuleset — the PRs-only rule would block
   * the direct initial push.
   *
   * `workflows` write is required alongside `contents`: the template tree
   * includes `.github/workflows/*`, and GitHub refuses to push workflow
   * files under a token that lacks the scope — which would drop CI from
   * every freshly provisioned repo.
   */
  async populateFromTemplate(
    installationId: number,
    templateFullName: string,
    repoFullName: string,
    defaultBranch = 'main',
  ): Promise<void> {
    const token = await this.installationToken(installationId, {
      contents: 'write',
      workflows: 'write',
    });

    // Emptiness guard: GitHub answers 409 for a repo with no commits.
    try {
      await this.http.get(`/repos/${repoFullName}/commits`, {
        params: { per_page: 1 },
        headers: { Authorization: `Bearer ${token}` },
      });
      return; // already has history — nothing to do
    } catch (error) {
      if (!(error instanceof AxiosError) || error.response?.status !== 409) throw error;
    }

    const dir = await mkdtemp(join(tmpdir(), 'specbook-tpl-'));
    try {
      await this.git(['clone', '--depth', '1', `${this.gitHost()}/${templateFullName}.git`, dir]);
      // A fresh orphan commit, not the template's history — the same
      // semantics as GitHub's own template generation.
      await this.git(['-C', dir, 'checkout', '--orphan', 'specbook-init']);
      await this.git(['-C', dir, 'add', '-A']);
      await this.git([
        '-C', dir,
        '-c', 'user.name=specbook',
        '-c', 'user.email=specbook@valmonto.com',
        'commit', '-m', `Initial commit from ${templateFullName} template`,
      ]);
      await this.git([
        '-C', dir,
        'push',
        `https://x-access-token:${token}@${this.gitHost().replace(/^https?:\/\//, '')}/${repoFullName}.git`,
        `HEAD:refs/heads/${defaultBranch}`,
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Git host derived from the API base so the stubbed dev seam never
   *  touches real GitHub (and fails fast against the stub instead). */
  private gitHost(): string {
    const base = this.http.defaults.baseURL ?? 'https://api.github.com';
    return base === 'https://api.github.com' ? 'https://github.com' : base.replace(/\/$/, '');
  }

  private async git(args: string[]): Promise<void> {
    await promisify(execFile)('git', args, { timeout: 120_000 });
  }

  /**
   * The provisioning ruleset: no force pushes, no deletions, PRs only into
   * the default branch — the same rules the human applies by hand to
   * existing repos. Callers treat it as best-effort: GitHub's free plan
   * refuses rulesets on private repositories, and that refusal must degrade
   * provisioning to a visible warning, not a dead end.
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

  /** Branch names of a granted repo — the create page's branch picker. */
  async listBranches(installationId: number, repoFullName: string): Promise<string[]> {
    const token = await this.installationToken(installationId, { contents: 'read' });
    const { data } = await this.http.get<Array<{ name: string }>>(
      `/repos/${repoFullName}/branches`,
      { params: { per_page: 100 }, headers: { Authorization: `Bearer ${token}` } },
    );
    return data.map((b) => b.name);
  }

  /**
   * The task's pull request, by number or by head branch — one shape for the
   * review card's stats line and the merge path. Null when none exists yet.
   * `areas` are the top-level workspace paths the diff touches, from the PR
   * files listing (first page is plenty for a review signal).
   */
  async getPullRequest(
    installationId: number,
    repoFullName: string,
    ref: { number: number } | { headBranch: string },
  ): Promise<GithubPullRequest | null> {
    const token = await this.installationToken(installationId, { pull_requests: 'read' });
    const auth = { headers: { Authorization: `Bearer ${token}` } };

    let number: number;
    if ('number' in ref) {
      number = ref.number;
    } else {
      const owner = repoFullName.split('/')[0];
      const { data } = await this.http.get<Array<{ number: number }>>(
        `/repos/${repoFullName}/pulls`,
        { params: { head: `${owner}:${ref.headBranch}`, state: 'all', per_page: 1 }, ...auth },
      );
      if (data.length === 0) return null;
      number = data[0]!.number;
    }

    try {
      const [{ data: pr }, { data: files }] = await Promise.all([
        this.http.get<{
          number: number;
          html_url: string;
          state: 'open' | 'closed';
          merged: boolean;
          additions: number;
          deletions: number;
          changed_files: number;
        }>(`/repos/${repoFullName}/pulls/${number}`, auth),
        this.http.get<Array<{ filename: string }>>(
          `/repos/${repoFullName}/pulls/${number}/files`,
          { params: { per_page: 100 }, ...auth },
        ),
      ]);
      const areas = [...new Set(files.map((f) => topLevelArea(f.filename)))].slice(0, 8);
      return {
        number: pr.number,
        url: pr.html_url,
        state: pr.merged ? 'merged' : pr.state,
        additions: pr.additions,
        deletions: pr.deletions,
        changedFiles: pr.changed_files,
        areas,
      };
    } catch (error) {
      if (error instanceof AxiosError && error.response?.status === 404) return null;
      throw error;
    }
  }

  /**
   * Open the PR the merge needs when the agent recorded only a branch —
   * same { contents, pull_requests } write scope as the agent's own token.
   */
  async createPullRequest(
    installationId: number,
    repoFullName: string,
    opts: { head: string; base: string; title: string },
  ): Promise<number> {
    const token = await this.installationToken(installationId, {
      contents: 'write',
      pull_requests: 'write',
    });
    const { data } = await this.http.post<{ number: number }>(
      `/repos/${repoFullName}/pulls`,
      { title: opts.title, head: opts.head, base: opts.base },
      { headers: { Authorization: `Bearer ${token}` } },
    );
    return data.number;
  }

  /**
   * Merge a PR into the default branch — the ruleset's allowed path. False
   * (not an exception) when GitHub refuses because the branch is not
   * mergeable (405/409: conflicts, stale, or a rule unmet) so the caller can
   * answer with a precise error instead of a 500.
   */
  async mergePullRequest(
    installationId: number,
    repoFullName: string,
    prNumber: number,
  ): Promise<boolean> {
    const token = await this.installationToken(installationId, {
      contents: 'write',
      pull_requests: 'write',
    });
    try {
      const { data } = await this.http.put<{ merged: boolean }>(
        `/repos/${repoFullName}/pulls/${prNumber}/merge`,
        { merge_method: 'merge' },
        { headers: { Authorization: `Bearer ${token}` } },
      );
      return data.merged;
    } catch (error) {
      if (
        error instanceof AxiosError &&
        (error.response?.status === 405 || error.response?.status === 409)
      ) {
        return false;
      }
      throw error;
    }
  }

  /**
   * The failed run's jobs with their step conclusions — the classifier's
   * entire input. Empty array (not an exception) on any fetch problem: a
   * classification is an enrichment, never worth failing the webhook job.
   */
  async listWorkflowJobs(
    installationId: number,
    repoFullName: string,
    runId: number,
  ): Promise<Array<{ name: string; conclusion: string | null; steps: Array<{ name: string; conclusion: string | null }> }>> {
    try {
      const token = await this.installationToken(installationId, { actions: 'read' });
      const { data } = await this.http.get<{
        jobs: Array<{
          name: string;
          conclusion: string | null;
          steps?: Array<{ name: string; conclusion: string | null }>;
        }>;
      }>(`/repos/${repoFullName}/actions/runs/${runId}/jobs`, {
        params: { per_page: 100, filter: 'latest' },
        headers: { Authorization: `Bearer ${token}` },
      });
      return data.jobs.map((j) => ({
        name: j.name,
        conclusion: j.conclusion,
        steps: (j.steps ?? []).map((s) => ({ name: s.name, conclusion: s.conclusion })),
      }));
    } catch {
      // Classification is an enrichment: a failed fetch degrades to plain red.
      return [];
    }
  }

  /**
   * Re-run only the failed jobs of a run. False (not an exception) when
   * GitHub refuses — the caller already marked the retry as spent, and a
   * refused rerun must not loop.
   */
  async rerunFailedJobs(
    installationId: number,
    repoFullName: string,
    runId: number,
  ): Promise<boolean> {
    try {
      const token = await this.installationToken(installationId, { actions: 'write' });
      await this.http.post(
        `/repos/${repoFullName}/actions/runs/${runId}/rerun-failed-jobs`,
        {},
        { headers: { Authorization: `Bearer ${token}` } },
      );
      return true;
    } catch {
      return false;
    }
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
