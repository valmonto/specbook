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

const ORG = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const actor: ActiveUser = { userId: 'u', orgId: ORG, orgRole: 'ADMIN', systemRole: 'USER' };

const REPO = {
  id: 42,
  fullName: 'valmonto/specbook',
  htmlUrl: 'https://github.com/valmonto/specbook',
  private: true,
  defaultBranch: 'develop',
};

const row = (overrides: Record<string, unknown> = {}) => ({
  id: PROJECT,
  orgId: ORG,
  name: 'p',
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

describe('ProjectService — GitHub repo binding', () => {
  let repository: Record<string, ReturnType<typeof vi.fn>>;
  let orgService: { githubConnection: ReturnType<typeof vi.fn> };
  let github: { enabled: boolean; listRepositories: ReturnType<typeof vi.fn> };
  let service: ProjectService;

  beforeEach(() => {
    repository = {
      create: vi.fn().mockImplementation((data: Record<string, unknown>) => row(data)),
      update: vi
        .fn()
        .mockImplementation((_id: string, _org: string, data: Record<string, unknown>) =>
          row(data),
        ),
      // update() reads the project first — the archive boundary guard.
      findById: vi.fn().mockResolvedValue(row({ archivedAt: null })),
    };
    orgService = { githubConnection: vi.fn().mockResolvedValue({ installationId: 777 }) };
    github = { enabled: true, listRepositories: vi.fn().mockResolvedValue([REPO]) };
    service = new ProjectService(
      repository as unknown as ProjectRepository,
      {} as unknown as ProjectMemberRepository,
      orgService as unknown as OrgService,
      github as unknown as GithubAppService,
      { create: vi.fn() } as unknown as TaskService,
      new FakeLogger().as<PinoLogger>(),
    );
  });

  it('create with a granted repo derives url, full name and default branch server-side', async () => {
    await service.create(actor, { name: 'p', githubRepoId: 42, repoUrl: 'https://evil.example' });

    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        githubRepoId: 42,
        githubRepoFullName: 'valmonto/specbook',
        // The binding's URL wins over whatever the client sent.
        repoUrl: 'https://github.com/valmonto/specbook',
        defaultBranch: 'develop',
      }),
    );
  });

  it('an explicit default branch beats the repo default', async () => {
    await service.create(actor, { name: 'p', githubRepoId: 42, defaultBranch: 'trunk' });
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({ defaultBranch: 'trunk' }),
    );
  });

  it('refuses a repo outside the installation grant', async () => {
    await expect(service.create(actor, { name: 'p', githubRepoId: 999 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(repository.create).not.toHaveBeenCalled();
  });

  it('refuses a binding when the org has no connection', async () => {
    orgService.githubConnection.mockResolvedValue(null);
    await expect(service.create(actor, { name: 'p', githubRepoId: 42 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('refuses a binding on an unconfigured deploy', async () => {
    github.enabled = false;
    await expect(service.create(actor, { name: 'p', githubRepoId: 42 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('create without a binding keeps the free-text URL path untouched', async () => {
    await service.create(actor, { name: 'p', repoUrl: 'https://example.com/repo' });
    expect(orgService.githubConnection).not.toHaveBeenCalled();
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({ repoUrl: 'https://example.com/repo', githubRepoId: undefined }),
    );
  });

  it('update rebinds through the same verification', async () => {
    await service.update(actor, { id: PROJECT, githubRepoId: 42 });
    expect(repository.update).toHaveBeenCalledWith(
      PROJECT,
      ORG,
      expect.objectContaining({
        githubRepoId: 42,
        githubRepoFullName: 'valmonto/specbook',
        repoUrl: 'https://github.com/valmonto/specbook',
      }),
    );
  });

  it('update with null clears the binding but keeps the URL', async () => {
    await service.update(actor, { id: PROJECT, githubRepoId: null });
    const data = repository.update!.mock.calls[0]![2] as Record<string, unknown>;
    expect(data.githubRepoId).toBeNull();
    expect(data.githubRepoFullName).toBeNull();
    expect('repoUrl' in data).toBe(false);
  });
});
