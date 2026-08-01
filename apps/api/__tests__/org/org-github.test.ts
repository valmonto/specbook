import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { IamService } from '@pkg/server';
import type { ActiveUser } from '@pkg/contracts';
import { FakeLogger } from '@pkg/testing';
import type { PinoLogger } from 'nestjs-pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OrgService } from '@/org/org.service';
import type { OrgRepository } from '@/org/org.repository';
import type { GithubAppService } from '@/github/github-app.service';

const ORG = '11111111-1111-4111-8111-111111111111';
const actor: ActiveUser = { userId: 'u', orgId: ORG, orgRole: 'ADMIN', systemRole: 'USER' };

const CONNECTION = {
  installationId: 777,
  accountLogin: 'valmonto',
  connectedAt: new Date('2026-08-01T12:00:00Z'),
};

const REPO = {
  id: 42,
  fullName: 'valmonto/specbook',
  htmlUrl: 'https://github.com/valmonto/specbook',
  private: true,
  defaultBranch: 'main',
};

describe('OrgService — GitHub connection', () => {
  let repository: Record<string, ReturnType<typeof vi.fn>>;
  let github: {
    enabled: boolean;
    templateRepo: string | null;
    installUrl: ReturnType<typeof vi.fn>;
    getInstallation: ReturnType<typeof vi.fn>;
    listRepositories: ReturnType<typeof vi.fn>;
  };
  let service: OrgService;

  beforeEach(() => {
    repository = {
      findGithubConnection: vi.fn().mockResolvedValue(CONNECTION),
      setGithubConnection: vi.fn().mockResolvedValue(undefined),
      clearGithubConnection: vi.fn().mockResolvedValue(undefined),
    };
    github = {
      enabled: true,
      templateRepo: 'valmonto/valmatic',
      installUrl: vi.fn().mockReturnValue('https://github.com/apps/valmonto-specbook/installations/new'),
      getInstallation: vi
        .fn()
        .mockResolvedValue({ id: 777, accountLogin: 'valmonto', canCreateRepos: true }),
      listRepositories: vi.fn().mockResolvedValue([REPO]),
    };
    service = new OrgService(
      repository as unknown as OrgRepository,
      {} as IamService,
      github as unknown as GithubAppService,
      new FakeLogger().as<PinoLogger>(),
    );
  });

  it('unconfigured deploy → well-formed empty status, no GitHub calls', async () => {
    github.enabled = false;
    const status = await service.getGithubStatus(actor, ORG);
    expect(status).toEqual({
      configured: false,
      installUrl: null,
      connected: false,
      accountLogin: null,
      connectedAt: null,
      repositories: [],
      canCreateRepos: false,
      templateRepo: null,
    });
    expect(repository.findGithubConnection).not.toHaveBeenCalled();
  });

  it('configured but not connected → install URL, no repos', async () => {
    repository.findGithubConnection!.mockResolvedValue(null);
    const status = await service.getGithubStatus(actor, ORG);
    expect(status.configured).toBe(true);
    expect(status.connected).toBe(false);
    expect(status.installUrl).toContain('/installations/new');
    expect(status.repositories).toEqual([]);
  });

  it('connected → account, timestamp and exactly the granted repos', async () => {
    const status = await service.getGithubStatus(actor, ORG);
    expect(status.connected).toBe(true);
    expect(status.accountLogin).toBe('valmonto');
    expect(status.repositories).toEqual([REPO]);
    expect(github.listRepositories).toHaveBeenCalledWith(777);
    // Provisioning surface: the installation's Administration grant + the
    // deploy's template, both surfaced for the project form.
    expect(status.canCreateRepos).toBe(true);
    expect(status.templateRepo).toBe('valmonto/valmatic');
  });

  it('an installation without Administration reports canCreateRepos false', async () => {
    github.getInstallation.mockResolvedValue({
      id: 777,
      accountLogin: 'valmonto',
      canCreateRepos: false,
    });
    const status = await service.getGithubStatus(actor, ORG);
    expect(status.connected).toBe(true);
    expect(status.canCreateRepos).toBe(false);
  });

  it('a failing repo listing degrades to connected-with-no-repos, not a 5xx', async () => {
    github.listRepositories.mockRejectedValue(new Error('installation revoked'));
    const status = await service.getGithubStatus(actor, ORG);
    expect(status.connected).toBe(true);
    expect(status.repositories).toEqual([]);
  });

  it('connect verifies the installation against GitHub before storing', async () => {
    await service.connectGithub(actor, { orgId: ORG, installationId: 777 });
    expect(github.getInstallation).toHaveBeenCalledWith(777);
    expect(repository.setGithubConnection).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ installationId: 777, accountLogin: 'valmonto' }),
    );
  });

  it('connect refuses an installation GitHub does not vouch for', async () => {
    github.getInstallation.mockResolvedValue(null);
    await expect(
      service.connectGithub(actor, { orgId: ORG, installationId: 999 }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(repository.setGithubConnection).not.toHaveBeenCalled();
  });

  it('connect refuses when the deploy has no App configured', async () => {
    github.enabled = false;
    await expect(
      service.connectGithub(actor, { orgId: ORG, installationId: 777 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('disconnect clears the stored connection', async () => {
    await service.disconnectGithub(actor, ORG);
    expect(repository.clearGithubConnection).toHaveBeenCalledWith(ORG);
  });
});
