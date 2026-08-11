import { describe, expect, it, vi } from 'vitest';
import type { ActiveUser } from '@pkg/contracts';
import { FakeLogger } from '@pkg/testing';
import type { PinoLogger } from 'nestjs-pino';
import type { AgentService } from '@/agents';
import { McpTools } from '@/mcp/mcp-tools';
import type { GithubAppService } from '@pkg/server';
import type { OrgService } from '@/org/org.service';
import type { ProjectService } from '@/tasks/project.service';
import type { TaskService } from '@/tasks/task.service';
import type { ResearchService } from '@/research/research.service';
import type { AttachmentsService } from '@/attachments/attachments.service';

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
      expect.objectContaining({ subjectType: 'task', subjectId: TASK, kind: 'image', sizeBytes: 123 }),
    );
  });

  it('confirm_attachment delegates by id', async () => {
    await byName('confirm_attachment').handler({ id: TASK }, actor);
    expect(attachments.confirm).toHaveBeenCalledWith(actor, { id: TASK });
  });
});
