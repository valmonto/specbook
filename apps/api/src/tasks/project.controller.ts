import { Controller, Delete, Get, Patch, Post } from '@nestjs/common';
import { ActiveUser, Permissions, ZodRequest } from '@pkg/server';
import {
  CreateProjectRequestSchema,
  DeleteProjectRequestSchema,
  GetProjectByIdRequestSchema,
  ListProjectsRequestSchema,
  UpdateProjectRequestSchema,
  type ActiveUser as ActiveUserType,
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
