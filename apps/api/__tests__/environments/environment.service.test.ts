import type { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import type { ActiveUser } from '@pkg/contracts';
import { SecretsService } from '@pkg/server';
import { FakeLogger } from '@pkg/testing';
import type { PinoLogger } from 'nestjs-pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EnvironmentService } from '@/environments/environment.service';
import type { EnvironmentRepository } from '@/environments/environment.repository';

const ORG = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const ENV = '33333333-3333-4333-8333-333333333333';
const SERVER = '44444444-4444-4444-8444-444444444444';
const actor: ActiveUser = { userId: 'u', orgId: ORG, orgRole: 'ADMIN', systemRole: 'USER' };

describe('EnvironmentService — layered env vars, secrets write-only by construction', () => {
  let secrets: SecretsService;
  let repository: Record<string, ReturnType<typeof vi.fn>>;
  let service: EnvironmentService;
  /** The mutable "database row" the fake repository serves and updates. */
  let stored: Record<string, unknown>;

  const projectRow = (overrides: Record<string, unknown> = {}) => ({
    id: PROJECT,
    orgId: ORG,
    archivedAt: null,
    ...overrides,
  });

  const envRow = () => ({
    id: ENV,
    projectId: PROJECT,
    name: 'staging',
    serverId: SERVER,
    serverName: 'hetzner-1',
    domain: 'staging.example.com',
    deployPath: '/srv/app',
    autoDeploy: false,
    platformEnv: { DATABASE_URL: 'postgres://visible' },
    userEnvEnc: null,
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
    };
    service = new EnvironmentService(
      repository as unknown as EnvironmentRepository,
      secrets,
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
});
