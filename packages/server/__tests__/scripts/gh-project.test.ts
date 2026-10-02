import { describe, expect, it } from 'vitest';

// gh-project is a plain .mjs tool in scripts/; we import its PURE core (no
// fetch, no spawn, no token) and prove the parts that decide what the child
// process is actually told to do.
import {
  GIT_CREDENTIAL_HELPER,
  extractMcpPayload,
  keyFromConfig,
  matchesProject,
  parseArgs,
  resolveMcpUrl,
  skipRepoFlag,
  unwrapToolResult,
  // @ts-expect-error — untyped .mjs tool imported for its exported pure functions.
  // (The directive sits on the line TypeScript reports: the module specifier.)
} from '../../../../scripts/gh-project.mjs';

describe('gh-project: parseArgs', () => {
  it('splits the project selector from the arguments after --', () => {
    expect(parseArgs(['solmond', '--', 'pr', 'list', '--state', 'open'])).toEqual({
      project: 'solmond',
      ghArgs: ['pr', 'list', '--state', 'open'],
      printRemote: false,
      git: false,
    });
  });

  /** A flag before `--` is ours; a flag after it belongs to the child. */
  it('keeps our flags out of the child arguments', () => {
    const { ghArgs, git } = parseArgs(['specbook', '--git', '--', 'push', '@origin', 'HEAD']);

    expect(git).toBe(true);
    expect(ghArgs).toEqual(['push', '@origin', 'HEAD']);
  });

  it('reports no arguments when the -- separator is missing', () => {
    expect(parseArgs(['solmond', 'pr', 'list']).ghArgs).toEqual([]);
  });
});

describe('gh-project: skipRepoFlag', () => {
  /**
   * `gh api` takes the repo in the path and rejects --repo as an unknown flag;
   * appending it blindly broke a live call.
   */
  it('leaves --repo off the subcommands that do not accept it', () => {
    expect(skipRepoFlag(['api', 'repos/valmonto/solmond/commits/main'])).toBe(true);
    expect(skipRepoFlag(['auth', 'status'])).toBe(true);
  });

  it('leaves --repo off when the caller already aimed gh somewhere', () => {
    expect(skipRepoFlag(['pr', 'list', '-R', 'valmonto/xket'])).toBe(true);
    expect(skipRepoFlag(['pr', 'list', '--repo', 'valmonto/xket'])).toBe(true);
    expect(skipRepoFlag(['pr', 'list', '--repo=valmonto/xket'])).toBe(true);
  });

  it('adds --repo for an ordinary subcommand', () => {
    expect(skipRepoFlag(['pr', 'list', '--state', 'open'])).toBe(false);
  });
});

describe('gh-project: matchesProject', () => {
  const project = {
    id: '019ff7af-bade-75a1-819f-212001f759ef',
    name: 'solmond',
    githubRepoFullName: 'valmonto/solmond',
  };

  it('matches on name, uuid or owner/repo, ignoring case', () => {
    for (const selector of [
      'solmond',
      'SOLMOND',
      '019ff7af-bade-75a1-819f-212001f759ef',
      'valmonto/solmond',
    ]) {
      expect(matchesProject(project, selector)).toBe(true);
    }
  });

  /** A partial name must not silently resolve to the wrong repository. */
  it('does not match a prefix, a suffix or an empty selector', () => {
    for (const selector of ['sol', 'solmond-x', '', '  ']) {
      expect(matchesProject(project, selector)).toBe(false);
    }
  });
});

describe('gh-project: resolveMcpUrl', () => {
  it('prefers an explicit endpoint, then a base, then the prod default', () => {
    expect(resolveMcpUrl({ SPECBOOK_MCP_URL: 'https://x.test/api/mcp' })).toBe(
      'https://x.test/api/mcp',
    );
    expect(resolveMcpUrl({ SPECBOOK_BASE_URL: 'https://x.test/' })).toBe('https://x.test/api/mcp');
    expect(resolveMcpUrl({})).toBe('https://specbook.valmonto.com/api/mcp');
  });
});

describe('gh-project: keyFromConfig', () => {
  /** Claude's own config nests mcpServers under each project path. */
  it('finds the key whether the registration is top-level or nested', () => {
    const header = { mcpServers: { specbook: { headers: { Authorization: 'Bearer sk-top' } } } };
    expect(keyFromConfig(header)).toBe('sk-top');

    const nested = {
      projects: {
        '/opt/specbook': {
          mcpServers: { specbook: { env: { SPECBOOK_API_KEY: 'sk-nested' } } },
        },
      },
    };
    expect(keyFromConfig(nested)).toBe('sk-nested');
  });

  it('ignores other servers and malformed configs', () => {
    expect(keyFromConfig({ mcpServers: { playwright: { headers: { Authorization: 'x' } } } })).toBe(
      null,
    );
    expect(keyFromConfig(null)).toBe(null);
    expect(keyFromConfig({ mcpServers: { specbook: {} } })).toBe(null);
  });
});

describe('gh-project: extractMcpPayload', () => {
  /** Streamable-HTTP frames the reply as SSE, but may send raw JSON. */
  it('reads the message from an SSE frame or from raw JSON', () => {
    expect(extractMcpPayload('event: message\ndata: {"id":1}\n\n')).toEqual({ id: 1 });
    expect(extractMcpPayload('{"id":2}')).toEqual({ id: 2 });
  });

  it('returns null rather than throwing on an empty or torn body', () => {
    expect(extractMcpPayload('')).toBe(null);
    expect(extractMcpPayload('data: {"id":')).toBe(null);
    expect(extractMcpPayload(undefined)).toBe(null);
  });
});

describe('gh-project: unwrapToolResult', () => {
  it('parses the JSON a tool returned as text content', () => {
    const payload = { result: { content: [{ type: 'text', text: '{"token":"ghs_x"}' }] } };

    expect(unwrapToolResult(payload)).toEqual({ token: 'ghs_x' });
  });

  it('raises the MCP error rather than returning a shapeless result', () => {
    expect(() => unwrapToolResult({ error: { message: 'forbidden' } })).toThrow(/forbidden/);
    expect(() => unwrapToolResult({ result: { content: [] } })).toThrow(/no text content/);
  });
});

describe('gh-project: the credential helper', () => {
  /**
   * The whole point of the tool: the token reaches git through the child's
   * environment. A helper that inlined the secret would put it back on the
   * command line, which is what this exists to avoid.
   */
  it('reads the token from the environment and never embeds one', () => {
    expect(GIT_CREDENTIAL_HELPER).toContain('$GH_TOKEN');
    expect(GIT_CREDENTIAL_HELPER).toContain('username=x-access-token');
    expect(GIT_CREDENTIAL_HELPER).not.toMatch(/gh[ps]_/);
  });
});
