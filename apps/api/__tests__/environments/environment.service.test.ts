import type { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import type { ActiveUser } from '@pkg/contracts';
import { SecretsService } from '@pkg/server';
import { FakeLogger } from '@pkg/testing';
import type { PinoLogger } from 'nestjs-pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeploymentProducer, EnvironmentProvisionProducer } from '@pkg/server';
import { EnvironmentService } from '@/environments/environment.service';
import type { EnvironmentRepository } from '@/environments/environment.repository';

const ORG = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const ENV = '33333333-3333-4333-8333-333333333333';
const SERVER = '44444444-4444-4444-8444-444444444444';
const DEPLOYMENT = '55555555-5555-4555-8555-555555555555';
const actor: ActiveUser = { userId: 'u', orgId: ORG, orgRole: 'ADMIN', systemRole: 'USER' };

describe('EnvironmentService — layered env vars, secrets write-only by construction', () => {
  let secrets: SecretsService;
  let repository: Record<string, ReturnType<typeof vi.fn>>;
  let provisioner: Record<string, ReturnType<typeof vi.fn>>;
  let deployer: Record<string, ReturnType<typeof vi.fn>>;
  let service: EnvironmentService;
  /** The mutable "database row" the fake repository serves and updates. */
  let stored: Record<string, unknown>;

  const projectRow = (overrides: Record<string, unknown> = {}) => ({
    id: PROJECT,
    orgId: ORG,
    name: 'The Project',
    archivedAt: null,
    ...overrides,
  });

  const envRow = () => ({
    id: ENV,
    projectId: PROJECT,
    name: 'staging',
    serverId: SERVER,
    serverName: 'hetzner-1',
    serverHost: 'h.example.com',
    domain: 'staging.example.com',
    deployPath: '/srv/app',
    autoDeploy: false,
    platformEnv: { DATABASE_URL: 'postgres://visible' },
    userEnvEnc: null,
    provisionStatus: 'unprovisioned',
    provisionError: null,
    provisionedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...stored,
  });

  beforeEach(() => {
    stored = {};
    secrets = new SecretsService({
      get: () => randomBytes(32).toString('base64'),
    } as unknown as ConfigService);
    repository = {
      findProject: vi.fn().mockResolvedValue(projectRow()),
      findServer: vi.fn().mockResolvedValue({ id: SERVER, orgId: ORG, roles: ['app'] }),
      findForProject: vi.fn().mockImplementation(() => [envRow()]),
      findById: vi.fn().mockImplementation(() => envRow()),
      create: vi.fn().mockImplementation((data: Record<string, unknown>) => {
        stored = { ...stored, ...data };
        return envRow();
      }),
      update: vi.fn().mockImplementation((_id, _project, data: Record<string, unknown>) => {
        stored = { ...stored, ...data };
        return envRow();
      }),
      delete: vi.fn().mockResolvedValue(true),
      recentDeployments: vi.fn().mockResolvedValue([]),
      createDeployment: vi.fn().mockImplementation((data: Record<string, unknown>) => ({
        id: DEPLOYMENT,
        environmentId: ENV,
        sha: '',
        status: 'queued',
        error: null,
        startedAt: null,
        finishedAt: null,
        createdBy: 'u',
        createdAt: new Date(),
        ...data,
      })),
      findBuildServer: vi.fn().mockResolvedValue({ id: SERVER, orgId: ORG, roles: ['build', 'app', 'data'] }),
      findDomainClaim: vi.fn().mockResolvedValue(null),
    };
    provisioner = {
      enqueueProvision: vi.fn().mockResolvedValue(undefined),
      enqueueDeprovision: vi.fn().mockResolvedValue(undefined),
    };
    deployer = { enqueueDeploy: vi.fn().mockResolvedValue(undefined) };
    service = new EnvironmentService(
      repository as unknown as EnvironmentRepository,
      secrets,
      provisioner as unknown as EnvironmentProvisionProducer,
      deployer as unknown as DeploymentProducer,
      new FakeLogger().as<PinoLogger>(),
    );
  });

  const createDto = { projectId: PROJECT, name: 'staging' as const, serverId: SERVER };

  it('create requires the server to hold the app role', async () => {
    repository.findServer!.mockResolvedValue({ id: SERVER, orgId: ORG, roles: ['build'] });
    await expect(service.create(actor, createDto)).rejects.toThrow(
      'environments.errors.serverNotApp',
    );
  });

  it("create refuses a server the org does not own — another org's id reads as absent", async () => {
    repository.findServer!.mockResolvedValue(null);
    await expect(service.create(actor, createDto)).rejects.toThrow('servers.errors.notFound');
  });

  it('archived projects are readonly: every write path refuses', async () => {
    repository.findProject!.mockResolvedValue(projectRow({ archivedAt: new Date() }));
    const readonlyError = 'tasks.errors.projectArchivedReadonly';
    await expect(service.create(actor, createDto)).rejects.toThrow(readonlyError);
    await expect(
      service.update(actor, { projectId: PROJECT, id: ENV, domain: 'x.dev' }),
    ).rejects.toThrow(readonlyError);
    await expect(service.delete(actor, { projectId: PROJECT, id: ENV })).rejects.toThrow(
      readonlyError,
    );
    await expect(
      service.setEnvVar(actor, { projectId: PROJECT, id: ENV, name: 'API_KEY', value: 's3cret' }),
    ).rejects.toThrow(readonlyError);
    await expect(
      service.deleteEnvVar(actor, { projectId: PROJECT, id: ENV, name: 'API_KEY' }),
    ).rejects.toThrow(readonlyError);
    // ...while reading stays open.
    await expect(service.list(actor, PROJECT)).resolves.toBeDefined();
  });

  it('setEnvVar seals the value; the name becomes listable, sorted', async () => {
    await service.setEnvVar(actor, { projectId: PROJECT, id: ENV, name: 'ZED', value: 'last' });
    const res = await service.setEnvVar(actor, {
      projectId: PROJECT,
      id: ENV,
      name: 'API_KEY',
      value: 'hunter2',
    });
    expect(res.userEnvNames).toEqual(['API_KEY', 'ZED']);
    expect(String(stored.userEnvEnc)).toMatch(/^v1:/);
    expect(String(stored.userEnvEnc)).not.toContain('hunter2');
  });

  it('deleteEnvVar removes the name; deleting the last one clears the sealed blob', async () => {
    await service.setEnvVar(actor, { projectId: PROJECT, id: ENV, name: 'API_KEY', value: 'x' });
    const res = await service.deleteEnvVar(actor, { projectId: PROJECT, id: ENV, name: 'API_KEY' });
    expect(res.userEnvNames).toEqual([]);
    expect(stored.userEnvEnc).toBeNull();
  });

  it('deleting an unknown var is a notFound, not a silent no-op', async () => {
    await expect(
      service.deleteEnvVar(actor, { projectId: PROJECT, id: ENV, name: 'NOPE' }),
    ).rejects.toThrow('environments.errors.varNotFound');
  });

  it('no response from any surface carries a secret value or sealed blob', async () => {
    await service.setEnvVar(actor, { projectId: PROJECT, id: ENV, name: 'API_KEY', value: 'hunter2' });
    const responses = [
      await service.list(actor, PROJECT),
      await service.create(actor, createDto),
      await service.update(actor, { projectId: PROJECT, id: ENV, domain: 'new.example.com' }),
      await service.setEnvVar(actor, { projectId: PROJECT, id: ENV, name: 'OTHER', value: 'swordfish' }),
      await service.deleteEnvVar(actor, { projectId: PROJECT, id: ENV, name: 'OTHER' }),
    ];
    const flat = JSON.stringify(responses);
    expect(flat).not.toContain('userEnvEnc');
    expect(flat).not.toContain('v1:');
    expect(flat).not.toContain('hunter2');
    expect(flat).not.toContain('swordfish');
    // platform_env stays fully visible — it is wiring, not a secret.
    expect(flat).toContain('postgres://visible');
  });

  it('name collisions map to the translation key, not a 500', async () => {
    repository.create!.mockRejectedValue(
      Object.assign(new Error('dup'), {
        cause: { code: '23505', constraint_name: 'project_environment_project_name_uq' },
      }),
    );
    await expect(service.create(actor, createDto)).rejects.toThrow('environments.errors.nameTaken');
  });

  it('create on a data-role server auto-enqueues provisioning; without it, none', async () => {
    repository.findServer!.mockResolvedValue({ id: SERVER, orgId: ORG, roles: ['app', 'data'] });
    await service.create(actor, createDto);
    expect(provisioner.enqueueProvision).toHaveBeenCalledWith(ENV);
    const created = repository.create!.mock.calls[0]![0] as Record<string, unknown>;
    expect(created.provisionStatus).toBe('provisioning');

    provisioner.enqueueProvision!.mockClear();
    stored = {};
    repository.findServer!.mockResolvedValue({ id: SERVER, orgId: ORG, roles: ['app'] });
    await service.create(actor, createDto);
    expect(provisioner.enqueueProvision).not.toHaveBeenCalled();
  });

  it('provision refuses a server without the data role — distinct error', async () => {
    repository.findServer!.mockResolvedValue({ id: SERVER, orgId: ORG, roles: ['app'] });
    await expect(service.provision(actor, { projectId: PROJECT, id: ENV })).rejects.toThrow(
      'environments.errors.serverNotData',
    );
    expect(provisioner.enqueueProvision).not.toHaveBeenCalled();
  });

  it('provision marks the row provisioning, clears the last error, and enqueues', async () => {
    repository.findServer!.mockResolvedValue({ id: SERVER, orgId: ORG, roles: ['app', 'data'] });
    stored = { provisionStatus: 'failed', provisionError: 'boom' };
    await service.provision(actor, { projectId: PROJECT, id: ENV });
    expect(repository.update).toHaveBeenCalledWith(ENV, PROJECT, {
      provisionStatus: 'provisioning',
      provisionError: null,
    });
    expect(provisioner.enqueueProvision).toHaveBeenCalledWith(ENV);
  });

  it('provision respects the archived-readonly guard', async () => {
    repository.findProject!.mockResolvedValue(projectRow({ archivedAt: new Date() }));
    await expect(service.provision(actor, { projectId: PROJECT, id: ENV })).rejects.toThrow(
      'tasks.errors.projectArchivedReadonly',
    );
  });

  it('delete of a provisioned environment enqueues teardown from a pre-delete snapshot', async () => {
    stored = { provisionStatus: 'provisioned' };
    await service.delete(actor, { projectId: PROJECT, id: ENV });
    expect(provisioner.enqueueDeprovision).toHaveBeenCalledWith(SERVER, 'the_project_staging');
    expect(repository.delete).toHaveBeenCalled();
  });

  it('delete of a never-provisioned environment skips teardown entirely', async () => {
    await service.delete(actor, { projectId: PROJECT, id: ENV });
    expect(provisioner.enqueueDeprovision).not.toHaveBeenCalled();
  });

  it('deploy refuses an unprovisioned environment', async () => {
    await expect(service.deploy(actor, { projectId: PROJECT, id: ENV })).rejects.toThrow(
      'environments.errors.notProvisioned',
    );
    expect(deployer.enqueueDeploy).not.toHaveBeenCalled();
  });

  it('deploy refuses when the org has no build-capable server', async () => {
    stored = { provisionStatus: 'provisioned' };
    repository.findBuildServer!.mockResolvedValue(null);
    await expect(service.deploy(actor, { projectId: PROJECT, id: ENV })).rejects.toThrow(
      'environments.errors.noBuildServer',
    );
  });

  it('deploy respects the archived-readonly guard', async () => {
    repository.findProject!.mockResolvedValue(projectRow({ archivedAt: new Date() }));
    await expect(service.deploy(actor, { projectId: PROJECT, id: ENV })).rejects.toThrow(
      'tasks.errors.projectArchivedReadonly',
    );
  });

  it('deploy records the run attributed to the session and enqueues the worker job', async () => {
    stored = { provisionStatus: 'provisioned' };
    await service.deploy(actor, { projectId: PROJECT, id: ENV });
    expect(repository.createDeployment).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: ENV, status: 'queued', createdBy: 'u' }),
    );
    expect(deployer.enqueueDeploy).toHaveBeenCalledWith(DEPLOYMENT);
  });

  it('a healthy latest deployment yields the public staging URL; otherwise null', async () => {
    stored = { provisionStatus: 'provisioned' };
    const healthy = {
      id: DEPLOYMENT, environmentId: ENV, sha: 'abc1234', status: 'healthy', trigger: 'manual', error: null,
      startedAt: new Date(), finishedAt: new Date(), createdBy: 'u', createdAt: new Date(),
    };
    repository.recentDeployments!.mockResolvedValue([healthy]);
    const [env] = (await service.list(actor, PROJECT)).data;
    expect(env!.publicUrl).toMatch(/^http:\/\/h\.example\.com:2\d{4}$/);
    expect(env!.latestDeployment?.sha).toBe('abc1234');

    repository.recentDeployments!.mockResolvedValue([{ ...healthy, status: 'failed' }]);
    const [failed] = (await service.list(actor, PROJECT)).data;
    expect(failed!.publicUrl).toBeNull();
  });

  it('two failed auto-deploys surface autoDeployPaused; a success clears it', async () => {
    const failedAuto = {
      id: DEPLOYMENT, environmentId: ENV, sha: 'x', status: 'failed', trigger: 'auto', error: 'boom',
      startedAt: new Date(), finishedAt: new Date(), createdBy: 'u', createdAt: new Date(),
    };
    repository.recentDeployments!.mockResolvedValue([failedAuto, failedAuto]);
    let [env] = (await service.list(actor, PROJECT)).data;
    expect(env!.autoDeployPaused).toBe(true);

    repository.recentDeployments!.mockResolvedValue([
      { ...failedAuto, status: 'healthy' },
      failedAuto,
      failedAuto,
    ]);
    [env] = (await service.list(actor, PROJECT)).data;
    expect(env!.autoDeployPaused).toBe(false);
  });

  it('manual deploys record trigger=manual; create passes the autoDeploy flag through', async () => {
    stored = { provisionStatus: 'provisioned' };
    await service.deploy(actor, { projectId: PROJECT, id: ENV });
    expect(repository.createDeployment).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: 'manual' }),
    );
    stored = {};
    await service.create(actor, { ...createDto, autoDeploy: true });
    expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ autoDeploy: true }));
  });

  it('a domain another environment claims on the same server is refused; your own claim is not', async () => {
    repository.findDomainClaim!.mockResolvedValue({ id: 'other-env' });
    await expect(
      service.create(actor, { ...createDto, domain: 'stg.example.com' }),
    ).rejects.toThrow('environments.errors.domainTaken');
    await expect(
      service.update(actor, { projectId: PROJECT, id: ENV, domain: 'stg.example.com' }),
    ).rejects.toThrow('environments.errors.domainTaken');

    // The environment re-saving its own domain must not collide with itself.
    repository.findDomainClaim!.mockResolvedValue({ id: ENV });
    await expect(
      service.update(actor, { projectId: PROJECT, id: ENV, domain: 'stg.example.com' }),
    ).resolves.toBeDefined();
  });

  it('a healthy deploy with a domain snapshot serves https and clears domainPending', async () => {
    stored = { provisionStatus: 'provisioned' };
    const healthy = {
      id: DEPLOYMENT, environmentId: ENV, sha: 'abc1234', status: 'healthy', trigger: 'manual', error: null,
      domain: 'staging.example.com',
      startedAt: new Date(), finishedAt: new Date(), createdBy: 'u', createdAt: new Date(),
    };
    repository.recentDeployments!.mockResolvedValue([healthy]);
    const [live] = (await service.list(actor, PROJECT)).data;
    expect(live!.publicUrl).toBe('https://staging.example.com');
    expect(live!.domainPending).toBe(false);

    // The row's domain changed after that deploy: the OLD domain stays live,
    // the edit reads as pending until the next deploy.
    stored = { provisionStatus: 'provisioned', domain: 'renamed.example.com' };
    const [pending] = (await service.list(actor, PROJECT)).data;
    expect(pending!.publicUrl).toBe('https://staging.example.com');
    expect(pending!.domainPending).toBe(true);

    // No healthy run at all: a set domain is pending by definition.
    repository.recentDeployments!.mockResolvedValue([]);
    const [never] = (await service.list(actor, PROJECT)).data;
    expect(never!.publicUrl).toBeNull();
    expect(never!.domainPending).toBe(true);
  });

  it('the provision response leaks no credentials beyond platform_env wiring', async () => {
    repository.findServer!.mockResolvedValue({ id: SERVER, orgId: ORG, roles: ['app', 'data'] });
    const res = await service.provision(actor, { projectId: PROJECT, id: ENV });
    const flat = JSON.stringify(res);
    expect(flat).not.toContain('userEnvEnc');
    expect(flat).not.toContain('dataRootEnvEnc');
    expect(flat).not.toContain('v1:');
    expect(res.provisionStatus).toBe('provisioning');
  });
});
