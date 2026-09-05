import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  generateSshKeypair,
  InjectLogger,
  PinoLogger,
  SecretsService,
  ServerCheckProducer,
} from '@pkg/server';
import { k } from '@pkg/locales';
import type {
  ActiveUser,
  CreateServerRequest,
  CreateServerResponse,
  ListServersRequest,
  ListServersResponse,
  Server as ServerDto,
  UpdateServerRequest,
} from '@pkg/contracts';
import type { Server } from '@pkg/database';
import { ServerRepository } from './server.repository.js';
import { EnvironmentRepository } from '../environments/environment.repository.js';
import type { HostedEnvironment, ServerEnvironmentsResponse } from '@pkg/contracts';
import { dataPlaneUnitName } from '@pkg/server';

const NAME_UNIQUE_INDEX = 'server_org_name_uq';

/** Postgres 23505 on the name index, however deep the driver wraps it. */
function isNameCollision(error: unknown): boolean {
  for (
    let e = error as
      | { code?: string; constraint?: string; constraint_name?: string; cause?: unknown }
      | undefined;
    e;
    e = e.cause as typeof e
  ) {
    if (
      e.code === '23505' &&
      (e.constraint === NAME_UNIQUE_INDEX || e.constraint_name === NAME_UNIQUE_INDEX)
    ) {
      return true;
    }
  }
  return false;
}

@Injectable()
export class ServerService {
  constructor(
    private readonly serverRepository: ServerRepository,
    private readonly environments: EnvironmentRepository,
    private readonly secrets: SecretsService,
    private readonly checks: ServerCheckProducer,
    @InjectLogger() private readonly logger: PinoLogger,
  ) {}

  /**
   * Registration GENERATES the credential: an ed25519 keypair whose private
   * half is sealed before it touches the database and whose public half is
   * what the human installs into authorized_keys. No key is ever accepted
   * FROM the client and none is ever returned to it.
   */
  async create(activeUser: ActiveUser, dto: CreateServerRequest): Promise<CreateServerResponse> {
    const keypair = generateSshKeypair(`specbook:${dto.name}`);

    let created: Server;
    try {
      created = await this.serverRepository.create({
        orgId: activeUser.orgId,
        name: dto.name,
        host: dto.host,
        port: dto.port,
        sshUser: dto.sshUser,
        roles: dto.roles,
        publicKey: keypair.publicKey,
        privateKeyEnc: this.secrets.seal(keypair.privateKey),
        createdBy: activeUser.userId,
      });
    } catch (error) {
      if (isNameCollision(error)) {
        throw new BadRequestException(k.servers.errors.nameTaken);
      }
      throw error;
    }

    this.logger.info({ serverId: created.id, host: created.host }, 'Server registered');
    return this.serialize(created);
  }

  async list(activeUser: ActiveUser, dto: ListServersRequest): Promise<ListServersResponse> {
    const { data, total } = await this.serverRepository.findForOrg(activeUser.orgId, {
      skip: dto.skip,
      limit: dto.limit,
    });
    return {
      data: data.map((s) => this.serialize(s)),
      meta: { total, skip: dto.skip, limit: dto.limit },
    };
  }

  async getById(activeUser: ActiveUser, id: string): Promise<ServerDto> {
    const found = await this.serverRepository.findById(id, activeUser.orgId);
    if (!found) throw new NotFoundException(k.servers.errors.notFound);
    return this.serialize(found);
  }

  /**
   * Every environment that uses this server, with the roles it plays for each
   * and — when it hosts the database — the Postgres database name (the unit).
   * The reuse already works per server; this is where it becomes visible.
   */
  async hostedEnvironments(
    activeUser: ActiveUser,
    serverId: string,
  ): Promise<ServerEnvironmentsResponse> {
    const srv = await this.serverRepository.findById(serverId, activeUser.orgId);
    if (!srv) throw new NotFoundException(k.servers.errors.notFound);
    const rows = await this.environments.findHostedBy(serverId, activeUser.orgId);
    const data: HostedEnvironment[] = rows.map((r) => {
      const roles: HostedEnvironment['roles'] = [];
      if (r.serverId === serverId) roles.push('app');
      // A NULL placement means the app server hosts that role (legacy `data`).
      const hostsDatabase = r.databaseServerId
        ? r.databaseServerId === serverId
        : r.serverId === serverId;
      const hostsCache = r.cacheServerId ? r.cacheServerId === serverId : r.serverId === serverId;
      const hostsStorage = r.storageServerId === serverId;
      if (hostsDatabase) roles.push('database');
      if (hostsCache) roles.push('cache');
      if (hostsStorage) roles.push('storage');
      return {
        environmentId: r.environmentId,
        environmentName: r.environmentName,
        projectId: r.projectId,
        projectName: r.projectName,
        roles,
        databaseName: hostsDatabase ? dataPlaneUnitName(r.projectName, r.environmentName) : null,
        provisionStatus: r.provisionStatus,
      };
    });
    return { data };
  }

  async update(activeUser: ActiveUser, dto: UpdateServerRequest): Promise<ServerDto> {
    const { id, ...patch } = dto;
    // Host/port/user changes invalidate the pinned fingerprint on purpose:
    // a "new" machine must re-earn trust on the next check.
    const resetsPin = patch.host !== undefined || patch.port !== undefined;
    let updated: Server | null;
    try {
      updated = await this.serverRepository.update(id, activeUser.orgId, {
        ...patch,
        ...(resetsPin ? { hostFingerprint: null, status: 'unverified' } : {}),
      });
    } catch (error) {
      if (isNameCollision(error)) {
        throw new BadRequestException(k.servers.errors.nameTaken);
      }
      throw error;
    }
    if (!updated) throw new NotFoundException(k.servers.errors.notFound);
    return this.serialize(updated);
  }

  async delete(activeUser: ActiveUser, id: string): Promise<void> {
    const deleted = await this.serverRepository.delete(id, activeUser.orgId);
    if (!deleted) throw new NotFoundException(k.servers.errors.notFound);
    this.logger.info({ serverId: id }, 'Server deleted');
  }

  /** Enqueue a reachability check; the worker writes the result to the row. */
  async test(activeUser: ActiveUser, id: string): Promise<ServerDto> {
    const found = await this.serverRepository.findById(id, activeUser.orgId);
    if (!found) throw new NotFoundException(k.servers.errors.notFound);
    await this.checks.enqueueCheck(found.id);
    return this.serialize(found);
  }

  /**
   * The ONLY outward shape. privateKeyEnc is stripped here, structurally —
   * a test walks every endpoint response asserting no key material leaks.
   */
  private serialize(s: Server): ServerDto {
    return {
      id: s.id,
      orgId: s.orgId,
      name: s.name,
      host: s.host,
      port: s.port,
      sshUser: s.sshUser,
      roles: s.roles as ServerDto['roles'],
      publicKey: s.publicKey,
      hostFingerprint: s.hostFingerprint,
      status: s.status as ServerDto['status'],
      lastCheckedAt: s.lastCheckedAt?.toISOString() ?? null,
      createdBy: s.createdBy,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
    };
  }
}
