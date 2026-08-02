import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectLogger, PinoLogger } from '@pkg/server';
import type {
  ActiveUser,
  CreateProjectRequest,
  CreateProjectResponse,
  GetProjectByIdResponse,
  GithubRepo,
  ListProjectsRequest,
  ListProjectsResponse,
  Project as ProjectDto,
  UpdateProjectRequest,
  UpdateProjectResponse,
} from '@pkg/contracts';
import type { Project } from '@pkg/database';
import { k } from '@pkg/locales';
import { GithubAppService } from '@pkg/server';
import { OrgService } from '../org/org.service';
import { ProjectRepository } from './project.repository';
import { TaskService } from './task.service';

@Injectable()
export class ProjectService {
  constructor(
    private readonly projectRepository: ProjectRepository,
    private readonly orgService: OrgService,
    private readonly githubApp: GithubAppService,
    private readonly taskService: TaskService,
    @InjectLogger() private readonly logger: PinoLogger,
  ) {}

  async create(activeUser: ActiveUser, dto: CreateProjectRequest): Promise<CreateProjectResponse> {
    const binding = dto.githubRepoId
      ? await this.resolveGithubRepo(activeUser, dto.githubRepoId)
      : null;

    let created: Project;
    try {
      created = await this.projectRepository.create({
        orgId: activeUser.orgId,
        name: dto.name,
        context: dto.context,
        // A picked repo overrides any client-sent URL: the binding's URL comes
        // from GitHub, so a project cannot claim repo A while binding to repo B.
        repoUrl: binding ? binding.htmlUrl : dto.repoUrl,
        githubRepoId: binding?.id,
        githubRepoFullName: binding?.fullName,
        defaultBranch: dto.defaultBranch ?? binding?.defaultBranch,
        workdir: dto.workdir,
        mode: dto.mode,
        maxParallel: dto.maxParallel,
        createdBy: activeUser.userId,
      });
    } catch (error) {
      if (isNameCollision(error)) {
        throw new BadRequestException(k.tasks.errors.projectNameTaken);
      }
      throw error;
    }

    this.logger.info({ projectId: created.id, name: created.name }, 'Project created');

    // Provisioning happens AFTER the project row exists: a GitHub-side
    // failure leaves a clean unbound project plus a surfaced error — never a
    // half-bound state, never a lost project.
    if (dto.newRepoName) {
      await this.provisionRepo(activeUser, created.id, dto.name, {
        name: dto.newRepoName,
        fromTemplate: dto.newRepoFromTemplate ?? true,
      });
      const bound = await this.projectRepository.findById(created.id, activeUser.orgId);
      return this.serialize(bound ?? created);
    }

    return this.serialize(created);
  }

  /**
   * Create the repository, verify it landed in the installation's grant,
   * attempt the protection ruleset, bind it, and file the init task.
   * Creation and grant failures surface as errors and leave the project
   * unbound; a refused ruleset does NOT block the bind (GitHub's free plan
   * refuses rulesets on private repos) — it downgrades to a visible note
   * on the init task instead.
   */
  /** Grant-propagation poll: attempts × delay ≈ 8s worst case. Instance
   *  fields (not consts) so tests can shrink the delay to milliseconds. */
  private readonly grantCheckAttempts = 5;
  private readonly grantCheckDelayMs = 2000;

  private async provisionRepo(
    activeUser: ActiveUser,
    projectId: string,
    projectName: string,
    repo: { name: string; fromTemplate: boolean },
  ): Promise<void> {
    if (!this.githubApp.enabled) {
      throw new BadRequestException(k.orgs.github.errors.notConfigured);
    }
    const connection = await this.orgService.githubConnection(activeUser.orgId);
    if (!connection) {
      throw new BadRequestException(k.tasks.errors.repoProvisionUnavailable);
    }
    const installation = await this.githubApp.getInstallation(connection.installationId);
    if (!installation?.canCreateRepos) {
      throw new BadRequestException(k.tasks.errors.repoProvisionUnavailable);
    }

    let created: GithubRepo;
    let populateNote: string | null = null;
    const wantsTemplate = repo.fromTemplate && Boolean(connection.templateRepo);
    try {
      try {
        created = await this.githubApp.createProjectRepo(connection.installationId, {
          owner: installation.accountLogin,
          name: repo.name,
          // The template is the ORG's setting, resolved from its connection row.
          templateFullName: wantsTemplate ? connection.templateRepo : null,
        });
      } catch (templateError) {
        // GitHub's template-generate endpoint is unreliable with App
        // installation tokens (its internal clone step doesn't inherit the
        // App's identity, and generated repos skip the selected-repos
        // auto-grant). A duplicate name is the user's to fix; every other
        // template refusal falls back to a BLANK repo — which auto-joins
        // the grant — plus explicit populate instructions on the init task.
        const status = (templateError as { response?: { status?: number; data?: unknown } })
          .response;
        const isNameTaken =
          status?.status === 422 && JSON.stringify(status.data ?? '').includes('already exists');
        if (!wantsTemplate || isNameTaken) throw templateError;

        const reason =
          (status?.data as { message?: string } | undefined)?.message ?? 'unknown reason';
        this.logger.warn(
          { projectId, repoName: repo.name, err: templateError },
          'Template generation refused — falling back to a blank repository',
        );
        created = await this.githubApp.createProjectRepo(connection.installationId, {
          owner: installation.accountLogin,
          name: repo.name,
          templateFullName: null,
        });
        populateNote =
          `\n\nNOTE: GitHub refused to generate from the template ("${reason}"), so the ` +
          `repository was created EMPTY. FIRST STEP before anything else: populate it from ` +
          `the template — \`git clone --depth 1 https://github.com/${connection.templateRepo}.git\`, ` +
          `then push that tree to ${created.fullName} as the initial commit on the default ` +
          'branch (mint the push credential via get_repo_token for this project).';
      }
    } catch (error) {
      this.logger.error(
        { orgId: activeUser.orgId, projectId, repoName: repo.name, err: error },
        'GitHub repo creation failed — project left unbound',
      );
      // GitHub answers a duplicate name with a 422 naming the field — the
      // one provisioning failure the user can fix themselves, so it gets
      // its own message instead of the generic one.
      const body = (error as { response?: { status?: number; data?: unknown } }).response;
      if (body?.status === 422 && JSON.stringify(body.data ?? '').includes('already exists')) {
        throw new BadRequestException(k.tasks.errors.repoNameTaken);
      }
      // Everything else carries GitHub's own words as `detail` — an opaque
      // "provisioning failed" hides exactly the part the human needs
      // (missing App permission, org policy, bad template …).
      const data = body?.data as
        | { message?: string; errors?: Array<string | { message?: string }> }
        | undefined;
      const detail = [
        data?.message,
        ...(data?.errors ?? []).map((e) => (typeof e === 'string' ? e : e?.message)),
      ]
        .filter(Boolean)
        .join(' — ');
      throw new BadRequestException({
        message: k.tasks.errors.repoProvisionFailed,
        ...(detail ? { detail: `GitHub: ${detail}` } : {}),
      });
    }

    // GitHub adds App-created repos to a selected-repos installation
    // automatically — but propagation is asynchronous, so the check polls
    // with backoff instead of failing on the first miss. A repo outside the
    // grant would be invisible to every later call, so this stays binding;
    // the create page turns the failure into a guided grant-and-recheck.
    let granted = false;
    for (let attempt = 0; attempt < this.grantCheckAttempts; attempt++) {
      const repos = await this.githubApp.listRepositories(connection.installationId);
      if (repos.some((r) => r.id === created.id)) {
        granted = true;
        break;
      }
      if (attempt < this.grantCheckAttempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, this.grantCheckDelayMs));
      }
    }
    if (!granted) {
      this.logger.error(
        { projectId, repo: created.fullName },
        'Provisioned repo did not land in the installation grant — add it on GitHub',
      );
      throw new BadRequestException({
        message: k.tasks.errors.repoProvisionNotGranted,
        detail: created.fullName,
      });
    }

    // Protection is best-effort, not binding: GitHub's free plan refuses
    // rulesets on private repos, and blocking provisioning on that turns a
    // plan limitation into a dead end. When it fails, the repo binds anyway
    // and the init task carries a visible note — enforcement degrades to
    // convention (agents still branch + PR), never to silence.
    let protectionNote: string | null = null;
    try {
      await this.githubApp.applyProtectionRuleset(connection.installationId, created.fullName);
    } catch (error) {
      const body = (error as { response?: { data?: { message?: string } } }).response;
      const reason = body?.data?.message ?? 'unknown reason';
      this.logger.warn(
        { projectId, repo: created.fullName, err: error },
        'Protection ruleset refused — binding anyway, default branch is unprotected',
      );
      protectionNote =
        `\n\nNOTE: GitHub refused the protection ruleset on ${created.fullName} ` +
        `("${reason}" — typically a private repository on the free plan). The default ` +
        'branch is currently UNPROTECTED: nothing physically prevents direct pushes. ' +
        'Keep to the branch-and-PR protocol, and protect the branch in the repository ' +
        'settings when the repo goes public or the plan allows it.';
    }

    await this.projectRepository.update(projectId, activeUser.orgId, {
      repoUrl: created.htmlUrl,
      githubRepoId: created.id,
      githubRepoFullName: created.fullName,
      defaultBranch: created.defaultBranch,
    });

    // The new project's first unit of work, as a DRAFT — the dispatch gate
    // stays the human's.
    await this.taskService.create(activeUser, {
      projectId,
      title: `Initialize ${projectName} from the template`,
      context:
        `The repository ${created.fullName} was just ` +
        (wantsTemplate && !populateNote ? 'generated from the template. ' : 'created. ') +
        'Boot it end to end: install dependencies, run the verify pipeline, rename template ' +
        'placeholders to this product, and confirm the dev stack starts. Record anything ' +
        'missing from the template as follow-up drafts.' +
        (populateNote ?? '') +
        (protectionNote ?? ''),
      acceptanceCriteria: [
        'pnpm install and pnpm verify exit 0 on a fresh clone',
        'Template placeholder names/branding replaced with this project',
        'Dev stack boots (api + web) and the seed login works',
      ],
    });

    this.logger.info(
      { projectId, repo: created.fullName, template: repo.fromTemplate, protected: !protectionNote },
      'Repository provisioned and bound',
    );
  }

  async list(activeUser: ActiveUser, dto: ListProjectsRequest): Promise<ListProjectsResponse> {
    const [{ data, total }, counts] = await Promise.all([
      this.projectRepository.findForOrg(activeUser.orgId, {
        skip: dto.skip,
        limit: dto.limit,
        archived: dto.archived,
      }),
      this.projectRepository.countTasksByStatus(activeUser.orgId),
    ]);

    return {
      data: data.map((p) => ({ ...this.serialize(p), statusCounts: counts.get(p.id) ?? {} })),
      meta: { total, skip: dto.skip, limit: dto.limit },
    };
  }

  async getById(activeUser: ActiveUser, id: string): Promise<GetProjectByIdResponse> {
    const found = await this.projectRepository.findById(id, activeUser.orgId);
    if (!found) {
      throw new NotFoundException(k.tasks.errors.projectNotFound);
    }
    return this.serialize(found);
  }

  async update(activeUser: ActiveUser, dto: UpdateProjectRequest): Promise<UpdateProjectResponse> {
    const { id, githubRepoId, ...patch } = dto;
    const data: Parameters<ProjectRepository['update']>[2] = patch;

    if (githubRepoId === null) {
      // Clear the binding; the URL stays — it is still a valid pointer, just
      // no longer backed by the installation.
      data.githubRepoId = null;
      data.githubRepoFullName = null;
    } else if (githubRepoId !== undefined) {
      const binding = await this.resolveGithubRepo(activeUser, githubRepoId);
      data.githubRepoId = binding.id;
      data.githubRepoFullName = binding.fullName;
      data.repoUrl = binding.htmlUrl;
    }

    let updated: Project | null;
    try {
      updated = await this.projectRepository.update(id, activeUser.orgId, data);
    } catch (error) {
      if (isNameCollision(error)) {
        throw new BadRequestException(k.tasks.errors.projectNameTaken);
      }
      throw error;
    }
    if (!updated) {
      throw new NotFoundException(k.tasks.errors.projectNotFound);
    }
    return this.serialize(updated);
  }

  /**
   * Archiving retires a project without destroying anything: it leaves the
   * lists, its tasks leave the dispatch queue and auto-progression, and the
   * name frees up for reuse. The GitHub repository is never touched — the
   * app deliberately holds no repo-deletion capability.
   */
  async archive(activeUser: ActiveUser, id: string): Promise<ProjectDto> {
    const archived = await this.projectRepository.update(id, activeUser.orgId, {
      archivedAt: new Date(),
    });
    if (!archived) {
      throw new NotFoundException(k.tasks.errors.projectNotFound);
    }
    this.logger.info({ projectId: id, userId: activeUser.userId }, 'Project archived');
    return this.serialize(archived);
  }

  /** Reverses archive; fails with nameTaken if a live project claimed the name meanwhile. */
  async unarchive(activeUser: ActiveUser, id: string): Promise<ProjectDto> {
    let restored: Project | null;
    try {
      restored = await this.projectRepository.update(id, activeUser.orgId, {
        archivedAt: null,
      });
    } catch (error) {
      if (isNameCollision(error)) {
        throw new BadRequestException(k.tasks.errors.projectNameTaken);
      }
      throw error;
    }
    if (!restored) {
      throw new NotFoundException(k.tasks.errors.projectNotFound);
    }
    this.logger.info({ projectId: id, userId: activeUser.userId }, 'Project unarchived');
    return this.serialize(restored);
  }

  /**
   * A repo binding is only ever accepted from the installation's own grant —
   * verified server-side against GitHub, not trusted from the client. The
   * caller's ACTIVE org supplies the installation, so cross-org binding is
   * structurally impossible.
   */
  private async resolveGithubRepo(activeUser: ActiveUser, githubRepoId: number): Promise<GithubRepo> {
    if (!this.githubApp.enabled) {
      throw new BadRequestException(k.orgs.github.errors.notConfigured);
    }

    const connection = await this.orgService.githubConnection(activeUser.orgId);
    if (!connection) {
      throw new BadRequestException(k.tasks.errors.repoNotInGrant);
    }

    const repos = await this.githubApp.listRepositories(connection.installationId);
    const match = repos.find((repo) => repo.id === githubRepoId);
    if (!match) {
      throw new BadRequestException(k.tasks.errors.repoNotInGrant);
    }
    return match;
  }

  async delete(activeUser: ActiveUser, id: string): Promise<void> {
    const deleted = await this.projectRepository.delete(id, activeUser.orgId);
    if (!deleted) {
      throw new NotFoundException(k.tasks.errors.projectNotFound);
    }
    this.logger.info({ projectId: id }, 'Project deleted');
  }

  private serialize(p: Project): ProjectDto {
    return {
      ...p,
      mode: p.mode as ProjectDto['mode'],
      autoPausedAt: p.autoPausedAt?.toISOString() ?? null,
      archivedAt: p.archivedAt?.toISOString() ?? null,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
    };
  }
}

/** The partial unique index on (org_id, lower(name)) — live projects only. */
const NAME_UNIQUE_INDEX = 'project_org_name_active_uq';

/** Postgres 23505 on the name index, however deep the driver wraps it
 *  (postgres.js says `constraint_name`, node-postgres says `constraint`). */
function isNameCollision(error: unknown): boolean {
  for (
    let e = error as
      | { code?: string; constraint?: string; constraint_name?: string; cause?: unknown }
      | undefined;
    e;
    e = e.cause as typeof e
  ) {
    if (
      e.code === '23505' &&
      (e.constraint === NAME_UNIQUE_INDEX || e.constraint_name === NAME_UNIQUE_INDEX)
    ) {
      return true;
    }
  }
  return false;
}
