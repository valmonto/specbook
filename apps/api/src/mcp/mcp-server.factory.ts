import { Injectable } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { MCP_TOOLS } from '@pkg/contracts';
import { InjectLogger, PinoLogger } from '@pkg/server';
import type { McpAuth } from './mcp-auth.guard';
import { McpTools } from './mcp-tools';

// whoami is not a catalog entry (its handler answers from auth, not a
// service), but its metadata lives with the rest in @pkg/contracts.
const whoami = MCP_TOOLS.find((tool) => tool.name === 'whoami')!;

const text = (data: unknown): { content: { type: 'text'; text: string }[] } => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
});

/**
 * Builds a per-request MCP server exposing ONLY the tools the key's scopes
 * cover. The filtering happens at REGISTRATION, not at call time — an
 * out-of-scope tool does not exist for that key, rather than existing and
 * refusing.
 */
@Injectable()
export class McpServerFactory {
  constructor(
    private readonly tools: McpTools,
    @InjectLogger() private readonly logger: PinoLogger,
  ) {}

  build(auth: McpAuth): McpServer {
    const server = new McpServer({ name: 'valmatic', version: '1.0.0' });

    // Always present: lets an agent discover what this key was granted.
    server.registerTool(
      whoami.name,
      { description: whoami.description },
      async () => text({ name: auth.name, scopes: auth.scopes }),
    );

    for (const tool of this.tools.catalog()) {
      if (tool.scope !== null && !auth.scopes.includes(tool.scope)) continue;
      // Org-scoped tools do not exist for keys without an org binding — same
      // philosophy as scope filtering: absent, not present-and-refusing.
      if (tool.needsOrgContext && !auth.activeUser) continue;

      server.registerTool(
        tool.name,
        { description: tool.description, inputSchema: tool.inputSchema },
        async (args: Record<string, unknown>) => {
          this.logger.info({ tool: tool.name, keyId: auth.keyId }, 'MCP tool call');
          const result = await tool.handler(args ?? {}, auth.activeUser, {
            keyId: auth.keyId,
            name: auth.name,
          });
          // Presence rides normal traffic: any successful agent-court call
          // stamps the key's agent row (the heartbeat tool already did).
          if (tool.scope === 'tasks:agent' && tool.name !== 'heartbeat' && auth.activeUser) {
            this.tools.stampPresence({ keyId: auth.keyId, name: auth.name }, auth.activeUser);
          }
          return text(result);
        },
      );
    }

    return server;
  }
}
