import { Controller, Delete, Get, Patch, Post } from '@nestjs/common';
import { ActiveUser, Permissions, ZodRequest } from '@pkg/server';
import {
  CreateServerRequestSchema,
  DeleteServerRequestSchema,
  GetServerByIdRequestSchema,
  ListServersRequestSchema,
  ServerEnvironmentsRequestSchema,
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
  type ServerEnvironmentsRequest,
  type ServerEnvironmentsResponse,
  type TestServerRequest,
  type TestServerResponse,
  type UpdateServerRequest,
  type UpdateServerResponse,
} from '@pkg/contracts';
import { ServerService } from './server.service.js';
import { ServerShellService } from './server-shell.service.js';

@Controller('servers')
export class ServerController {
  constructor(
    private readonly serverService: ServerService,
    private readonly shells: ServerShellService,
  ) {}

  /**
   * Open a browser shell window on this server and mint the ticket its socket
   * will redeem.
   *
   * `server:shell` rather than `settings:update`: that permission edits a
   * server ROW, this one runs arbitrary commands ON the server. It is granted
   * to OWNER alone. This route is also where authorization for the WebSocket
   * happens — the socket itself only redeems the ticket, because Nest runs
   * gateway guards per message rather than per connection.
   */
  @Post(':id/shell')
  @Permissions('server:shell')
  async openShell(
    @ZodRequest(GetServerByIdRequestSchema) dto: GetServerByIdRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<{ sessionId: string; ticket: string; expiresAt: string }> {
    const issued = await this.shells.issue(activeUser, dto.id);
    return {
      sessionId: issued.sessionId,
      ticket: issued.ticket,
      expiresAt: issued.expiresAt.toISOString(),
    };
  }

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

  /** The shared-instance view: every environment using this server, and for which role. */
  @Get(':id/environments')
  @Permissions('settings:read')
  async environments(
    @ZodRequest(ServerEnvironmentsRequestSchema) dto: ServerEnvironmentsRequest,
    @ActiveUser() activeUser: ActiveUserType,
  ): Promise<ServerEnvironmentsResponse> {
    return this.serverService.hostedEnvironments(activeUser, dto.id);
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
