import { Controller, Delete, Get, Patch, Post, Put } from '@nestjs/common';
import { ActiveUser, Permissions, ZodRequest } from '@pkg/server';
import {
  BulkSetEnvVarsRequestSchema,
  CreateEnvironmentRequestSchema,
  DeleteEnvironmentRequestSchema,
  DeleteEnvVarRequestSchema,
  DeployEnvironmentRequestSchema,
  ListEnvironmentsRequestSchema,
  ProvisionEnvironmentRequestSchema,
  RevealEnvVarsRequestSchema,
  SetEnvVarRequestSchema,
  UpdateEnvironmentRequestSchema,
  type ActiveUser as ActiveUserType,
  type BulkSetEnvVarsRequest,
  type BulkSetEnvVarsResponse,
  type CreateEnvironmentRequest,
  type CreateEnvironmentResponse,
  type DeleteEnvironmentRequest,
  type DeleteEnvironmentResponse,
  type DeleteEnvVarRequest,
  type DeleteEnvVarResponse,
  type DeployEnvironmentRequest,
  type DeployEnvironmentResponse,
  type ListEnvironmentsRequest,
  type ListEnvironmentsResponse,
  type ProvisionEnvironmentRequest,
  type ProvisionEnvironmentResponse,
  type RevealEnvVarsRequest,
  type RevealEnvVarsResponse,
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

  /** Enqueues the data-plane job; the worker writes the result to the row. */
  @Post(':id/provision')
  @Permissions('project:update')
  async provision(
    @ZodRequest(ProvisionEnvironmentRequestSchema) dto: ProvisionEnvironmentRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<ProvisionEnvironmentResponse> {
    return this.environmentService.provision(activeUser, dto);
  }

  /** Build+deploy the default branch's HEAD; the worker writes progress to the row. */
  @Post(':id/deploy')
  @Permissions('project:update')
  async deploy(
    @ZodRequest(DeployEnvironmentRequestSchema) dto: DeployEnvironmentRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<DeployEnvironmentResponse> {
    return this.environmentService.deploy(activeUser, dto);
  }

  /**
   * Reveal CONFIG values (secrets are never included). Static 'reveal'
   * declared before ':name' — Nest matches top-down.
   */
  @Get(':id/env/reveal')
  @Permissions('project:update')
  async revealEnvVars(
    @ZodRequest(RevealEnvVarsRequestSchema) dto: RevealEnvVarsRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<RevealEnvVarsResponse> {
    return this.environmentService.revealEnvVars(activeUser, dto);
  }

  /** Atomically replace the whole user-var set (add/rename/delete in one save). */
  @Put(':id/env')
  @Permissions('project:update')
  async bulkSetEnvVars(
    @ZodRequest(BulkSetEnvVarsRequestSchema) dto: BulkSetEnvVarsRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<BulkSetEnvVarsResponse> {
    return this.environmentService.bulkSetEnvVars(activeUser, dto);
  }

  /** Set-or-replace is a PUT: writes one var's value; only config is readable back. */
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
