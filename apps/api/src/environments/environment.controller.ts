import { Controller, Delete, Get, Patch, Post, Put } from '@nestjs/common';
import { ActiveUser, Permissions, ZodRequest } from '@pkg/server';
import {
  CreateEnvironmentRequestSchema,
  DeleteEnvironmentRequestSchema,
  DeleteEnvVarRequestSchema,
  ListEnvironmentsRequestSchema,
  SetEnvVarRequestSchema,
  UpdateEnvironmentRequestSchema,
  type ActiveUser as ActiveUserType,
  type CreateEnvironmentRequest,
  type CreateEnvironmentResponse,
  type DeleteEnvironmentRequest,
  type DeleteEnvironmentResponse,
  type DeleteEnvVarRequest,
  type DeleteEnvVarResponse,
  type ListEnvironmentsRequest,
  type ListEnvironmentsResponse,
  type SetEnvVarRequest,
  type SetEnvVarResponse,
  type UpdateEnvironmentRequest,
  type UpdateEnvironmentResponse,
} from '@pkg/contracts';
import { EnvironmentService } from './environment.service';

@Controller('projects/:projectId/environments')
export class EnvironmentController {
  constructor(private readonly environmentService: EnvironmentService) {}

  @Get()
  @Permissions('project:read')
  async list(
    @ZodRequest(ListEnvironmentsRequestSchema) dto: ListEnvironmentsRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<ListEnvironmentsResponse> {
    return this.environmentService.list(activeUser, dto.projectId);
  }

  @Post()
  @Permissions('project:update')
  async create(
    @ZodRequest(CreateEnvironmentRequestSchema) dto: CreateEnvironmentRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<CreateEnvironmentResponse> {
    return this.environmentService.create(activeUser, dto);
  }

  @Patch(':id')
  @Permissions('project:update')
  async update(
    @ZodRequest(UpdateEnvironmentRequestSchema) dto: UpdateEnvironmentRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<UpdateEnvironmentResponse> {
    return this.environmentService.update(activeUser, dto);
  }

  @Delete(':id')
  @Permissions('project:update')
  async delete(
    @ZodRequest(DeleteEnvironmentRequestSchema) dto: DeleteEnvironmentRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<DeleteEnvironmentResponse> {
    await this.environmentService.delete(activeUser, dto);
    return {};
  }

  /** Set-or-replace is a PUT: the var's value is written, never readable back. */
  @Put(':id/env/:name')
  @Permissions('project:update')
  async setEnvVar(
    @ZodRequest(SetEnvVarRequestSchema) dto: SetEnvVarRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<SetEnvVarResponse> {
    return this.environmentService.setEnvVar(activeUser, dto);
  }

  @Delete(':id/env/:name')
  @Permissions('project:update')
  async deleteEnvVar(
    @ZodRequest(DeleteEnvVarRequestSchema) dto: DeleteEnvVarRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<DeleteEnvVarResponse> {
    return this.environmentService.deleteEnvVar(activeUser, dto);
  }
}
