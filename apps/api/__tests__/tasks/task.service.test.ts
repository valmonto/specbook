import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { ActiveUser } from '@pkg/contracts';
import { FakeLogger } from '@pkg/testing';
import type { PinoLogger } from 'nestjs-pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskService } from '@/tasks/task.service';
import type { TaskRepository } from '@/tasks/task.repository';
import type { ProjectRepository } from '@/tasks/project.repository';
import type { NotificationService } from '@/notifications/notification.service';
import type { OrgService } from '@/org/org.service';
import type { GithubAppService } from '@/github/github-app.service';

const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const AGENT = '33333333-3333-4333-8333-333333333333';
const TASK = '44444444-4444-4444-8444-444444444444';
const OTHER = '55555555-5555-4555-8555-555555555555';
const PROJECT = '66666666-6666-4666-8666-666666666666';
const now = new Date('2026-01-01T00:00:00.000Z');

const human: ActiveUser = { userId: USER, orgId: ORG, orgRole: 'OWNER', systemRole: 'USER' };
const agent: ActiveUser = { userId: AGENT, orgId: ORG, orgRole: 'MEMBER', systemRole: 'USER' };

const baseTask = {
  id: TASK,
  projectId: PROJECT,
  title: 'Build the thing',
  context: 'Why and where',
  outOfScope: null,
  acceptanceCriteria: [{ text: 'it works', done: false }],
  status: 'draft',
  priority: 0,
  claimedBy: null,
  claimedAt: null,
  branch: null,
  prUrl: null,
  statusChangedBy: null,
  statusChangedAt: null,
  createdBy: USER,
  createdAt: now,
  updatedAt: now,
};

describe('TaskService — the status protocol', () => {
  let service: TaskService;
  let repo: Record<string, ReturnType<typeof vi.fn>>;
  let projectRepo: Record<string, ReturnType<typeof vi.fn>>;
  let notifications: Record<string, ReturnType<typeof vi.fn>>;
  let orgService: Record<string, ReturnType<typeof vi.fn>>;
  let githubApp: Record<string, unknown>;

  // Wider than Partial<typeof baseTask>: the literal's fields infer as their
  // initial values' types (context: string, claimedBy: null), which rejects
  // the very states the tests exist to set up.
  const taskInState = (overrides: Record<string, unknown>) => ({ ...baseTask, ...overrides });

  beforeEach(() => {
    repo = {
      create: vi.fn().mockResolvedValue(baseTask),
      findForOrg: vi.fn().mockResolvedValue({ data: [baseTask], total: 1 }),
      findById: vi.fn().mockResolvedValue(baseTask),
      update: vi.fn().mockImplementation(async (_id, _org, patch) => taskInState(patch)),
      casUpdateStatus: vi.fn().mockImplementation(async (_id, _org, _from, patch) => taskInState(patch)),
      delete: vi.fn().mockResolvedValue(true),
      createComment: vi.fn().mockImplementation(async (data) => ({
        id: OTHER,
        createdAt: now,
        ...data,
      })),
      findComments: vi.fn().mockResolvedValue([]),
      addDependency: vi.fn().mockResolvedValue(undefined),
      removeDependency: vi.fn().mockResolvedValue(true),
      findDependencyInfo: vi.fn().mockResolvedValue([]),
      findDependentInfo: vi.fn().mockResolvedValue([]),
      findProjectDependencyEdges: vi.fn().mockResolvedValue([]),
      findOrgMemberIds: vi.fn().mockResolvedValue([USER, AGENT]),
    };
    projectRepo = {
      findById: vi.fn().mockResolvedValue({ id: PROJECT, orgId: ORG }),
    };
    notifications = { create: vi.fn().mockResolvedValue(undefined) };
    orgService = { githubConnection: vi.fn().mockResolvedValue({ installationId: 777 }) };
    githubApp = {
      enabled: true,
      getPullRequest: vi.fn().mockResolvedValue(null),
      createPullRequest: vi.fn().mockResolvedValue(12),
      mergePullRequest: vi.fn().mockResolvedValue(true),
    };
    service = new TaskService(
      repo as unknown as TaskRepository,
      projectRepo as unknown as ProjectRepository,
      notifications as unknown as NotificationService,
      orgService as unknown as OrgService,
      githubApp as unknown as GithubAppService,
      new FakeLogger().as<PinoLogger>(),
    );
  });

  // --- Actor enforcement: the maps, not convention, hold the line ---

  it('lets the human dispatch draft → ready', async () => {
    const result = await service.transition(human, 'user', { id: TASK, to: 'ready' });
    expect(result.status).toBe('ready');
  });

  it('refuses the agent draft → ready — dispatching is the human move', async () => {
    await expect(service.transition(agent, 'agent', { id: TASK, to: 'ready' })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('refuses the human ready → in_progress — pulling work is the agent move', async () => {
    repo.findById!.mockResolvedValue(taskInState({ status: 'ready' }));
    await expect(service.transition(human, 'user', { id: TASK, to: 'in_progress' })).rejects.toThrow(
      BadRequestException,
    );
  });

  // The design's central invariant: no self-approval.
  it('refuses the agent needs_review → done — only the human accepts work', async () => {
    repo.findById!.mockResolvedValue(taskInState({ status: 'needs_review' }));
    await expect(service.transition(agent, 'agent', { id: TASK, to: 'done' })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('lets the human accept needs_review → done', async () => {
    repo.findById!.mockResolvedValue(taskInState({ status: 'needs_review' }));
    const result = await service.transition(human, 'user', { id: TASK, to: 'done' });
    expect(result.status).toBe('done');
  });

  // --- The merge queue (approved) ---

  it('lets the human approve needs_review → approved', async () => {
    repo.findById!.mockResolvedValue(taskInState({ status: 'needs_review' }));
    const result = await service.transition(human, 'user', { id: TASK, to: 'approved' });
    expect(result.status).toBe('approved');
  });

  it('refuses the agent needs_review → approved — approval is the human move', async () => {
    repo.findById!.mockResolvedValue(taskInState({ status: 'needs_review' }));
    await expect(service.transition(agent, 'agent', { id: TASK, to: 'approved' })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('lets the human undo an approval (approved → needs_review)', async () => {
    repo.findById!.mockResolvedValue(taskInState({ status: 'approved' }));
    const result = await service.transition(human, 'user', { id: TASK, to: 'needs_review' });
    expect(result.status).toBe('needs_review');
  });

  describe('merge — approved lands on main, server-side', () => {
    const boundProject = {
      id: PROJECT,
      orgId: ORG,
      githubRepoFullName: 'valmonto/specbook',
      repoUrl: null,
      defaultBranch: 'main',
    };

    beforeEach(() => {
      projectRepo.findById!.mockResolvedValue(boundProject);
    });

    it('refuses merge unless the task is approved', async () => {
      repo.findById!.mockResolvedValue(taskInState({ status: 'needs_review' }));
      await expect(service.merge(human, { id: TASK })).rejects.toThrow(
        UnprocessableEntityException,
      );
    });

    it('refuses merge while CI is failing', async () => {
      repo.findById!.mockResolvedValue(taskInState({ status: 'approved', ciState: 'failing' }));
      await expect(service.merge(human, { id: TASK })).rejects.toThrow(
        UnprocessableEntityException,
      );
    });

    it('merges the webhook-fed PR number and finalizes done + merged', async () => {
      repo.findById!.mockResolvedValue(
        taskInState({ status: 'approved', prNumber: 12, branch: 'feat/x' }),
      );
      const result = await service.merge(human, { id: TASK });
      expect(githubApp.mergePullRequest).toHaveBeenCalledWith(777, 'valmonto/specbook', 12);
      expect(result.status).toBe('done');
      expect(result.prState).toBe('merged');
    });

    it('creates the PR from the branch when none exists yet', async () => {
      repo.findById!.mockResolvedValue(
        taskInState({ status: 'approved', prNumber: null, branch: 'feat/x' }),
      );
      const result = await service.merge(human, { id: TASK });
      expect(githubApp.createPullRequest).toHaveBeenCalledWith(777, 'valmonto/specbook', {
        head: 'feat/x',
        base: 'main',
        title: baseTask.title,
      });
      expect(githubApp.mergePullRequest).toHaveBeenCalledWith(777, 'valmonto/specbook', 12);
      expect(result.status).toBe('done');
    });

    it('parses owner/repo from a free-text repoUrl when the project is unbound', async () => {
      projectRepo.findById!.mockResolvedValue({
        ...boundProject,
        githubRepoFullName: null,
        repoUrl: 'https://github.com/valmonto/specbook.git',
      });
      repo.findById!.mockResolvedValue(taskInState({ status: 'approved', prNumber: 7 }));
      await service.merge(human, { id: TASK });
      expect(githubApp.mergePullRequest).toHaveBeenCalledWith(777, 'valmonto/specbook', 7);
    });

    it('409s when GitHub refuses the merge (conflict / not mergeable)', async () => {
      (githubApp.mergePullRequest as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      repo.findById!.mockResolvedValue(taskInState({ status: 'approved', prNumber: 12 }));
      await expect(service.merge(human, { id: TASK })).rejects.toThrow(ConflictException);
    });

    it('finalizes without calling GitHub when the webhook already stamped merged', async () => {
      repo.findById!.mockResolvedValue(
        taskInState({ status: 'approved', prNumber: 12, prState: 'merged' }),
      );
      const result = await service.merge(human, { id: TASK });
      expect(githubApp.mergePullRequest).not.toHaveBeenCalled();
      expect(result.status).toBe('done');
    });

    it('422s when neither a PR number nor a branch exists', async () => {
      repo.findById!.mockResolvedValue(
        taskInState({ status: 'approved', prNumber: null, branch: null }),
      );
      await expect(service.merge(human, { id: TASK })).rejects.toThrow(
        UnprocessableEntityException,
      );
    });
  });

  // --- Dispatch gate ---

  it('blocks dispatch without context', async () => {
    repo.findById!.mockResolvedValue(taskInState({ context: null }));
    await expect(service.transition(human, 'user', { id: TASK, to: 'ready' })).rejects.toThrow(
      UnprocessableEntityException,
    );
  });

  it('blocks dispatch without acceptance criteria', async () => {
    repo.findById!.mockResolvedValue(taskInState({ acceptanceCriteria: [] }));
    await expect(service.transition(human, 'user', { id: TASK, to: 'ready' })).rejects.toThrow(
      UnprocessableEntityException,
    );
  });

  // --- Review gate: no silent "done" claims ---

  it('blocks needs_review without a summary comment', async () => {
    repo.findById!.mockResolvedValue(
      taskInState({ status: 'in_progress', branch: 'feat/x', prUrl: 'https://pr' }),
    );
    await expect(
      service.transition(agent, 'agent', { id: TASK, to: 'needs_review' }),
    ).rejects.toThrow(UnprocessableEntityException);
  });

  it('blocks needs_review without branch and PR link', async () => {
    repo.findById!.mockResolvedValue(taskInState({ status: 'in_progress' }));
    await expect(
      service.transition(agent, 'agent', { id: TASK, to: 'needs_review', comment: 'done, see PR' }),
    ).rejects.toThrow(UnprocessableEntityException);
  });

  it('accepts needs_review with summary + branch + PR, and records the summary', async () => {
    repo.findById!.mockResolvedValue(
      taskInState({ status: 'in_progress', branch: 'feat/x', prUrl: 'https://pr' }),
    );
    await service.transition(agent, 'agent', { id: TASK, to: 'needs_review', comment: 'done' });
    expect(repo.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'comment', authorType: 'agent', body: 'done' }),
    );
  });

  // --- Blocked / feedback comments ---

  it('blocks the blocked transition without the question, and types it when present', async () => {
    repo.findById!.mockResolvedValue(taskInState({ status: 'in_progress' }));
    await expect(service.transition(agent, 'agent', { id: TASK, to: 'blocked' })).rejects.toThrow(
      UnprocessableEntityException,
    );

    await service.transition(agent, 'agent', { id: TASK, to: 'blocked', comment: 'which db?' });
    expect(repo.createComment).toHaveBeenCalledWith(expect.objectContaining({ kind: 'question' }));
  });

  it('requires feedback on changes_requested', async () => {
    repo.findById!.mockResolvedValue(taskInState({ status: 'needs_review' }));
    await expect(
      service.transition(human, 'user', { id: TASK, to: 'changes_requested' }),
    ).rejects.toThrow(UnprocessableEntityException);
  });

  // --- Claiming ---

  it('claims on ready → in_progress', async () => {
    repo.findById!.mockResolvedValue(taskInState({ status: 'ready' }));
    await service.transition(agent, 'agent', { id: TASK, to: 'in_progress' });
    expect(repo.casUpdateStatus).toHaveBeenCalledWith(
      TASK,
      ORG,
      'ready',
      expect.objectContaining({ claimedBy: AGENT }),
    );
  });

  it('keeps the original claim on blocked → in_progress', async () => {
    repo.findById!.mockResolvedValue(taskInState({ status: 'blocked', claimedBy: AGENT }));
    await service.transition(human, 'user', { id: TASK, to: 'in_progress' });
    const patch = repo.casUpdateStatus!.mock.calls[0]![3];
    expect(patch.claimedBy).toBeUndefined();
  });

  it('releases the claim on any → ready (the stale-claim reset)', async () => {
    repo.findById!.mockResolvedValue(
      taskInState({ status: 'in_progress', claimedBy: AGENT, claimedAt: now }),
    );
    await service.transition(human, 'user', { id: TASK, to: 'ready' });
    expect(repo.casUpdateStatus).toHaveBeenCalledWith(
      TASK,
      ORG,
      'in_progress',
      expect.objectContaining({ claimedBy: null, claimedAt: null }),
    );
  });

  it('409s the loser of a claim race as already claimed', async () => {
    repo.findById!.mockResolvedValue(taskInState({ status: 'ready' }));
    repo.casUpdateStatus!.mockResolvedValue(null);
    await expect(
      service.transition(agent, 'agent', { id: TASK, to: 'in_progress' }),
    ).rejects.toThrow(ConflictException);
  });

  // --- Dependencies ---

  it('rejects a dependency that would close a cycle', async () => {
    // A depends on TASK already; adding TASK depends on A closes the loop.
    repo.findById!.mockImplementation(async (id: string) =>
      taskInState({ id, projectId: PROJECT }),
    );
    repo.findProjectDependencyEdges!.mockResolvedValue([
      { taskId: OTHER, dependsOnTaskId: TASK },
    ]);
    await expect(
      service.addDependency(human, { id: TASK, dependsOnTaskId: OTHER }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects a cross-project dependency', async () => {
    repo.findById!.mockImplementation(async (id: string) =>
      taskInState({ id, projectId: id === TASK ? PROJECT : OTHER }),
    );
    await expect(
      service.addDependency(human, { id: TASK, dependsOnTaskId: OTHER }),
    ).rejects.toThrow(BadRequestException);
  });

  // --- Lifecycle guards ---

  it('refuses edits to terminal tasks', async () => {
    repo.findById!.mockResolvedValue(taskInState({ status: 'done' }));
    await expect(service.update(human, { id: TASK, title: 'rename' })).rejects.toThrow(
      UnprocessableEntityException,
    );
  });

  it('deletes only drafts — later states cancel instead', async () => {
    repo.findById!.mockResolvedValue(taskInState({ status: 'in_progress' }));
    await expect(service.delete(human, TASK)).rejects.toThrow(UnprocessableEntityException);

    repo.findById!.mockResolvedValue(taskInState({ status: 'draft' }));
    await service.delete(human, TASK);
    expect(repo.delete).toHaveBeenCalledWith(TASK, ORG);
  });

  it('reports an out-of-scope task as not found', async () => {
    repo.findById!.mockResolvedValue(null);
    await expect(service.getById(human, TASK)).rejects.toThrow(NotFoundException);
  });

  // --- Court notifications: the bell lights up when it's the human's move ---

  it('notifies org members (except the actor) when a task becomes blocked', async () => {
    repo.findById!.mockResolvedValue(taskInState({ status: 'in_progress' }));
    await service.transition(agent, 'agent', { id: TASK, to: 'blocked', comment: 'which db?' });

    expect(notifications.create).toHaveBeenCalledTimes(1);
    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER,
        orgId: ORG,
        type: 'warning',
        message: 'which db?',
      }),
    );
  });

  it('notifies on needs_review with a link to the task in data', async () => {
    repo.findById!.mockResolvedValue(
      taskInState({ status: 'in_progress', branch: 'feat/x', prUrl: 'https://pr' }),
    );
    await service.transition(agent, 'agent', { id: TASK, to: 'needs_review', comment: 'done' });

    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER,
        type: 'info',
        data: expect.objectContaining({ taskId: TASK, to: 'needs_review' }),
      }),
    );
  });

  it('does not notify on transitions outside the human court', async () => {
    repo.findById!.mockResolvedValue(taskInState({ status: 'ready' }));
    await service.transition(agent, 'agent', { id: TASK, to: 'in_progress' });
    expect(notifications.create).not.toHaveBeenCalled();
  });

  // A dead notification pipe must never block the protocol itself.
  it('still transitions when notification creation fails', async () => {
    repo.findById!.mockResolvedValue(taskInState({ status: 'in_progress' }));
    notifications.create!.mockRejectedValue(new Error('smtp down'));

    const result = await service.transition(agent, 'agent', {
      id: TASK,
      to: 'blocked',
      comment: 'q?',
    });
    expect(result.status).toBe('blocked');
  });

  it('turns criteria strings into unchecked checklist items on create', async () => {
    await service.create(human, {
      projectId: PROJECT,
      title: 'T',
      acceptanceCriteria: ['a', 'b'],
    });
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        acceptanceCriteria: [
          { text: 'a', done: false },
          { text: 'b', done: false },
        ],
      }),
    );
  });
});
