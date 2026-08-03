import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectLogger, PinoLogger, SecretsService } from '@pkg/server';
import { k } from '@pkg/locales';
import type {
  ActiveUser,
  CreateEnvironmentRequest,
  DeleteEnvironmentRequest,
  DeleteEnvVarRequest,
  Environment as EnvironmentDto,
  ListEnvironmentsResponse,
  SetEnvVarRequest,
  UpdateEnvironmentRequest,
} from '@pkg/contracts';
import type { Project } from '@pkg/database';
import { EnvironmentRepository, type EnvironmentWithServer } from './environment.repository';

const NAME_UNIQUE_INDEX = 'project_environment_project_name_uq';

/** Postgres 23505 on the (project, name) index, however deep the driver wraps it. */
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
export class EnvironmentService {
  constructor(
    private readonly environmentRepository: EnvironmentRepository,
    private readonly secrets: SecretsService,
    @InjectLogger() private readonly logger: PinoLogger,
  ) {}

  async list(activeUser: ActiveUser, projectId: string): Promise<ListEnvironmentsResponse> {
    await this.getProjectOrThrow(projectId, activeUser.orgId);
    const rows = await this.environmentRepository.findForProject(projectId, activeUser.orgId);
    return { data: rows.map((r) => this.serialize(r)) };
  }

  async create(activeUser: ActiveUser, dto: CreateEnvironmentRequest): Promise<EnvironmentDto> {
    await this.getWritableProjectOrThrow(dto.projectId, activeUser.orgId);
    await this.assertAppServer(dto.serverId, activeUser.orgId);

    let createdId: string;
    try {
      const created = await this.environmentRepository.create({
        projectId: dto.projectId,
        name: dto.name,
        serverId: dto.serverId,
        domain: dto.domain,
        deployPath: dto.deployPath,
      });
      createdId = created.id;
    } catch (error) {
      if (isNameCollision(error)) {
        throw new BadRequestException(k.environments.errors.nameTaken);
      }
      throw error;
    }

    this.logger.info({ projectId: dto.projectId, name: dto.name }, 'Environment created');
    return this.getById(activeUser, dto.projectId, createdId);
  }

  async update(activeUser: ActiveUser, dto: UpdateEnvironmentRequest): Promise<EnvironmentDto> {
    await this.getWritableProjectOrThrow(dto.projectId, activeUser.orgId);
    const existing = await this.findOrThrow(dto.id, dto.projectId, activeUser.orgId);
    if (dto.serverId !== undefined && dto.serverId !== existing.serverId) {
      await this.assertAppServer(dto.serverId, activeUser.orgId);
    }

    const { projectId, id, ...patch } = dto;
    let updated;
    try {
      updated = await this.environmentRepository.update(id, projectId, patch);
    } catch (error) {
      if (isNameCollision(error)) {
        throw new BadRequestException(k.environments.errors.nameTaken);
      }
      throw error;
    }
    if (!updated) throw new NotFoundException(k.environments.errors.notFound);
    return this.getById(activeUser, projectId, id);
  }

  async delete(activeUser: ActiveUser, dto: DeleteEnvironmentRequest): Promise<void> {
    await this.getWritableProjectOrThrow(dto.projectId, activeUser.orgId);
    await this.findOrThrow(dto.id, dto.projectId, activeUser.orgId);
    await this.environmentRepository.delete(dto.id, dto.projectId);
    this.logger.info({ environmentId: dto.id }, 'Environment deleted');
  }

  /**
   * Set (create or replace) one user env var. The value goes INTO the sealed
   * map and never comes back out — every return path serializes names only.
   */
  async setEnvVar(activeUser: ActiveUser, dto: SetEnvVarRequest): Promise<EnvironmentDto> {
    await this.getWritableProjectOrThrow(dto.projectId, activeUser.orgId);
    const existing = await this.findOrThrow(dto.id, dto.projectId, activeUser.orgId);

    const map = this.openUserEnv(existing.userEnvEnc);
    map[dto.name] = dto.value;
    await this.environmentRepository.update(dto.id, dto.projectId, {
      userEnvEnc: this.secrets.seal(JSON.stringify(map)),
    });
    this.logger.info({ environmentId: dto.id, name: dto.name }, 'User env var set');
    return this.getById(activeUser, dto.projectId, dto.id);
  }

  async deleteEnvVar(activeUser: ActiveUser, dto: DeleteEnvVarRequest): Promise<EnvironmentDto> {
    await this.getWritableProjectOrThrow(dto.projectId, activeUser.orgId);
    const existing = await this.findOrThrow(dto.id, dto.projectId, activeUser.orgId);

    const map = this.openUserEnv(existing.userEnvEnc);
    if (!(dto.name in map)) {
      throw new NotFoundException(k.environments.errors.varNotFound);
    }
    delete map[dto.name];
    await this.environmentRepository.update(dto.id, dto.projectId, {
      userEnvEnc: Object.keys(map).length ? this.secrets.seal(JSON.stringify(map)) : null,
    });
    this.logger.info({ environmentId: dto.id, name: dto.name }, 'User env var deleted');
    return this.getById(activeUser, dto.projectId, dto.id);
  }

  private async getById(
    activeUser: ActiveUser,
    projectId: string,
    id: string,
  ): Promise<EnvironmentDto> {
    const found = await this.findOrThrow(id, projectId, activeUser.orgId);
    return this.serialize(found);
  }

  private async findOrThrow(
    id: string,
    projectId: string,
    orgId: string,
  ): Promise<EnvironmentWithServer> {
    const found = await this.environmentRepository.findById(id, projectId, orgId);
    if (!found) throw new NotFoundException(k.environments.errors.notFound);
    return found;
  }

  private async getProjectOrThrow(projectId: string, orgId: string): Promise<Project> {
    const found = await this.environmentRepository.findProject(projectId, orgId);
    if (!found) throw new NotFoundException(k.tasks.errors.projectNotFound);
    return found;
  }

  /** Archived projects are readonly — environments included. */
  private async getWritableProjectOrThrow(projectId: string, orgId: string): Promise<Project> {
    const found = await this.getProjectOrThrow(projectId, orgId);
    if (found.archivedAt) {
      throw new BadRequestException(k.tasks.errors.projectArchivedReadonly);
    }
    return found;
  }

  /** An environment's server must be the org's own and hold the 'app' role. */
  private async assertAppServer(serverId: string, orgId: string): Promise<void> {
    const found = await this.environmentRepository.findServer(serverId, orgId);
    if (!found) throw new NotFoundException(k.servers.errors.notFound);
    const roles = Array.isArray(found.roles) ? (found.roles as string[]) : [];
    if (!roles.includes('app')) {
      throw new BadRequestException(k.environments.errors.serverNotApp);
    }
  }

  private openUserEnv(sealed: string | null): Record<string, string> {
    if (!sealed) return {};
    return JSON.parse(this.secrets.open(sealed)) as Record<string, string>;
  }

  /**
   * The ONLY outward shape. userEnvEnc never leaves; user vars appear as a
   * sorted name list — a test walks every endpoint response proving no value
   * survives serialization.
   */
  private serialize(e: EnvironmentWithServer): EnvironmentDto {
    return {
      id: e.id,
      projectId: e.projectId,
      name: e.name as EnvironmentDto['name'],
      serverId: e.serverId,
      serverName: e.serverName,
      domain: e.domain,
      deployPath: e.deployPath,
      autoDeploy: e.autoDeploy,
      platformEnv: (e.platformEnv ?? {}) as Record<string, string>,
      userEnvNames: Object.keys(this.openUserEnv(e.userEnvEnc)).sort(),
      createdAt: e.createdAt.toISOString(),
      updatedAt: e.updatedAt.toISOString(),
    };
  }
}
