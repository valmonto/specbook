import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { FakeLogger } from '@pkg/testing';
import type { PinoLogger } from 'nestjs-pino';
import { describe, expect, it } from 'vitest';
import { McpServerFactory } from '@/mcp/mcp-server.factory.js';
import { McpTools } from '@/mcp/mcp-tools.js';

/**
 * The wire contract every agent session depends on: the exact JSON Schema the
 * SDK publishes for each tool in `tools/list`. Snapshotted so a zod or SDK
 * bump that changes the emitted schema (a `format`, an `additionalProperties`,
 * an optional turning nullable) fails here instead of in a client.
 *
 * The snapshot was first taken on SDK 1.20 + the zod-v3 alias, BEFORE moving
 * to SDK 1.30 on zod 4. The post-bump diff had exactly three kinds of change,
 * all from zod 4's JSON Schema emitter and all accepted as intentional:
 *   - `.uuid()` now emits an explicit `pattern` beside `format: "uuid"` (27×);
 *   - `.int()` now also emits `maximum: 9007199254740991` (safe-integer bound, 11×);
 *   - `additionalProperties: false` is no longer emitted (26×) — zod 4 objects
 *     strip unknown keys instead of rejecting them, so a client sending an
 *     extra argument gets it ignored rather than a validation error.
 */
describe('MCP tools/list snapshot', () => {
  it('publishes the same schema for every tool, all scopes granted, org-bound', async () => {
    // The catalog never calls a service while listing; stubs are enough.
    const stub = {} as never;
    const tools = new McpTools(
      stub,
      stub,
      stub,
      stub,
      stub,
      stub,
      stub,
      stub,
      new FakeLogger().as<PinoLogger>(),
    );
    const factory = new McpServerFactory(tools, new FakeLogger().as<PinoLogger>());
    const scopes = [
      ...new Set(
        tools
          .catalog()
          .map((t) => t.scope)
          .filter(Boolean),
      ),
    ];
    const server = factory.build({
      keyId: 'k1',
      name: 'snapshot-key',
      scopes: scopes as never,
      // Org-bound so the needsOrgContext tools are registered too.
      activeUser: { userId: 'u1', orgId: 'o1', orgRole: 'OWNER', systemRole: 'USER' } as never,
    } as never);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'snapshot-client', version: '0.0.0' });
    await client.connect(clientTransport);

    const { tools: listed } = await client.listTools();
    const shape = listed
      .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
      .sort((a, b) => a.name.localeCompare(b.name));

    await expect(JSON.stringify(shape, null, 2) + '\n').toMatchFileSnapshot(
      './__snapshots__/mcp-tools-list.json',
    );
    await client.close();
  });
});
