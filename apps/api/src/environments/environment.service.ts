import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  computeAutoDeployPaused,
  dataPlaneUnitName,
  derivePublicPort,
  DeploymentProducer,
  EnvironmentProvisionProducer,
  InjectLogger,
  PinoLogger,
  SecretsService,
} from '@pkg/server';
import { k } from '@pkg/locales';
import type {
  ActiveUser,
  CreateEnvironmentRequest,
  DeleteEnvironmentRequest,
  DeleteEnvVarRequest,
  DeployEnvironmentRequest,
  Deployment as DeploymentDto,
  Environment as EnvironmentDto,
  ListEnvironmentsResponse,
  ProvisionEnvironmentRequest,
  SetEnvVarRequest,
  UpdateEnvironmentRequest,
} from '@pkg/contracts';
import type { Deployment, Project, Server } from '@pkg/database';
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
    private readonly provisioner: EnvironmentProvisionProducer,
    private readonly deployments: DeploymentProducer,
    @InjectLogger() private readonly logger: PinoLogger,
  ) {}

  async list(activeUser: ActiveUser, projectId: string): Promise<ListEnvironmentsResponse> {
    const proj = await this.getProjectOrThrow(projectId, activeUser.orgId);
    const rows = await this.environmentRepository.findForProject(projectId, activeUser.orgId);
    return { data: await Promise.all(rows.map((r) => this.serialize(r, proj.name))) };
  }

  async create(activeUser: ActiveUser, dto: CreateEnvironmentRequest): Promise<EnvironmentDto> {
    await this.getWritableProjectOrThrow(dto.projectId, activeUser.orgId);
    const srv = await this.assertAppServer(dto.serverId, activeUser.orgId);

    // Creation stays fast; provisioning is async. Auto-enqueue only when the
    // server can actually host the data plane.
    const autoProvision = serverRoles(srv).includes('data');
    let createdId: string;
    try {
      const created = await this.environmentRepository.create({
        projectId: dto.projectId,
        name: dto.name,
        serverId: dto.serverId,
        domain: dto.domain,
        deployPath: dto.deployPath,
        autoDeploy: dto.autoDeploy ?? false,
        ...(autoProvision ? { provisionStatus: 'provisioning' } : {}),
      });
      createdId = created.id;
    } catch (error) {
      if (isNameCollision(error)) {
        throw new BadRequestException(k.environments.errors.nameTaken);
      }
      throw error;
    }
    if (autoProvision) await this.provisioner.enqueueProvision(createdId);

    this.logger.info({ projectId: dto.projectId, name: dto.name }, 'Environment created');
    return this.getById(activeUser, dto.projectId, createdId);
  }

  /** Explicit (re-)provision: sets the status and hands off to the worker. */
  async provision(activeUser: ActiveUser, dto: ProvisionEnvironmentRequest): Promise<EnvironmentDto> {
    await this.getWritableProjectOrThrow(dto.projectId, activeUser.orgId);
    const existing = await this.findOrThrow(dto.id, dto.projectId, activeUser.orgId);
    // Fast feedback at the API; the worker re-validates before acting.
    const srv = await this.environmentRepository.findServer(existing.serverId, activeUser.orgId);
    if (!srv || !serverRoles(srv).includes('data')) {
      throw new BadRequestException(k.environments.errors.serverNotData);
    }
    await this.environmentRepository.update(dto.id, dto.projectId, {
      provisionStatus: 'provisioning',
      provisionError: null,
    });
    await this.provisioner.enqueueProvision(dto.id);
    return this.getById(activeUser, dto.projectId, dto.id);
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

  /**
   * Deploy the default branch's HEAD: creates the deployment record and
   * hands off to the worker. Requires a provisioned environment and a
   * build-capable server in the org. No agent surface exposes this.
   */
  async deploy(activeUser: ActiveUser, dto: DeployEnvironmentRequest): Promise<EnvironmentDto> {
    await this.getWritableProjectOrThrow(dto.projectId, activeUser.orgId);
    const existing = await this.findOrThrow(dto.id, dto.projectId, activeUser.orgId);
    if (existing.provisionStatus !== 'provisioned') {
      throw new BadRequestException(k.environments.errors.notProvisioned);
    }
    const buildServer = await this.environmentRepository.findBuildServer(activeUser.orgId);
    if (!buildServer) {
      throw new BadRequestException(k.environments.errors.noBuildServer);
    }
    const created = await this.environmentRepository.createDeployment({
      environmentId: existing.id,
      sha: '',
      status: 'queued',
      trigger: 'manual',
      createdBy: activeUser.userId,
    });
    await this.deployments.enqueueDeploy(created.id);
    this.logger.info({ environmentId: existing.id, deploymentId: created.id }, 'Deploy enqueued');
    return this.getById(activeUser, dto.projectId, dto.id);
  }

  async delete(activeUser: ActiveUser, dto: DeleteEnvironmentRequest): Promise<void> {
    const proj = await this.getWritableProjectOrThrow(dto.projectId, activeUser.orgId);
    const existing = await this.findOrThrow(dto.id, dto.projectId, activeUser.orgId);
    // Snapshot BEFORE the row disappears; teardown is best-effort by design —
    // a dead server never makes an environment undeletable.
    if (existing.provisionStatus !== 'unprovisioned') {
      await this.provisioner.enqueueDeprovision(
        existing.serverId,
        dataPlaneUnitName(proj.name, existing.name),
      );
    }
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
    const [proj, found] = await Promise.all([
      this.getProjectOrThrow(projectId, activeUser.orgId),
      this.findOrThrow(id, projectId, activeUser.orgId),
    ]);
    return this.serialize(found, proj.name);
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
  private async assertAppServer(serverId: string, orgId: string): Promise<Server> {
    const found = await this.environmentRepository.findServer(serverId, orgId);
    if (!found) throw new NotFoundException(k.servers.errors.notFound);
    if (!serverRoles(found).includes('app')) {
      throw new BadRequestException(k.environments.errors.serverNotApp);
    }
    return found;
  }

  private openUserEnv(sealed: string | null): Record<string, string> {
    if (!sealed) return {};
    return JSON.parse(this.secrets.open(sealed)) as Record<string, string>;
  }

  private serializeDeployment(d: Deployment): DeploymentDto {
    return {
      id: d.id,
      environmentId: d.environmentId,
      sha: d.sha,
      status: d.status as DeploymentDto['status'],
      trigger: d.trigger as DeploymentDto['trigger'],
      error: d.error,
      startedAt: d.startedAt?.toISOString() ?? null,
      finishedAt: d.finishedAt?.toISOString() ?? null,
      createdBy: d.createdBy,
      createdAt: d.createdAt.toISOString(),
    };
  }

  /**
   * The ONLY outward shape. userEnvEnc never leaves; user vars appear as a
   * sorted name list — a test walks every endpoint response proving no value
   * survives serialization.
   */
  private async serialize(e: EnvironmentWithServer, projectName: string): Promise<EnvironmentDto> {
    const recent = await this.environmentRepository.recentDeployments(e.id);
    const latest = recent[0] ?? null;
    const publicUrl =
      latest?.status === 'healthy'
        ? `http://${e.serverHost}:${derivePublicPort(dataPlaneUnitName(projectName, e.name))}`
        : null;
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
      provisionStatus: e.provisionStatus as EnvironmentDto['provisionStatus'],
      provisionError: e.provisionError,
      provisionedAt: e.provisionedAt?.toISOString() ?? null,
      latestDeployment: latest ? this.serializeDeployment(latest) : null,
      autoDeployPaused: computeAutoDeployPaused(recent),
      publicUrl,
      createdAt: e.createdAt.toISOString(),
      updatedAt: e.updatedAt.toISOString(),
    };
  }
}

const serverRoles = (srv: Server): string[] => (Array.isArray(srv.roles) ? (srv.roles as string[]) : []);
