import { BadRequestException } from '@nestjs/common';
import type { ActiveUser } from '@pkg/contracts';
import { FakeLogger } from '@pkg/testing';
import type { PinoLogger } from 'nestjs-pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectService } from '@/tasks/project.service.js';
import type { ProjectRepository } from '@/tasks/project.repository.js';
import type { ProjectMemberRepository } from '@/tasks/project-member.repository.js';
import type { OrgService } from '@/org/org.service.js';
import type { GithubAppService } from '@pkg/server';
import type { TaskService } from '@/tasks/task.service.js';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const actor: ActiveUser = { userId: 'u', orgId: ORG_A, orgRole: 'ADMIN', systemRole: 'USER' };

const NEW_REPO = {
  id: 99,
  fullName: 'valmonto/new-product',
  htmlUrl: 'https://github.com/valmonto/new-product',
  private: true,
  defaultBranch: 'main',
};

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'p1',
  orgId: ORG_A,
  name: 'New Product',
  context: null,
  repoUrl: null,
  githubRepoId: null,
  githubRepoFullName: null,
  defaultBranch: 'main',
  workdir: null,
  createdBy: 'u',
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

describe('ProjectService — repo provisioning', () => {
  let repository: Record<string, ReturnType<typeof vi.fn>>;
  let orgService: { githubConnection: ReturnType<typeof vi.fn> };
  let github: {
    enabled: boolean;
    templateRepo: string | null;
    getInstallation: ReturnType<typeof vi.fn>;
    listRepositories: ReturnType<typeof vi.fn>;
    createProjectRepo: ReturnType<typeof vi.fn>;
    applyProtectionRuleset: ReturnType<typeof vi.fn>;
    populateFromTemplate: ReturnType<typeof vi.fn>;
  };
  let taskService: { create: ReturnType<typeof vi.fn> };
  let service: ProjectService;

  beforeEach(() => {
    repository = {
      create: vi.fn().mockImplementation((data: Record<string, unknown>) => row(data)),
      update: vi.fn().mockImplementation((_id, _org, data: Record<string, unknown>) => row(data)),
      findById: vi.fn().mockResolvedValue(row({ githubRepoId: 99 })),
    };
    orgService = {
      githubConnection: vi
        .fn()
        .mockResolvedValue({ installationId: 777, templateRepo: 'valmonto/valmatic' }),
    };
    github = {
      enabled: true,
      templateRepo: 'valmonto/valmatic',
      getInstallation: vi
        .fn()
        .mockResolvedValue({ id: 777, accountLogin: 'valmonto', canCreateRepos: true }),
      listRepositories: vi.fn().mockResolvedValue([NEW_REPO]),
      createProjectRepo: vi.fn().mockResolvedValue(NEW_REPO),
      applyProtectionRuleset: vi.fn().mockResolvedValue(undefined),
      populateFromTemplate: vi.fn().mockResolvedValue(undefined),
    };
    taskService = { create: vi.fn().mockResolvedValue({ id: 't1' }) };
    service = new ProjectService(
      repository as unknown as ProjectRepository,
      {} as unknown as ProjectMemberRepository,
      orgService as unknown as OrgService,
      github as unknown as GithubAppService,
      taskService as unknown as TaskService,
      new FakeLogger().as<PinoLogger>(),
    );
  });

  const dto = { name: 'New Product', newRepoName: 'new-product', newRepoFromTemplate: true };

  beforeEach(() => {
    // Grant-propagation polling is real time in production; tests shrink it.
    (service as unknown as { grantCheckDelayMs: number }).grantCheckDelayMs = 1;
  });

  it('creates, verifies grant, PROTECTS, binds, and files the init draft — in that order', async () => {
    const order: string[] = [];
    github.createProjectRepo.mockImplementation(async () => (order.push('create'), NEW_REPO));
    github.listRepositories.mockImplementation(async () => (order.push('grant'), [NEW_REPO]));
    github.applyProtectionRuleset.mockImplementation(async () => void order.push('protect'));
    repository.update!.mockImplementation(async (_i, _o, data) => (order.push('bind'), row(data)));
    taskService.create.mockImplementation(async () => (order.push('init-task'), { id: 't1' }));

    await service.create(actor, dto);

    expect(order).toEqual(['create', 'grant', 'protect', 'bind', 'init-task']);
    expect(github.createProjectRepo).toHaveBeenCalledWith(777, {
      owner: 'valmonto',
      name: 'new-product',
      templateFullName: 'valmonto/valmatic',
    });
    expect(repository.update).toHaveBeenCalledWith(
      'p1',
      ORG_A,
      expect.objectContaining({
        githubRepoId: 99,
        githubRepoFullName: 'valmonto/new-product',
        repoUrl: 'https://github.com/valmonto/new-product',
      }),
    );
    // Init task lands as a DRAFT via the same TaskService the humans use.
    expect(taskService.create).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({ projectId: 'p1' }),
    );
  });

  it('provisioning is refused without the Administration grant — project stays unbound', async () => {
    github.getInstallation.mockResolvedValue({
      id: 777,
      accountLogin: 'valmonto',
      canCreateRepos: false,
    });
    await expect(service.create(actor, dto)).rejects.toBeInstanceOf(BadRequestException);
    expect(repository.create).toHaveBeenCalled(); // the project row exists…
    expect(repository.update).not.toHaveBeenCalled(); // …but nothing was bound
    expect(github.createProjectRepo).not.toHaveBeenCalled();
  });

  it('GitHub refusing the creation surfaces an error and leaves the project unbound', async () => {
    github.createProjectRepo.mockRejectedValue(new Error('422 name taken'));
    await expect(service.create(actor, dto)).rejects.toBeInstanceOf(BadRequestException);
    expect(repository.update).not.toHaveBeenCalled();
    expect(github.applyProtectionRuleset).not.toHaveBeenCalled();
  });

  it('a duplicate repo name gets its own message — the one failure the user fixes themselves', async () => {
    github.createProjectRepo.mockRejectedValue(
      Object.assign(new Error('422'), {
        response: {
          status: 422,
          data: { errors: [{ message: 'name already exists on this account' }] },
        },
      }),
    );
    await expect(service.create(actor, dto)).rejects.toThrow('tasks.errors.repoNameTaken');
  });

  it("any other refusal carries GitHub's own words as detail", async () => {
    github.createProjectRepo.mockRejectedValue(
      Object.assign(new Error('403'), {
        response: { status: 403, data: { message: 'Resource not accessible by integration' } },
      }),
    );
    const err = await service.create(actor, dto).catch((e: BadRequestException) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getResponse()).toMatchObject({
      message: 'tasks.errors.repoProvisionFailed',
      detail: 'GitHub: Resource not accessible by integration',
    });
  });

  it('a project name collision maps the unique-index violation, not a 500', async () => {
    repository.create!.mockRejectedValue(
      Object.assign(new Error('duplicate key'), {
        cause: { code: '23505', constraint: 'project_org_name_active_uq' },
      }),
    );
    await expect(service.create(actor, { name: 'New Product' })).rejects.toThrow(
      'tasks.errors.projectNameTaken',
    );
  });

  it('a repo that did not land in the grant is an error state, never bound', async () => {
    github.listRepositories.mockResolvedValue([]); // grant check comes back empty
    const err = await service.create(actor, dto).catch((e: BadRequestException) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    // The repo name rides along as detail so the UI can guide the grant.
    expect((err as BadRequestException).getResponse()).toMatchObject({
      detail: 'valmonto/new-product',
    });
    expect(repository.update).not.toHaveBeenCalled();
    // The check polled, not one-shot.
    expect(github.listRepositories.mock.calls.length).toBeGreaterThan(1);
  });

  it('grant propagation is polled: a repo that appears on the third look still binds', async () => {
    github.listRepositories
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValue([NEW_REPO]);
    await service.create(actor, dto);
    expect(repository.update).toHaveBeenCalled();
  });

  it('adopts the half-generated repo when /generate creates it and then dies on its clone step', async () => {
    // GitHub's generate: repo gets created, THEN the internal clone fails —
    // so the blank fallback collides on the name. That collision must adopt
    // the leftover repo (matched by name in the grant), never report a
    // bogus repoNameTaken.
    github.createProjectRepo
      .mockRejectedValueOnce(
        Object.assign(new Error('403'), {
          response: {
            status: 403,
            data: { message: 'Could not clone: Cloning user does not have permission' },
          },
        }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error('422'), {
          response: {
            status: 422,
            data: { errors: [{ message: 'name already exists on this account' }] },
          },
        }),
      );
    github.listRepositories.mockResolvedValue([NEW_REPO]); // grant knows it by name
    await service.create(actor, dto);
    expect(repository.update).toHaveBeenCalledWith(
      'p1',
      ORG_A,
      expect.objectContaining({ githubRepoId: NEW_REPO.id }),
    );
    // The adopted (empty) repo gets the server-side template push.
    expect(github.populateFromTemplate).toHaveBeenCalledWith(
      777,
      'valmonto/valmatic',
      NEW_REPO.fullName,
      'main',
    );
    const initTask = taskService.create.mock.calls[0]![1] as { context: string };
    expect(initTask.context).toContain('generated from the template');
  });

  it('an adopted repo that never reaches the grant surfaces the guided not-granted error', async () => {
    github.createProjectRepo
      .mockRejectedValueOnce(
        Object.assign(new Error('403'), {
          response: { status: 403, data: { message: 'Could not clone' } },
        }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error('422'), {
          response: {
            status: 422,
            data: { errors: [{ message: 'name already exists on this account' }] },
          },
        }),
      );
    github.listRepositories.mockResolvedValue([]);
    const err = await service.create(actor, dto).catch((e: BadRequestException) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getResponse()).toMatchObject({
      message: 'tasks.errors.repoProvisionNotGranted',
      detail: 'valmonto/new-product',
    });
  });

  it('a refused template generation falls back to a blank repo that the server then populates', async () => {
    github.createProjectRepo
      .mockRejectedValueOnce(
        Object.assign(new Error('403'), {
          response: { status: 403, data: { message: 'Could not clone' } },
        }),
      )
      .mockResolvedValue(NEW_REPO);
    await service.create(actor, dto);
    // Second call is the bare fallback; populate covers the content.
    expect(github.createProjectRepo.mock.calls[1]![1]).toMatchObject({ templateFullName: null });
    expect(github.populateFromTemplate).toHaveBeenCalled();
    expect(repository.update).toHaveBeenCalled();
  });

  it('a failed populate degrades to instructions on the init task, never a dead end', async () => {
    github.createProjectRepo
      .mockRejectedValueOnce(
        Object.assign(new Error('403'), {
          response: { status: 403, data: { message: 'Could not clone' } },
        }),
      )
      .mockResolvedValue(NEW_REPO);
    github.populateFromTemplate.mockRejectedValue(new Error('git push failed'));
    await service.create(actor, dto);
    expect(repository.update).toHaveBeenCalled(); // still bound
    const initTask = taskService.create.mock.calls[0]![1] as { context: string };
    expect(initTask.context).toContain('EMPTY');
    expect(initTask.context).toContain('valmonto/valmatic');
  });

  it('populate runs BEFORE the protection ruleset — PRs-only would block the initial push', async () => {
    await service.create(actor, dto);
    const populateOrder = github.populateFromTemplate.mock.invocationCallOrder[0]!;
    const protectOrder = github.applyProtectionRuleset.mock.invocationCallOrder[0]!;
    expect(populateOrder).toBeLessThan(protectOrder);
  });

  it('completeProvisioning finishes a stalled run: populate, protect, bind, init task', async () => {
    repository.findById = vi.fn().mockResolvedValue(row({ id: 'p1', githubRepoId: null }));
    const taskList = vi.fn().mockResolvedValue({ data: [], meta: { total: 0, skip: 0, limit: 1 } });
    (taskService as unknown as { list: typeof taskList }).list = taskList;
    const result = await service.completeProvisioning(actor, {
      id: 'p1',
      githubRepoId: NEW_REPO.id,
      fromTemplate: true,
    });
    expect(github.populateFromTemplate).toHaveBeenCalled();
    expect(github.applyProtectionRuleset).toHaveBeenCalled();
    expect(repository.update).toHaveBeenCalledWith(
      'p1',
      ORG_A,
      expect.objectContaining({ githubRepoId: NEW_REPO.id }),
    );
    expect(taskService.create).toHaveBeenCalled(); // init task filed
    expect(result.id).toBeDefined();
  });

  it('completeProvisioning on an already-bound project only re-attempts the populate', async () => {
    repository.findById = vi.fn().mockResolvedValue(row({ id: 'p1', githubRepoId: NEW_REPO.id }));
    await service.completeProvisioning(actor, {
      id: 'p1',
      githubRepoId: NEW_REPO.id,
      fromTemplate: true,
    });
    expect(github.populateFromTemplate).toHaveBeenCalled();
    expect(github.applyProtectionRuleset).not.toHaveBeenCalled();
    expect(repository.update).not.toHaveBeenCalled();
    expect(taskService.create).not.toHaveBeenCalled();
  });

  it('protection is best-effort: a refused ruleset still binds, and the init task says so', async () => {
    // GitHub's free plan refuses rulesets on private repos — a plan
    // limitation must not dead-end provisioning.
    github.applyProtectionRuleset.mockRejectedValue(
      Object.assign(new Error('403'), {
        response: { status: 403, data: { message: 'Upgrade to GitHub Team' } },
      }),
    );
    await service.create(actor, dto);
    expect(repository.update).toHaveBeenCalled(); // bound despite the refusal
    const initTask = taskService.create.mock.calls[0]![1] as { context: string };
    expect(initTask.context).toContain('UNPROTECTED');
    expect(initTask.context).toContain('Upgrade to GitHub Team');
  });

  it('no template chosen → still provisions, bare', async () => {
    orgService.githubConnection.mockResolvedValue({ installationId: 777, templateRepo: null });
    await service.create(actor, dto);
    expect(github.createProjectRepo).toHaveBeenCalledWith(
      777,
      expect.objectContaining({ templateFullName: null }),
    );
  });

  it('two-tenant: provisioning resolves the connection from the ACTOR org only', async () => {
    await service.create(actor, dto);
    expect(orgService.githubConnection).toHaveBeenCalledWith(ORG_A);
    expect(orgService.githubConnection).toHaveBeenCalledTimes(1);
  });
});
