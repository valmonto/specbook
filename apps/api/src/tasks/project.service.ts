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

    const created = await this.projectRepository.create({
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
   * apply the protection ruleset, bind it, and file the init task — in that
   * order, because a repo must never be bound (and thus workable by agents)
   * before it is protected. Any failure surfaces as an error; the project
   * stays unbound and the human sees exactly what happened.
   */
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
    try {
      created = await this.githubApp.createProjectRepo(connection.installationId, {
        owner: installation.accountLogin,
        name: repo.name,
        // The template is the ORG's setting, resolved from its connection row.
        templateFullName: repo.fromTemplate ? connection.templateRepo : null,
      });
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
      throw new BadRequestException(k.tasks.errors.repoProvisionFailed);
    }

    // GitHub adds App-created repos to a selected-repos installation
    // automatically — verified rather than assumed, because a repo outside
    // the grant would be invisible to every later call.
    const granted = await this.githubApp.listRepositories(connection.installationId);
    if (!granted.some((r) => r.id === created.id)) {
      this.logger.error(
        { projectId, repo: created.fullName },
        'Provisioned repo did not land in the installation grant — add it on GitHub',
      );
      throw new BadRequestException(k.tasks.errors.repoProvisionNotGranted);
    }

    try {
      await this.githubApp.applyProtectionRuleset(connection.installationId, created.fullName);
    } catch (error) {
      // Born-protected is part of the contract: an unprotected repo is an
      // error state, not a silently-open success.
      this.logger.error(
        { projectId, repo: created.fullName, err: error },
        'Protection ruleset failed on provisioned repo — project left unbound',
      );
      throw new BadRequestException(k.tasks.errors.repoProvisionUnprotected);
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
        `The repository ${created.fullName} was just generated from the template. ` +
        'Boot it end to end: install dependencies, run the verify pipeline, rename template ' +
        'placeholders to this product, and confirm the dev stack starts. Record anything ' +
        'missing from the template as follow-up drafts.',
      acceptanceCriteria: [
        'pnpm install and pnpm verify exit 0 on a fresh clone',
        'Template placeholder names/branding replaced with this project',
        'Dev stack boots (api + web) and the seed login works',
      ],
    });

    this.logger.info(
      { projectId, repo: created.fullName, template: repo.fromTemplate },
      'Repository provisioned, protected and bound',
    );
  }

  async list(activeUser: ActiveUser, dto: ListProjectsRequest): Promise<ListProjectsResponse> {
    const [{ data, total }, counts] = await Promise.all([
      this.projectRepository.findForOrg(activeUser.orgId, { skip: dto.skip, limit: dto.limit }),
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

    const updated = await this.projectRepository.update(id, activeUser.orgId, data);
    if (!updated) {
      throw new NotFoundException(k.tasks.errors.projectNotFound);
    }
    return this.serialize(updated);
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
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
    };
  }
}
