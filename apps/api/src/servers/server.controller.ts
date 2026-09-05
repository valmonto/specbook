import { Controller, Delete, Get, Patch, Post } from '@nestjs/common';
import { ActiveUser, Permissions, ZodRequest } from '@pkg/server';
import {
  CreateServerRequestSchema,
  DeleteServerRequestSchema,
  GetServerByIdRequestSchema,
  ListServersRequestSchema,
  TestServerRequestSchema,
  UpdateServerRequestSchema,
  type ActiveUser as ActiveUserType,
  type CreateServerRequest,
  type CreateServerResponse,
  type DeleteServerRequest,
  type DeleteServerResponse,
  type GetServerByIdRequest,
  type GetServerByIdResponse,
  type ListServersRequest,
  type ListServersResponse,
  type TestServerRequest,
  type TestServerResponse,
  type UpdateServerRequest,
  type UpdateServerResponse,
} from '@pkg/contracts';
import { ServerService } from './server.service.js';

@Controller('servers')
export class ServerController {
  constructor(private readonly serverService: ServerService) {}

  @Get()
  @Permissions('settings:read')
  async list(
    @ZodRequest(ListServersRequestSchema) dto: ListServersRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<ListServersResponse> {
    return this.serverService.list(activeUser, dto);
  }

  @Post()
  @Permissions('settings:update')
  async create(
    @ZodRequest(CreateServerRequestSchema) dto: CreateServerRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<CreateServerResponse> {
    return this.serverService.create(activeUser, dto);
  }

  @Get(':id')
  @Permissions('settings:read')
  async getById(
    @ZodRequest(GetServerByIdRequestSchema) dto: GetServerByIdRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<GetServerByIdResponse> {
    return this.serverService.getById(activeUser, dto.id);
  }

  @Patch(':id')
  @Permissions('settings:update')
  async update(
    @ZodRequest(UpdateServerRequestSchema) dto: UpdateServerRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<UpdateServerResponse> {
    return this.serverService.update(activeUser, dto);
  }

  @Post(':id/test')
  @Permissions('settings:update')
  async test(
    @ZodRequest(TestServerRequestSchema) dto: TestServerRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<TestServerResponse> {
    return this.serverService.test(activeUser, dto.id);
  }

  @Delete(':id')
  @Permissions('settings:update')
  async delete(
    @ZodRequest(DeleteServerRequestSchema) dto: DeleteServerRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<DeleteServerResponse> {
    await this.serverService.delete(activeUser, dto.id);
    return {};
  }
}
