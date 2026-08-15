import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

// The claim-keepalive hook is a plain .mjs tool in scripts/; we import its PURE
// core directly (no fetch, no network) and drive its CLI against a local mock of
// the MCP endpoint to prove the one behaviour that matters: a LIVE build's
// heartbeat stamps the claim, and nothing else does.
// @ts-expect-error — untyped .mjs tool imported for its exported pure functions.
import * as keepClaimAlive from '../../../../scripts/keep-claim-alive.mjs';

const { DEFAULT_MCP_URL, STAMP_EVENTS, parseBuildEvent, shouldStamp, resolveHeartbeatConfig, buildHeartbeatRequest, extractMcpPayload } =
  keepClaimAlive;

const SCRIPT = resolve(__dirname, '../../../../scripts/keep-claim-alive.mjs');

describe('keep-claim-alive: parseBuildEvent', () => {
  it('parses a build-liveness event line into an object', () => {
    const line = JSON.stringify({ build: 'task-1', event: 'heartbeat', elapsedMs: 60_000 });
    expect(parseBuildEvent(line)).toMatchObject({ event: 'heartbeat', build: 'task-1' });
  });

  it('returns null for absent, empty, torn, or non-object input (never throws)', () => {
    expect(parseBuildEvent(undefined)).toBeNull();
    expect(parseBuildEvent('')).toBeNull();
    expect(parseBuildEvent('   ')).toBeNull();
    expect(parseBuildEvent('{"event":"heartbeat"')).toBeNull(); // torn mid-write
    expect(parseBuildEvent('42')).toBeNull();
    expect(parseBuildEvent('[1,2]')).toBeNull(); // array, not an event object
  });
});

describe('keep-claim-alive: shouldStamp — refresh only while the build is live', () => {
  it('stamps on start and every heartbeat (keeps a live build fresh)', () => {
    expect(shouldStamp({ event: 'start' })).toBe(true);
    expect(shouldStamp({ event: 'heartbeat' })).toBe(true);
    expect(STAMP_EVENTS).toEqual(['start', 'heartbeat']);
  });

  it('does NOT stamp on end/timeout — a finished or dead build must go stale', () => {
    // This is the safety net: once heartbeats stop, silence accrues and the
    // existing 30-min stale-claim sweep releases a genuinely dead runner.
    expect(shouldStamp({ event: 'end' })).toBe(false);
    expect(shouldStamp({ event: 'timeout' })).toBe(false);
    expect(shouldStamp({ event: 'weird' })).toBe(false);
    expect(shouldStamp(null)).toBe(false);
    expect(shouldStamp({})).toBe(false);
  });
});

describe('keep-claim-alive: resolveHeartbeatConfig', () => {
  it('requires an API key — without it there is nothing to stamp with', () => {
    expect(resolveHeartbeatConfig({})).toBeNull();
    expect(resolveHeartbeatConfig({ SPECBOOK_API_KEY: '   ' })).toBeNull();
    expect(resolveHeartbeatConfig({ SPECBOOK_MCP_URL: 'https://x/api/mcp' })).toBeNull();
  });

  it('resolves the URL by precedence: explicit → base+/api/mcp → prod default', () => {
    expect(resolveHeartbeatConfig({ SPECBOOK_API_KEY: 'k' })).toEqual({ url: DEFAULT_MCP_URL, apiKey: 'k' });
    expect(resolveHeartbeatConfig({ SPECBOOK_API_KEY: 'k', SPECBOOK_BASE_URL: 'https://h.test/' })).toEqual({
      url: 'https://h.test/api/mcp',
      apiKey: 'k',
    });
    expect(
      resolveHeartbeatConfig({ SPECBOOK_API_KEY: 'k', SPECBOOK_BASE_URL: 'https://h.test', SPECBOOK_MCP_URL: 'https://explicit/api/mcp' }),
    ).toEqual({ url: 'https://explicit/api/mcp', apiKey: 'k' });
  });
});

describe('keep-claim-alive: buildHeartbeatRequest', () => {
  it('POSTs a JSON-RPC tools/call for the `heartbeat` tool with the Bearer key', () => {
    const { url, init } = buildHeartbeatRequest({ url: 'https://h.test/api/mcp', apiKey: 'sk_abc' });
    expect(url).toBe('https://h.test/api/mcp');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer sk_abc');
    expect(init.headers.Accept).toContain('text/event-stream');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'heartbeat' } });
  });
});

describe('keep-claim-alive: extractMcpPayload', () => {
  it('reads the JSON-RPC message out of an SSE-framed body', () => {
    const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n';
    expect(extractMcpPayload(sse)).toMatchObject({ result: { ok: true } });
  });

  it('also reads a raw JSON body, and null for anything unparseable', () => {
    expect(extractMcpPayload('{"jsonrpc":"2.0","id":1,"error":{"message":"nope"}}')).toMatchObject({
      error: { message: 'nope' },
    });
    expect(extractMcpPayload('')).toBeNull();
    expect(extractMcpPayload('not json')).toBeNull();
  });
});

/**
 * End-to-end proof of the ticket's behaviour, against a local mock of the MCP
 * endpoint: a heartbeat event DOES stamp the claim (one POST carrying the
 * `heartbeat` tool call + Bearer key); an `end` event and a missing key do NOT.
 */
describe('keep-claim-alive CLI against a mock MCP endpoint', () => {
  const exec = promisify(execFile);
  let server: Server;
  let endpoint: string;
  const received: { method: string; url: string; auth?: string; body: string }[] = [];

  const readBody = (req: IncomingMessage) =>
    new Promise<string>((res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => res(data));
    });

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      received.push({
        method: req.method ?? '',
        url: req.url ?? '',
        auth: req.headers.authorization,
        body: await readBody(req),
      });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[]}}\n\n');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    endpoint = `http://127.0.0.1:${port}/api/mcp`;
  });

  afterEach(() => {
    received.length = 0;
  });

  afterAll(() => {
    server.close();
  });

  const run = (buildEvent: string, extraEnv: Record<string, string> = {}) =>
    exec('node', [SCRIPT], {
      env: { ...process.env, BUILD_EVENT: buildEvent, SPECBOOK_MCP_URL: endpoint, SPECBOOK_API_KEY: 'sk_test', ...extraEnv },
    });

  it('stamps the claim on a live heartbeat — one heartbeat tools/call reaches the endpoint', async () => {
    await run(JSON.stringify({ build: 'task-1', event: 'heartbeat', elapsedMs: 60_000 }));
    expect(received).toHaveLength(1);
    const req = received[0]!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/api/mcp');
    expect(req.auth).toBe('Bearer sk_test');
    expect(JSON.parse(req.body)).toMatchObject({ method: 'tools/call', params: { name: 'heartbeat' } });
  });

  it('does NOT stamp on end — a finished build sends nothing, so the claim can go stale', async () => {
    await run(JSON.stringify({ build: 'task-1', event: 'end', reason: 'success' }));
    expect(received).toHaveLength(0);
  });

  it('no-ops (no POST) when no API key is configured', async () => {
    await run(JSON.stringify({ build: 'task-1', event: 'heartbeat' }), { SPECBOOK_API_KEY: '' });
    expect(received).toHaveLength(0);
  });
});
