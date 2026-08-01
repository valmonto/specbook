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
import { GithubAppService } from '../github/github-app.service';
import { OrgService } from '../org/org.service';
import { ProjectRepository } from './project.repository';

@Injectable()
export class ProjectService {
  constructor(
    private readonly projectRepository: ProjectRepository,
    private readonly orgService: OrgService,
    private readonly githubApp: GithubAppService,
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
      createdBy: activeUser.userId,
    });

    this.logger.info({ projectId: created.id, name: created.name }, 'Project created');

    return this.serialize(created);
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
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
    };
  }
}
