import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectLogger, PinoLogger } from '@pkg/server';
import type {
  ActiveUser,
  CreateProjectRequest,
  CreateProjectResponse,
  GetProjectByIdResponse,
  ListProjectsRequest,
  ListProjectsResponse,
  Project as ProjectDto,
  UpdateProjectRequest,
  UpdateProjectResponse,
} from '@pkg/contracts';
import type { Project } from '@pkg/database';
import { k } from '@pkg/locales';
import { ProjectRepository } from './project.repository';

@Injectable()
export class ProjectService {
  constructor(
    private readonly projectRepository: ProjectRepository,
    @InjectLogger() private readonly logger: PinoLogger,
  ) {}

  async create(activeUser: ActiveUser, dto: CreateProjectRequest): Promise<CreateProjectResponse> {
    const created = await this.projectRepository.create({
      orgId: activeUser.orgId,
      name: dto.name,
      context: dto.context,
      repoUrl: dto.repoUrl,
      defaultBranch: dto.defaultBranch,
      workdir: dto.workdir,
      createdBy: activeUser.userId,
    });

    this.logger.info({ projectId: created.id, name: created.name }, 'Project created');

    return this.serialize(created);
  }

  async list(activeUser: ActiveUser, dto: ListProjectsRequest): Promise<ListProjectsResponse> {
    const { data, total } = await this.projectRepository.findForOrg(activeUser.orgId, {
      skip: dto.skip,
      limit: dto.limit,
    });

    return {
      data: data.map((p) => this.serialize(p)),
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
    const { id, ...patch } = dto;
    const updated = await this.projectRepository.update(id, activeUser.orgId, patch);
    if (!updated) {
      throw new NotFoundException(k.tasks.errors.projectNotFound);
    }
    return this.serialize(updated);
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
