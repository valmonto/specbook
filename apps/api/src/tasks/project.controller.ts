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
  ResumeProjectRequestSchema,
  type ResumeProjectRequest,
  type ResumeProjectResponse,
  type UpdateProjectRequest,
  type UpdateProjectResponse,
  GrantProjectAccessRequestSchema,
  ListProjectMembersRequestSchema,
  RevokeProjectAccessRequestSchema,
  type GrantProjectAccessRequest,
  type GrantProjectAccessResponse,
  type ListProjectMembersRequest,
  type ListProjectMembersResponse,
  type RevokeProjectAccessRequest,
  type RevokeProjectAccessResponse,
} from '@pkg/contracts';
import { ProjectService } from './project.service.js';

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

  // Resume is the human override for the auto-mode breaker: the automatic
  // clear (a green default-branch run) cannot fire on repos whose default
  // branch runs no workflow, so a pause there would otherwise be permanent.
  @Post(':id/resume')
  @Permissions('project:update')
  async resume(
    @ZodRequest(ResumeProjectRequestSchema) dto: ResumeProjectRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<ResumeProjectResponse> {
    return this.projectService.resume(activeUser, dto.id);
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

  // --- Per-project visibility ACL (owner/admin only) ---
  // Specbook's OWN visibility plane; the returned githubReminder REFLECTS the
  // need to add a repo collaborator but never grants it.

  @Get(':id/members')
  @Permissions('project:grant-access')
  async listMembers(
    @ZodRequest(ListProjectMembersRequestSchema) dto: ListProjectMembersRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<ListProjectMembersResponse> {
    return this.projectService.listMembers(activeUser, dto.id);
  }

  @Post(':id/members')
  @Permissions('project:grant-access')
  async grantAccess(
    @ZodRequest(GrantProjectAccessRequestSchema) dto: GrantProjectAccessRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<GrantProjectAccessResponse> {
    return this.projectService.grantAccess(activeUser, dto.id, dto.userId);
  }

  @Delete(':id/members/:userId')
  @Permissions('project:grant-access')
  async revokeAccess(
    @ZodRequest(RevokeProjectAccessRequestSchema) dto: RevokeProjectAccessRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<RevokeProjectAccessResponse> {
    return this.projectService.revokeAccess(activeUser, dto.id, dto.userId);
  }
}
