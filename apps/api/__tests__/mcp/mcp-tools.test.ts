import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveUser } from '@pkg/contracts';
import { FakeLogger } from '@pkg/testing';
import type { PinoLogger } from 'nestjs-pino';
import type { AgentService } from '@/agents/index.js';
import { McpTools } from '@/mcp/mcp-tools.js';
import type { DataPlaneExecutor } from '@/data-plane/index.js';
import type { GithubAppService } from '@pkg/server';
import type { OrgService } from '@/org/org.service.js';
import type { ProjectService } from '@/tasks/project.service.js';
import type { TaskService } from '@/tasks/task.service.js';
import type { ResearchService } from '@/research/research.service.js';
import type { AttachmentsService } from '@/attachments/attachments.service.js';
import type { EnvironmentService } from '@/environments/index.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const TASK = '22222222-2222-4222-8222-222222222222';
const actor: ActiveUser = { userId: 'u', orgId: ORG, orgRole: 'MEMBER', systemRole: 'USER' };

/**
 * The attachment tools are thin wrappers — what matters is that they exist
 * in the agent court (tasks:agent + org context) and delegate to the SAME
 * AttachmentsService the REST surface uses, pinned to subjectType 'task'.
 */
describe('McpTools — attachment tools', () => {
  const attachments = {
    list: vi.fn().mockResolvedValue({ data: [] }),
    createUpload: vi.fn().mockResolvedValue({}),
    confirm: vi.fn().mockResolvedValue({}),
  };
  const tools = new McpTools(
    {} as OrgService,
    {} as ProjectService,
    {} as TaskService,
    {} as ResearchService,
    attachments as unknown as AttachmentsService,
    {} as GithubAppService,
    {} as AgentService,
    {} as EnvironmentService,
    {} as DataPlaneExecutor,
    new FakeLogger().as<PinoLogger>(),
  );
  const byName = (name: string) => tools.catalog().find((tool) => tool.name === name)!;

  it('exposes all three behind tasks:agent with org context required', () => {
    for (const name of ['list_attachments', 'create_attachment_upload', 'confirm_attachment']) {
      const tool = byName(name);
      expect(tool).toBeDefined();
      expect(tool.scope).toBe('tasks:agent');
      expect(tool.needsOrgContext).toBe(true);
    }
  });

  it('list_attachments delegates pinned to the task subject', async () => {
    await byName('list_attachments').handler({ taskId: TASK }, actor);
    expect(attachments.list).toHaveBeenCalledWith(actor, {
      subjectType: 'task',
      subjectId: TASK,
    });
  });

  it('create_attachment_upload carries the declaration through', async () => {
    await byName('create_attachment_upload').handler(
      { taskId: TASK, kind: 'image', fileName: 'proof.png', mimeType: 'image/png', sizeBytes: 123 },
      actor,
    );
    expect(attachments.createUpload).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({
        subjectType: 'task',
        subjectId: TASK,
        kind: 'image',
        sizeBytes: 123,
      }),
    );
  });

  it('confirm_attachment delegates by id', async () => {
    await byName('confirm_attachment').handler({ id: TASK }, actor);
    expect(attachments.confirm).toHaveBeenCalledWith(actor, { id: TASK });
  });
});

/**
 * update_task is the agent's spec-repair tool — a thin wrapper that must live
 * in the agent court (tasks:agent + org context) and delegate to the SAME
 * TaskService.agentUpdateSpec the guardrail lives in, mapping its optional
 * args straight through.
 */
describe('McpTools — update_task', () => {
  const taskService = {
    agentUpdateSpec: vi.fn().mockResolvedValue({}),
  };
  const tools = new McpTools(
    {} as OrgService,
    {} as ProjectService,
    taskService as unknown as TaskService,
    {} as ResearchService,
    {} as AttachmentsService,
    {} as GithubAppService,
    {} as AgentService,
    {} as EnvironmentService,
    {} as DataPlaneExecutor,
    new FakeLogger().as<PinoLogger>(),
  );
  const updateTask = tools.catalog().find((tool) => tool.name === 'update_task')!;
  beforeEach(() => taskService.agentUpdateSpec.mockClear());

  it('lives in the agent court (tasks:agent, org context required)', () => {
    expect(updateTask).toBeDefined();
    expect(updateTask.scope).toBe('tasks:agent');
    expect(updateTask.needsOrgContext).toBe(true);
  });

  it('delegates the mapped spec fields to agentUpdateSpec', async () => {
    await updateTask.handler(
      {
        id: TASK,
        title: 'Fixed title',
        context: 'Better context',
        outOfScope: 'not this',
        area: 'Billing',
        acceptanceCriteria: ['a', 'b'],
      },
      actor,
    );
    expect(taskService.agentUpdateSpec).toHaveBeenCalledWith(actor, {
      id: TASK,
      title: 'Fixed title',
      context: 'Better context',
      outOfScope: 'not this',
      area: 'Billing',
      acceptanceCriteria: ['a', 'b'],
    });
  });

  it('passes omitted fields through as undefined (a partial edit)', async () => {
    await updateTask.handler({ id: TASK, title: 'Only the title' }, actor);
    expect(taskService.agentUpdateSpec).toHaveBeenCalledWith(actor, {
      id: TASK,
      title: 'Only the title',
      context: undefined,
      outOfScope: undefined,
      area: undefined,
      acceptanceCriteria: undefined,
    });
  });
});

/**
 * list_research is the research turn-QUEUE by default (status `researching`),
 * which the ambient runner depends on. An explicit status lets an assistant
 * browse the fuller set; `all` drops the filter. The handler owns this mapping.
 */
describe('McpTools — list_research status filter', () => {
  const research = {
    list: vi.fn().mockResolvedValue({ data: [], meta: { nextCursor: null } }),
  };
  const tools = new McpTools(
    {} as OrgService,
    {} as ProjectService,
    {} as TaskService,
    research as unknown as ResearchService,
    {} as AttachmentsService,
    {} as GithubAppService,
    {} as AgentService,
    {} as EnvironmentService,
    {} as DataPlaneExecutor,
    new FakeLogger().as<PinoLogger>(),
  );
  const listResearch = tools.catalog().find((tool) => tool.name === 'list_research')!;
  beforeEach(() => research.list.mockClear());

  it('defaults to the `researching` queue when status is omitted', async () => {
    await listResearch.handler({}, actor);
    expect(research.list).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({ status: 'researching' }),
    );
  });

  it('passes a specific status straight through', async () => {
    await listResearch.handler({ status: 'needs_review' }, actor);
    expect(research.list).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({ status: 'needs_review' }),
    );
  });

  it('`all` drops the status filter (every status), keeping projectId', async () => {
    await listResearch.handler({ status: 'all', projectId: TASK }, actor);
    expect(research.list).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({ status: undefined, projectId: TASK }),
    );
  });
});

/**
 * The deploy-diagnosis tools are read-only agent-court wrappers: they live
 * behind tasks:agent + org context and delegate to the SAME EnvironmentService
 * the REST surface uses, passing the actor (never a payload identity) through.
 */
describe('McpTools — deploy diagnosis (get_environment / list_deployments)', () => {
  const PROJECT = '33333333-3333-4333-8333-333333333333';
  const environment = {
    agentGetEnvironments: vi.fn().mockResolvedValue({ data: [] }),
    agentListDeployments: vi.fn().mockResolvedValue({ data: [] }),
  };
  const tools = new McpTools(
    {} as OrgService,
    {} as ProjectService,
    {} as TaskService,
    {} as ResearchService,
    {} as AttachmentsService,
    {} as GithubAppService,
    {} as AgentService,
    environment as unknown as EnvironmentService,
    {} as DataPlaneExecutor,
    new FakeLogger().as<PinoLogger>(),
  );
  const byName = (name: string) => tools.catalog().find((tool) => tool.name === name)!;
  beforeEach(() => {
    environment.agentGetEnvironments.mockClear();
    environment.agentListDeployments.mockClear();
  });

  it('both live in the agent court (tasks:agent, org context required)', () => {
    for (const name of ['get_environment', 'list_deployments']) {
      const tool = byName(name);
      expect(tool).toBeDefined();
      expect(tool.scope).toBe('tasks:agent');
      expect(tool.needsOrgContext).toBe(true);
    }
  });

  it('get_environment delegates projectId + optional name to the service, actor first', async () => {
    await byName('get_environment').handler({ projectId: PROJECT, name: 'staging' }, actor);
    expect(environment.agentGetEnvironments).toHaveBeenCalledWith(actor, {
      projectId: PROJECT,
      name: 'staging',
    });
  });

  it('get_environment passes an omitted name through as undefined (all envs)', async () => {
    await byName('get_environment').handler({ projectId: PROJECT }, actor);
    expect(environment.agentGetEnvironments).toHaveBeenCalledWith(actor, {
      projectId: PROJECT,
      name: undefined,
    });
  });

  it('list_deployments delegates projectId + optional limit to the service', async () => {
    await byName('list_deployments').handler({ projectId: PROJECT, limit: 5 }, actor);
    expect(environment.agentListDeployments).toHaveBeenCalledWith(actor, {
      projectId: PROJECT,
      limit: 5,
    });
  });
});

/**
 * The data-plane tools are the thinnest wrappers in the catalog ON PURPOSE:
 * the grant check, caps, scrub and audit all live in DataPlaneExecutor. What
 * a tool test can prove is the shape: the right scope (never tasks:agent),
 * org context required, and the actor + calling key handed through untouched.
 */
describe('McpTools — data-plane tools', () => {
  const PROJECT = '33333333-3333-4333-8333-333333333333';
  const auth = { keyId: 'key-1', name: 'runner' };
  const dataPlane = { execute: vi.fn().mockResolvedValue({ ok: true, data: {} }) };
  const tools = new McpTools(
    {} as OrgService,
    {} as ProjectService,
    {} as TaskService,
    {} as ResearchService,
    {} as AttachmentsService,
    {} as GithubAppService,
    {} as AgentService,
    {} as EnvironmentService,
    dataPlane as unknown as DataPlaneExecutor,
    new FakeLogger().as<PinoLogger>(),
  );
  const byName = (name: string) => tools.catalog().find((tool) => tool.name === name)!;
  beforeEach(() => dataPlane.execute.mockClear());

  it('all three live behind data-plane:agent (NOT tasks:agent) with org context required', () => {
    for (const name of ['data_plane_sql', 'data_plane_cache', 'data_plane_storage']) {
      const tool = byName(name);
      expect(tool).toBeDefined();
      expect(tool.scope).toBe('data-plane:agent');
      expect(tool.needsOrgContext).toBe(true);
    }
  });

  it('data_plane_sql hands actor, calling key and the statement to the executor', async () => {
    await byName('data_plane_sql').handler(
      { projectId: PROJECT, environment: 'staging', sql: 'SELECT 1', limit: 5, taskId: TASK },
      actor,
      auth,
    );
    expect(dataPlane.execute).toHaveBeenCalledWith(actor, auth, {
      resource: 'database',
      projectId: PROJECT,
      environment: 'staging',
      sql: 'SELECT 1',
      limit: 5,
      taskId: TASK,
    });
  });

  it('data_plane_cache and data_plane_storage carry their op + target through', async () => {
    await byName('data_plane_cache').handler(
      { projectId: PROJECT, environment: 'staging', op: 'scan', pattern: 'sess:*', count: 20 },
      actor,
      auth,
    );
    expect(dataPlane.execute).toHaveBeenLastCalledWith(
      actor,
      auth,
      expect.objectContaining({ resource: 'cache', op: 'scan', pattern: 'sess:*', count: 20 }),
    );
    await byName('data_plane_storage').handler(
      { projectId: PROJECT, environment: 'production', op: 'head', key: 'exports/a.csv' },
      actor,
      auth,
    );
    expect(dataPlane.execute).toHaveBeenLastCalledWith(
      actor,
      auth,
      expect.objectContaining({
        resource: 'storage',
        environment: 'production',
        op: 'head',
        key: 'exports/a.csv',
      }),
    );
  });
});
