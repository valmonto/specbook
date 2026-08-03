import { Controller, Delete, Get, Patch, Post } from '@nestjs/common';
import { ActiveUser, Permissions, ZodRequest } from '@pkg/server';
import {
  ArchiveProjectRequestSchema,
  CompleteProvisionRequestSchema,
  CreateProjectRequestSchema,
  DeleteProjectRequestSchema,
  GetProjectByIdRequestSchema,
  ListProjectsRequestSchema,
  UpdateProjectRequestSchema,
  type ActiveUser as ActiveUserType,
  type ArchiveProjectRequest,
  type ArchiveProjectResponse,
  type CompleteProvisionRequest,
  type CompleteProvisionResponse,
  type CreateProjectRequest,
  type CreateProjectResponse,
  type DeleteProjectRequest,
  type DeleteProjectResponse,
  type GetProjectByIdRequest,
  type GetProjectByIdResponse,
  type ListProjectsRequest,
  type ListProjectsResponse,
  type UpdateProjectRequest,
  type UpdateProjectResponse,
} from '@pkg/contracts';
import { ProjectService } from './project.service';

@Controller('projects')
export class ProjectController {
  constructor(private readonly projectService: ProjectService) {}

  @Get()
  @Permissions('project:list')
  async list(
    @ZodRequest(ListProjectsRequestSchema) dto: ListProjectsRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<ListProjectsResponse> {
    return this.projectService.list(activeUser, dto);
  }

  @Post()
  @Permissions('project:create')
  async create(
    @ZodRequest(CreateProjectRequestSchema) dto: CreateProjectRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<CreateProjectResponse> {
    return this.projectService.create(activeUser, dto);
  }

  @Get(':id')
  @Permissions('project:read')
  async getById(
    @ZodRequest(GetProjectByIdRequestSchema) dto: GetProjectByIdRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<GetProjectByIdResponse> {
    return this.projectService.getById(activeUser, dto.id);
  }

  @Patch(':id')
  @Permissions('project:update')
  async update(
    @ZodRequest(UpdateProjectRequestSchema) dto: UpdateProjectRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<UpdateProjectResponse> {
    return this.projectService.update(activeUser, dto);
  }

  // Finishes a provisioning that stalled on the installation grant: after
  // the human ticks the repo on GitHub, this populates (template), protects,
  // binds and files the init task the aborted run never created.
  @Post(':id/provision/complete')
  @Permissions('project:update')
  async completeProvision(
    @ZodRequest(CompleteProvisionRequestSchema) dto: CompleteProvisionRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<CompleteProvisionResponse> {
    return this.projectService.completeProvisioning(activeUser, dto);
  }

  // Archive sits behind project:delete — it is the destructive-adjacent
  // action (retire from every active surface), even though nothing is lost.
  @Post(':id/archive')
  @Permissions('project:delete')
  async archive(
    @ZodRequest(ArchiveProjectRequestSchema) dto: ArchiveProjectRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<ArchiveProjectResponse> {
    return this.projectService.archive(activeUser, dto.id);
  }

  @Post(':id/unarchive')
  @Permissions('project:delete')
  async unarchive(
    @ZodRequest(ArchiveProjectRequestSchema) dto: ArchiveProjectRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<ArchiveProjectResponse> {
    return this.projectService.unarchive(activeUser, dto.id);
  }

  @Delete(':id')
  @Permissions('project:delete')
  async delete(
    @ZodRequest(DeleteProjectRequestSchema) dto: DeleteProjectRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<DeleteProjectResponse> {
    await this.projectService.delete(activeUser, dto.id);
    return {};
  }
}
