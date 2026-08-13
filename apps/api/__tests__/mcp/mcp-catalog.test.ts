import { describe, expect, it } from 'vitest';
import { MCP_SCOPES, MCP_TOOLS, type McpToolDescriptor } from '@pkg/contracts';
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
import type { EnvironmentService } from '@/environments';

/**
 * The contracts descriptors are what the key-creation UI shows the human;
 * the catalog is what the server actually exposes. These tests are the
 * drift guard the split depends on: a tool added on either side without
 * the other fails here.
 */
describe('MCP catalog ↔ @pkg/contracts descriptors', () => {
  const tools = new McpTools(
    {} as OrgService,
    {} as ProjectService,
    {} as TaskService,
    {} as ResearchService,
    {} as AttachmentsService,
    {} as GithubAppService,
    {} as AgentService,
    {} as EnvironmentService,
    new FakeLogger().as<PinoLogger>(),
  );
  const catalog = tools.catalog();
  // whoami is registered by McpServerFactory for every key, not via catalog().
  const handlerNames = [...catalog.map((tool) => tool.name), 'whoami'];
  const descriptorNames = MCP_TOOLS.map((tool) => tool.name);

  it('every descriptor has a handler', () => {
    expect([...descriptorNames].sort()).toEqual([...handlerNames].sort());
  });

  it('every handler has a descriptor with identical metadata', () => {
    for (const entry of catalog) {
      const descriptor: McpToolDescriptor | undefined = MCP_TOOLS.find(
        (tool) => tool.name === entry.name,
      );
      expect(descriptor, `catalog tool '${entry.name}' missing from MCP_TOOLS`).toBeDefined();
      expect(entry.scope).toBe(descriptor!.scope);
      expect(entry.description).toBe(descriptor!.description);
      expect(entry.needsOrgContext ?? false).toBe(descriptor!.needsOrgContext ?? false);
    }
  });

  it('has no duplicate tool names on either side', () => {
    expect(new Set(descriptorNames).size).toBe(descriptorNames.length);
    expect(new Set(handlerNames).size).toBe(handlerNames.length);
  });

  it('every scope exposes at least one tool', () => {
    for (const scope of MCP_SCOPES) {
      expect(
        MCP_TOOLS.some((tool) => tool.scope === scope),
        `scope '${scope}' exposes no tools`,
      ).toBe(true);
    }
  });

  it('only whoami is unscoped', () => {
    expect(MCP_TOOLS.filter((tool) => tool.scope === null).map((tool) => tool.name)).toEqual([
      'whoami',
    ]);
  });
});
