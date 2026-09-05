import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectLogger, PinoLogger } from '@pkg/server';
import {
  isProjectScopedIdentity,
  type ActiveUser,
  type CreateProjectRequest,
  type CreateProjectResponse,
  type GetProjectByIdResponse,
  type GithubRepo,
  type ListProjectsRequest,
  type ListProjectsResponse,
  type Project as ProjectDto,
  type ProjectMembersView,
  type UpdateProjectRequest,
  type UpdateProjectResponse,
} from '@pkg/contracts';
import type { Project } from '@pkg/database';
import { k } from '@pkg/locales';
import { GithubAppService } from '@pkg/server';
import { OrgService } from '../org/org.service.js';
import { ProjectRepository } from './project.repository.js';
import { ProjectMemberRepository } from './project-member.repository.js';
import { TaskService } from './task.service.js';

@Injectable()
export class ProjectService {
  constructor(
    private readonly projectRepository: ProjectRepository,
    private readonly projectMemberRepository: ProjectMemberRepository,
    private readonly orgService: OrgService,
    private readonly githubApp: GithubAppService,
    private readonly taskService: TaskService,
    @InjectLogger() private readonly logger: PinoLogger,
  ) {}

  /**
   * The member id a read must be confined to, or undefined for all-access. A
   * human MEMBER is scoped to their granted projects; OWNER/ADMIN and agent
   * identities are not — so the dispatch runner keeps org-wide visibility.
   */
  private scopeFor(activeUser: ActiveUser): string | undefined {
    return isProjectScopedIdentity(activeUser) ? activeUser.userId : undefined;
  }

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

    let created: GithubRepo | null = null;
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

        this.logger.warn(
          { projectId, repoName: repo.name, err: templateError },
          'Template generation refused — falling back to a blank repository',
        );
        try {
          created = await this.githubApp.createProjectRepo(connection.installationId, {
            owner: installation.accountLogin,
            name: repo.name,
            templateFullName: null,
          });
        } catch (bareError) {
          const bare = (bareError as { response?: { status?: number; data?: unknown } }).response;
          const bareTaken =
            bare?.status === 422 && JSON.stringify(bare.data ?? '').includes('already exists');
          // A name that was free seconds ago and is taken now means the
          // failed /generate left a half-made repo behind (GitHub creates
          // the repo, then dies on its internal clone). That repo is OURS —
          // adopt it via the grant poll below instead of reporting a bogus
          // name conflict.
          if (!bareTaken) throw bareError;
          this.logger.warn(
            { projectId, repoName: repo.name },
            'Blank fallback collided with the half-generated repo — adopting it by name',
          );
        }
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
    // When adopting a half-generated repo we have no row yet, so the poll
    // matches by name; otherwise by the id GitHub returned.
    const wantedFullName = `${installation.accountLogin}/${repo.name}`.toLowerCase();
    let grantedRepo: GithubRepo | null = null;
    for (let attempt = 0; attempt < this.grantCheckAttempts; attempt++) {
      const repos = await this.githubApp.listRepositories(connection.installationId);
      grantedRepo =
        repos.find((r) =>
          created ? r.id === created.id : r.fullName.toLowerCase() === wantedFullName,
        ) ?? null;
      if (grantedRepo) break;
      if (attempt < this.grantCheckAttempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, this.grantCheckDelayMs));
      }
    }
    if (!grantedRepo) {
      this.logger.error(
        { projectId, repo: created?.fullName ?? wantedFullName },
        'Provisioned repo did not land in the installation grant — add it on GitHub',
      );
      throw new BadRequestException({
        message: k.tasks.errors.repoProvisionNotGranted,
        detail: created?.fullName ?? wantedFullName,
      });
    }
    created = grantedRepo;

    // Populate BEFORE protection — the PRs-only ruleset would block the
    // direct initial push. The populate refuses non-empty repos itself, so
    // a successful /generate result passes through untouched.
    const populateNote = wantsTemplate
      ? await this.populateOrNote(connection.installationId, connection.templateRepo!, created, projectId)
      : null;

    const protectionNote = await this.protectOrNote(connection.installationId, created, projectId);

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

  /**
   * Server-side template push (the /generate replacement); a failure
   * degrades to instructions on the init task, never to a dead end.
   */
  private async populateOrNote(
    installationId: number,
    templateRepo: string,
    created: GithubRepo,
    projectId: string,
  ): Promise<string | null> {
    try {
      await this.githubApp.populateFromTemplate(
        installationId,
        templateRepo,
        created.fullName,
        created.defaultBranch,
      );
      return null;
    } catch (error) {
      this.logger.warn(
        { projectId, repo: created.fullName, err: error },
        'Template populate failed — init task carries manual instructions',
      );
      return (
        `\n\nNOTE: the automatic template push failed, so the repository may be EMPTY. ` +
        `FIRST STEP before anything else: populate it from the template — ` +
        `\`git clone --depth 1 https://github.com/${templateRepo}.git\`, then push that ` +
        `tree to ${created.fullName} as the initial commit on the default branch (mint ` +
        'the push credential via get_repo_token for this project).'
      );
    }
  }

  /**
   * Best-effort protection: GitHub's free plan refuses rulesets on private
   * repos; a refusal binds anyway with a visible note — enforcement
   * degrades to convention (agents still branch + PR), never to silence.
   */
  private async protectOrNote(
    installationId: number,
    created: GithubRepo,
    projectId: string,
  ): Promise<string | null> {
    try {
      await this.githubApp.applyProtectionRuleset(installationId, created.fullName);
      return null;
    } catch (error) {
      const body = (error as { response?: { data?: { message?: string } } }).response;
      const reason = body?.data?.message ?? 'unknown reason';
      this.logger.warn(
        { projectId, repo: created.fullName, err: error },
        'Protection ruleset refused — binding anyway, default branch is unprotected',
      );
      return (
        `\n\nNOTE: GitHub refused the protection ruleset on ${created.fullName} ` +
        `("${reason}" — typically a private repository on the free plan). The default ` +
        'branch is currently UNPROTECTED: nothing physically prevents direct pushes. ' +
        'Keep to the branch-and-PR protocol, and protect the branch in the repository ' +
        'settings when the repo goes public or the plan allows it.'
      );
    }
  }

  /**
   * Finishes a provisioning that stalled on the grant: after the human adds
   * the repo to the installation, this verifies it, populates from the
   * template (empty repos only), applies protection, binds, and files the
   * init task the aborted run never created. Idempotent enough for a
   * double-click: an already-bound project only re-attempts the populate
   * (which itself refuses non-empty repos) and skips protection + init.
   */
  async completeProvisioning(
    activeUser: ActiveUser,
    dto: { id: string; githubRepoId: number; fromTemplate?: boolean },
  ): Promise<ProjectDto> {
    const project = await this.projectRepository.findById(dto.id, activeUser.orgId);
    if (!project) {
      throw new NotFoundException(k.tasks.errors.projectNotFound);
    }
    const alreadyBound = project.githubRepoId === dto.githubRepoId;

    const binding = await this.resolveGithubRepo(activeUser, dto.githubRepoId);
    const connection = await this.orgService.githubConnection(activeUser.orgId);
    if (!connection) {
      throw new BadRequestException(k.tasks.errors.repoProvisionUnavailable);
    }

    const populateNote =
      dto.fromTemplate && connection.templateRepo
        ? await this.populateOrNote(connection.installationId, connection.templateRepo, binding, dto.id)
        : null;

    if (alreadyBound) {
      return this.serialize(project);
    }

    const protectionNote = await this.protectOrNote(connection.installationId, binding, dto.id);

    const bound = await this.projectRepository.update(dto.id, activeUser.orgId, {
      repoUrl: binding.htmlUrl,
      githubRepoId: binding.id,
      githubRepoFullName: binding.fullName,
      defaultBranch: binding.defaultBranch,
    });

    // The aborted provisioning never filed the init task — do it now, but
    // only if the project has no tasks yet (a re-run must not duplicate it).
    const existing = await this.taskService.list(activeUser, {
      projectId: dto.id,
      skip: 0,
      limit: 1,
      available: false,
    });
    if (existing.meta.total === 0) {
      await this.taskService.create(activeUser, {
        projectId: dto.id,
        title: `Initialize ${project.name} from the template`,
        context:
          `The repository ${binding.fullName} was just created. ` +
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
    }

    this.logger.info(
      { projectId: dto.id, repo: binding.fullName, populated: !populateNote },
      'Stalled provisioning completed after manual grant',
    );
    return this.serialize(bound ?? project);
  }

  async list(activeUser: ActiveUser, dto: ListProjectsRequest): Promise<ListProjectsResponse> {
    const [{ data, total }, counts, spend] = await Promise.all([
      this.projectRepository.findForOrg(
        activeUser.orgId,
        {
          skip: dto.skip,
          limit: dto.limit,
          archived: dto.archived,
        },
        this.scopeFor(activeUser),
      ),
      this.projectRepository.countTasksByStatus(activeUser.orgId),
      this.projectRepository.monthSpendByProject(activeUser.orgId),
    ]);

    return {
      data: data.map((p) => ({
        ...this.serialize(p),
        statusCounts: counts.get(p.id) ?? {},
        ...this.budgetFields(p, spend.get(p.id) ?? 0),
      })),
      meta: { total, skip: dto.skip, limit: dto.limit },
    };
  }

  async getById(activeUser: ActiveUser, id: string): Promise<GetProjectByIdResponse> {
    const found = await this.projectRepository.findById(id, activeUser.orgId, this.scopeFor(activeUser));
    if (!found) {
      throw new NotFoundException(k.tasks.errors.projectNotFound);
    }
    const spend = await this.projectRepository.monthSpendByProject(activeUser.orgId);
    return { ...this.serialize(found), ...this.budgetFields(found, spend.get(found.id) ?? 0) };
  }

  /** Month-to-date spend + whether the budget gate holds the agent queue. */
  private budgetFields(
    p: Project,
    monthSpendUsdCents: number,
  ): { monthSpendUsdCents: number; budgetPaused: boolean } {
    return {
      monthSpendUsdCents,
      budgetPaused: p.budgetUsdCents !== null && monthSpendUsdCents >= p.budgetUsdCents,
    };
  }

  async update(activeUser: ActiveUser, dto: UpdateProjectRequest): Promise<UpdateProjectResponse> {
    const existing = await this.projectRepository.findById(dto.id, activeUser.orgId);
    if (!existing) {
      throw new NotFoundException(k.tasks.errors.projectNotFound);
    }
    // Archived projects are readonly until unarchived — the archive/unarchive
    // endpoints are the only doors.
    if (existing.archivedAt) {
      throw new BadRequestException(k.tasks.errors.projectArchivedReadonly);
    }
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

  /**
   * Manually clears the auto-mode breaker pause. The automatic clear — a
   * green default-branch workflow run — assumes such runs exist; a repo
   * whose default branch triggers no workflow (observed live: a template
   * repo with its failing deploy workflow disabled) can never emit one, so
   * without this override its pause is permanent and its tasks silently
   * never feed agents. Idempotent: resuming an unpaused project is a no-op.
   * Human court only — no MCP tool exposes it.
   */
  async resume(activeUser: ActiveUser, id: string): Promise<ProjectDto> {
    const resumed = await this.projectRepository.update(id, activeUser.orgId, {
      autoPausedAt: null,
      autoPauseKind: null,
      autoPausePointer: null,
    });
    if (!resumed) {
      throw new NotFoundException(k.tasks.errors.projectNotFound);
    }
    this.logger.info({ projectId: id, userId: activeUser.userId }, 'Project auto-pause cleared');
    return this.serialize(resumed);
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

  // --- Per-project visibility ACL (owner/admin surface) ---

  /**
   * The granted members of a project plus, for a repo-bound project, the
   * GitHub-collaborator reminder. Reflect-only: specbook says who can SEE the
   * project here; it NEVER grants a seat on the repository — that stays a
   * GitHub action the owner performs, this only reminds them to.
   */
  async listMembers(activeUser: ActiveUser, projectId: string): Promise<ProjectMembersView> {
    const project = await this.requireProject(activeUser, projectId);
    return this.membersView(activeUser, project);
  }

  /** Grant a MEMBER visibility of a project. Idempotent; owners/admins only. */
  async grantAccess(
    activeUser: ActiveUser,
    projectId: string,
    userId: string,
  ): Promise<ProjectMembersView> {
    const project = await this.requireProject(activeUser, projectId);
    if (!(await this.projectMemberRepository.isOrgMember(activeUser.orgId, userId))) {
      throw new BadRequestException(k.tasks.errors.grantNotOrgMember);
    }
    await this.projectMemberRepository.grant(activeUser.orgId, projectId, userId, activeUser.userId);
    this.logger.info({ projectId, userId, grantedBy: activeUser.userId }, 'Project access granted');
    return this.membersView(activeUser, project);
  }

  /** Revoke a member's project visibility. */
  async revokeAccess(
    activeUser: ActiveUser,
    projectId: string,
    userId: string,
  ): Promise<ProjectMembersView> {
    const project = await this.requireProject(activeUser, projectId);
    await this.projectMemberRepository.revoke(activeUser.orgId, projectId, userId);
    this.logger.info({ projectId, userId, revokedBy: activeUser.userId }, 'Project access revoked');
    return this.membersView(activeUser, project);
  }

  /** Org-scoped project existence for the ACL surface (owner/admin — no member scope). */
  private async requireProject(activeUser: ActiveUser, projectId: string): Promise<Project> {
    const project = await this.projectRepository.findById(projectId, activeUser.orgId);
    if (!project) {
      throw new NotFoundException(k.tasks.errors.projectNotFound);
    }
    return project;
  }

  private async membersView(activeUser: ActiveUser, project: Project): Promise<ProjectMembersView> {
    const members = await this.projectMemberRepository.listForProject(activeUser.orgId, project.id);
    return {
      data: members.map((m) => ({
        userId: m.userId,
        projectId: m.projectId,
        name: m.name,
        email: m.email,
        orgRole: m.orgRole,
        grantedAt: m.grantedAt.toISOString(),
      })),
      // Reflect-only reminder: a bound repo means the person also needs a
      // collaborator seat on GitHub — specbook never grants it, only surfaces it.
      githubReminder: project.githubRepoFullName
        ? { repoFullName: project.githubRepoFullName }
        : null,
    };
  }

  private serialize(p: Project): ProjectDto {
    return {
      ...p,
      mode: p.mode as ProjectDto['mode'],
      autoPausedAt: p.autoPausedAt?.toISOString() ?? null,
      autoPauseKind: p.autoPauseKind as ProjectDto['autoPauseKind'],
      autoPausePointer: p.autoPausePointer ?? null,
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
