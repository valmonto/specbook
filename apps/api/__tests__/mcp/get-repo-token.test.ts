import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { ActiveUser } from '@pkg/contracts';
import { k } from '@pkg/locales';
import { FakeLogger } from '@pkg/testing';
import type { PinoLogger } from 'nestjs-pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentService } from '@/agents';
import { McpTools } from '@/mcp/mcp-tools';
import type { GithubAppService } from '@pkg/server';
import type { OrgService } from '@/org/org.service';
import type { ProjectService } from '@/tasks/project.service';
import type { TaskService } from '@/tasks/task.service';
import type { ResearchService } from '@/research/research.service';
import type { AttachmentsService } from '@/attachments/attachments.service';
import type { EnvironmentService } from '@/environments';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const PROJECT_A = '33333333-3333-4333-8333-333333333333';

const actorA: ActiveUser = { userId: 'ua', orgId: ORG_A, orgRole: 'MEMBER', systemRole: 'USER' };
const actorB: ActiveUser = { userId: 'ub', orgId: ORG_B, orgRole: 'MEMBER', systemRole: 'USER' };

const boundProject = {
  id: PROJECT_A,
  orgId: ORG_A,
  githubRepoId: 42,
  githubRepoFullName: 'valmonto/specbook',
};

describe('MCP get_repo_token', () => {
  let projectService: { getById: ReturnType<typeof vi.fn> };
  let orgService: { githubConnection: ReturnType<typeof vi.fn> };
  let github: { enabled: boolean; mintRepoToken: ReturnType<typeof vi.fn> };
  let handler: (args: Record<string, unknown>, actor: ActiveUser | null) => Promise<unknown>;

  beforeEach(() => {
    // Org-scoped exactly like the real ProjectService: the ACTOR's org keys
    // the lookup, so another org's projectId behaves as nonexistent.
    projectService = {
      getById: vi.fn().mockImplementation(async (actor: ActiveUser, id: string) => {
        if (actor.orgId !== boundProject.orgId || id !== boundProject.id) {
          throw new NotFoundException(k.tasks.errors.projectNotFound);
        }
        return boundProject;
      }),
    };
    orgService = { githubConnection: vi.fn().mockResolvedValue({ installationId: 777 }) };
    github = {
      enabled: true,
      mintRepoToken: vi
        .fn()
        .mockResolvedValue({ token: 'ghs_scoped', expiresAt: '2026-08-01T13:00:00Z' }),
    };

    const tools = new McpTools(
      orgService as unknown as OrgService,
      projectService as unknown as ProjectService,
      {} as TaskService,
      {} as ResearchService,
      {} as AttachmentsService,
      github as unknown as GithubAppService,
      {} as AgentService,
      {} as EnvironmentService,
      new FakeLogger().as<PinoLogger>(),
    );
    handler = tools.catalog().find((tool) => tool.name === 'get_repo_token')!.handler;
  });

  it('mints a token for the bound repo and derives the clone URL', async () => {
    await expect(handler({ projectId: PROJECT_A }, actorA)).resolves.toEqual({
      token: 'ghs_scoped',
      expiresAt: '2026-08-01T13:00:00Z',
      repoFullName: 'valmonto/specbook',
      cloneUrl: 'https://x-access-token:ghs_scoped@github.com/valmonto/specbook.git',
    });
    expect(github.mintRepoToken).toHaveBeenCalledWith(777, 'valmonto/specbook');
  });

  it('refuses on an unconfigured deploy without touching any service', async () => {
    github.enabled = false;
    await expect(handler({ projectId: PROJECT_A }, actorA)).rejects.toThrow(
      k.orgs.github.errors.notConfigured,
    );
    expect(projectService.getById).not.toHaveBeenCalled();
    expect(github.mintRepoToken).not.toHaveBeenCalled();
  });

  it('refuses when the project has no repo binding', async () => {
    projectService.getById.mockResolvedValue({
      ...boundProject,
      githubRepoId: null,
      githubRepoFullName: null,
    });
    await expect(handler({ projectId: PROJECT_A }, actorA)).rejects.toThrow(
      k.tasks.errors.projectNotBound,
    );
    expect(github.mintRepoToken).not.toHaveBeenCalled();
  });

  it('refuses when the org has no GitHub connection', async () => {
    orgService.githubConnection.mockResolvedValue(null);
    await expect(handler({ projectId: PROJECT_A }, actorA)).rejects.toThrow(
      k.tasks.errors.githubNotConnected,
    );
    expect(github.mintRepoToken).not.toHaveBeenCalled();
  });

  it('maps a refused restricted mint (repo dropped from grant) to its own error key', async () => {
    github.mintRepoToken.mockResolvedValue(null);
    await expect(handler({ projectId: PROJECT_A }, actorA)).rejects.toThrow(
      k.tasks.errors.repoDroppedFromGrant,
    );
    await expect(handler({ projectId: PROJECT_A }, actorA)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("two-tenant: org B's key cannot mint for org A's project — resolution is actor-org-scoped", async () => {
    await expect(handler({ projectId: PROJECT_A }, actorB)).rejects.toThrow(
      k.tasks.errors.projectNotFound,
    );
    // The lookup received the ACTOR (and with it actor.orgId), not a raw id.
    expect(projectService.getById).toHaveBeenCalledWith(actorB, PROJECT_A);
    expect(orgService.githubConnection).not.toHaveBeenCalled();
    expect(github.mintRepoToken).not.toHaveBeenCalled();
  });
});
