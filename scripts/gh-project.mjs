#!/usr/bin/env node
/**
 * gh-project.mjs — run `gh` against a specbook-tracked project's repo, with a
 * freshly minted, short-lived repo token injected into gh's environment.
 *
 * WHY THIS EXISTS: `get_repo_token` hands back a 1-hour GitHub token, but the
 * only ways to give it to `gh` by hand are to write it to a file or to put it on
 * a command line (`GH_TOKEN=ghs_… gh pr list`). Both materialize a live
 * credential in shell history / process args / the agent transcript, and an
 * agent session is rightly blocked from doing either. The token itself is not
 * the problem — handling it in the clear is. So this wrapper does the handling:
 * it mints the token over the MCP endpoint and passes it to the child through
 * its `env`, which never appears in argv. The caller writes
 *
 *     node scripts/gh-project.mjs solmond -- pr list --state open
 *
 * with no secret anywhere in the command. Nothing is written to disk and the
 * token is discarded when the child exits; the next call mints a new one, so
 * expiry is a non-issue.
 *
 * SCOPE: the minted token is restricted by the server to that project's bound
 * repository (contents + pull requests). This wrapper cannot widen it — it
 * passes through whatever `get_repo_token` grants, so another repo simply
 * fails. Identity is the presenting specbook key, resolved server-side.
 *
 * CONFIG (env):
 *   SPECBOOK_API_KEY   Bearer key with the `tasks:agent` scope. If unset, the
 *                      key registered for the `specbook` MCP server on this
 *                      machine is used (see resolveApiKey) so an interactive
 *                      session needs no extra setup.
 *   SPECBOOK_MCP_URL   full MCP endpoint URL; falls back to
 *                      `${SPECBOOK_BASE_URL}/api/mcp`, then the prod endpoint.
 *   SPECBOOK_BASE_URL  base host — `/api/mcp` is appended.
 *
 * USAGE
 *   node scripts/gh-project.mjs <project> -- <gh args…>
 *   node scripts/gh-project.mjs solmond -- pr list --state open
 *   node scripts/gh-project.mjs solmond -- pr merge 42 --merge
 *
 * `--git` runs git instead, authenticated the same way. The checkouts on an
 * agent machine often have an ssh-alias remote (`git@github-solmond:…`) that
 * resolves only for the human's ssh config, so `@origin` stands in for the
 * project's HTTPS URL and credentials come from an inline helper reading
 * GH_TOKEN out of the environment:
 *
 *   node scripts/gh-project.mjs specbook --git -- fetch @origin main
 *   node scripts/gh-project.mjs specbook --git -- push @origin HEAD:refs/heads/my-branch
 *
 *   node scripts/gh-project.mjs --print-remote solmond   # authenticated push URL
 *
 * `<project>` is matched case-insensitively against the project name, and also
 * accepts a project uuid or an `owner/repo`.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_MCP_URL = 'https://specbook.valmonto.com/api/mcp';
export const REQUEST_TIMEOUT_MS = 20_000;

/** Files that may carry the specbook MCP registration, best first. */
export const KEY_SOURCES = Object.freeze([
  join(homedir(), '.claude.json'),
  join(homedir(), '.claude', 'settings.json'),
  join(homedir(), '.claude', 'settings.local.json'),
  join(homedir(), '.config', 'claude', 'mcp.json'),
]);

// ── Pure core (no I/O) ───────────────────────────────────────────────────────

/**
 * Split argv into the project selector and the gh arguments after `--`.
 * @param {string[]} argv
 * @returns {{ project: string, ghArgs: string[], printRemote: boolean }}
 */
export function parseArgs(argv) {
  const flags = argv.filter((a) => a.startsWith('--') && a !== '--');
  const printRemote = flags.includes('--print-remote');
  const git = flags.includes('--git');
  const sep = argv.indexOf('--');
  const head = (sep === -1 ? argv : argv.slice(0, sep)).filter((a) => !a.startsWith('--'));
  const ghArgs = sep === -1 ? [] : argv.slice(sep + 1);
  return { project: head[0] ?? '', ghArgs, printRemote, git };
}

/**
 * A credential helper expressed inline, so the token travels in the child's
 * env and never in argv. git invokes this shell function and reads the
 * username/password pair off stdout.
 */
export const GIT_CREDENTIAL_HELPER =
  '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f';

/**
 * Resolve the MCP endpoint from an env-like object. URL precedence:
 * SPECBOOK_MCP_URL → SPECBOOK_BASE_URL + /api/mcp → prod default.
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
export function resolveMcpUrl(env = {}) {
  const explicit = (env.SPECBOOK_MCP_URL ?? '').trim();
  if (explicit !== '') return explicit;
  const base = (env.SPECBOOK_BASE_URL ?? '').trim();
  return base !== '' ? `${base.replace(/\/+$/, '')}/api/mcp` : DEFAULT_MCP_URL;
}

/**
 * Pull a bearer key out of one parsed MCP-registration object. Looks for a
 * server whose name contains 'specbook' and reads whichever shape it uses:
 * an Authorization header, or SPECBOOK_API_KEY in its env block. Claude's own
 * config nests `mcpServers` under each project path, so scan one level down too.
 * @param {unknown} config
 * @returns {string | null}
 */
export function keyFromConfig(config) {
  if (!config || typeof config !== 'object') return null;
  const nested = Object.values(config).filter((v) => v && typeof v === 'object');
  const projects = Object.values(config.projects ?? {}).filter((v) => v && typeof v === 'object');
  for (const root of [config, ...nested, ...projects]) {
    const servers = root?.mcpServers;
    if (!servers || typeof servers !== 'object') continue;
    for (const [name, server] of Object.entries(servers)) {
      if (!name.toLowerCase().includes('specbook') || !server || typeof server !== 'object') {
        continue;
      }
      const auth = server.headers?.Authorization ?? server.headers?.authorization ?? '';
      if (typeof auth === 'string' && auth.trim() !== '') {
        return auth.replace(/^Bearer\s+/i, '').trim();
      }
      const fromEnv = server.env?.SPECBOOK_API_KEY;
      if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim();
    }
  }
  return null;
}

/**
 * Match a project record against a user-supplied selector (name, uuid, or
 * owner/repo), case-insensitively.
 * @param {{ id?: string, name?: string, githubRepoFullName?: string }} project
 * @param {string} selector
 * @returns {boolean}
 */
export function matchesProject(project, selector) {
  const want = selector.trim().toLowerCase();
  if (want === '') return false;
  return (
    (project.id ?? '').toLowerCase() === want ||
    (project.name ?? '').toLowerCase() === want ||
    (project.githubRepoFullName ?? '').toLowerCase() === want
  );
}

/**
 * Whether we must leave `--repo` off: the caller already aimed gh somewhere, or
 * the subcommand does not accept the flag at all (`gh api` takes the repo in
 * the path, and rejects `--repo` as an unknown flag).
 * @param {string[]} ghArgs
 * @returns {boolean}
 */
export function skipRepoFlag(ghArgs) {
  const sub = ghArgs.find((a) => !a.startsWith('-'));
  if (sub === 'api' || sub === 'auth' || sub === 'config') return true;
  return ghArgs.some((a) => a === '-R' || a === '--repo' || a.startsWith('--repo='));
}

/**
 * Extract the JSON-RPC message from a Streamable-HTTP response body, which the
 * server frames as SSE (`data: {json}`) but may also send as raw JSON.
 * @param {unknown} text
 * @returns {Record<string, unknown> | null}
 */
export function extractMcpPayload(text) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  const dataLines = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .filter((line) => line !== '');
  const candidate = dataLines.length > 0 ? dataLines[dataLines.length - 1] : text.trim();
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

/**
 * Unwrap an MCP tool result into the JSON its handler returned. Tool results
 * arrive as `content: [{ type: 'text', text: '<json>' }]`.
 * @param {Record<string, unknown> | null} payload
 * @returns {unknown}
 */
export function unwrapToolResult(payload) {
  if (payload?.error) {
    const message = payload.error?.message ?? JSON.stringify(payload.error);
    throw new Error(`MCP error: ${message}`);
  }
  const text = payload?.result?.content?.find?.((c) => c?.type === 'text')?.text;
  if (typeof text !== 'string') throw new Error('MCP result carried no text content');
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ── I/O ──────────────────────────────────────────────────────────────────────

function die(message) {
  process.stderr.write(`gh-project: ${message}\n`);
  process.exit(1);
}

/**
 * The specbook key: the env var if set, else whatever the machine's MCP
 * registration already uses. Read straight into memory and never logged.
 */
function resolveApiKey(env = process.env) {
  const fromEnv = (env.SPECBOOK_API_KEY ?? '').trim();
  if (fromEnv !== '') return fromEnv;
  for (const path of KEY_SOURCES) {
    try {
      const key = keyFromConfig(JSON.parse(readFileSync(path, 'utf8')));
      if (key) return key;
    } catch {
      // unreadable or absent — try the next source
    }
  }
  return null;
}

async function callTool(url, apiKey, name, args = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`${name} returned HTTP ${res.status}`);
  return unwrapToolResult(extractMcpPayload(text));
}

async function main() {
  const { project, ghArgs, printRemote, git } = parseArgs(process.argv.slice(2));
  if (project === '') {
    die('usage: node scripts/gh-project.mjs <project> [--git] -- <gh or git args…>');
  }
  if (ghArgs.length === 0 && !printRemote) {
    die('no arguments given (did you forget the `--` separator?)');
  }

  const apiKey = resolveApiKey();
  if (!apiKey) {
    die(
      'no specbook key: set SPECBOOK_API_KEY, or register the specbook MCP server on this machine',
    );
  }
  const url = resolveMcpUrl(process.env);

  const listed = await callTool(url, apiKey, 'list_projects', { limit: 100 });
  const match = (listed?.data ?? []).find((p) => matchesProject(p, project));
  if (!match) {
    const names = (listed?.data ?? []).map((p) => p.name).join(', ');
    die(`no project matched '${project}'. Known projects: ${names}`);
  }
  if (!match.githubRepoFullName) {
    die(`project '${match.name}' is not bound to a GitHub repository`);
  }

  const minted = await callTool(url, apiKey, 'get_repo_token', { projectId: match.id });
  if (!minted?.token) die('get_repo_token returned no token');

  if (printRemote) {
    // The authenticated push URL, for `git remote set-url` / a one-off push.
    process.stdout.write(`${minted.cloneUrl}\n`);
    return;
  }

  // The token reaches the child through its env — never through argv, so it
  // stays out of shell history, `ps` output and the calling transcript.
  const env = { ...process.env, GH_TOKEN: minted.token, GH_HOST: 'github.com' };

  // git mode: the repo's own remote may be an ssh alias that does not resolve
  // here, so address the HTTPS URL directly and authenticate through an inline
  // credential helper that reads GH_TOKEN out of the environment.
  const [command, args] = git
    ? [
        'git',
        [
          '-c',
          `credential.helper=${GIT_CREDENTIAL_HELPER}`,
          ...ghArgs.map((a) =>
            a === '@origin' ? `https://github.com/${match.githubRepoFullName}.git` : a,
          ),
        ],
      ]
    : [
        'gh',
        // `--repo` goes after the subcommand (it is a subcommand flag, not
        // global), and only when the caller did not already aim gh somewhere.
        skipRepoFlag(ghArgs) ? ghArgs : [...ghArgs, '--repo', match.githubRepoFullName],
      ];

  const child = spawn(command, args, { stdio: 'inherit', env });
  child.on('error', (error) => die(`could not run ${command}: ${error.message}`));
  child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => die(error?.message ?? String(error)));
}
