#!/usr/bin/env node
/**
 * keep-claim-alive.mjs — a BUILD_LIFECYCLE_HOOK consumer that keeps a dispatched
 * build's CLAIM fresh for as long as the build is actively running, so the
 * 30-minute stale-claim auto-release never fires on a LIVE build.
 *
 * WHY THIS EXISTS: the agent-sweep worker releases an `in_progress` task back to
 * `ready` when the claimant's most-recent agent `last_seen_at` goes silent past
 * STALE_CLAIM_AFTER_MS (30 min — packages/contracts/src/constants/agent.ts). A
 * legitimate ~50-minute build makes no MCP calls while it compiles/tests, so its
 * agent looks dead and the claim is yanked mid-work. This hook closes that gap:
 * `scripts/build-liveness.mjs` already emits a `start → heartbeat* → end` event
 * stream and invokes BUILD_LIFECYCLE_HOOK once per event with the event JSON in
 * BUILD_EVENT. On each `start`/`heartbeat`, we call the MCP `heartbeat` tool,
 * which stamps `agent.last_seen_at = now` for the calling key — exactly what an
 * ordinary MCP call would have done, on the build's cadence instead of silence.
 *
 * THE SAFETY NET IS PRESERVED, NOT WEAKENED. We stamp ONLY on `start`/`heartbeat`
 * — never on `end`/`timeout`. So a genuinely dead runner (its build-liveness
 * process gone, emitting no more heartbeats) stops being stamped and the existing
 * 30-min sweep releases it. Two complementary nets, both intact: build-liveness's
 * hard per-build timeout ends a hung BUILD; the stale-claim sweep releases a dead
 * RUNNER. This hook only bridges the middle — a live build's claim stays fresh.
 *
 * IDENTITY / TENANCY: unchanged. The stamp is attributed to the presenting API
 * key (Bearer), resolved server-side by McpAuthGuard — never from a payload. The
 * hook adds no server code and touches no repository: it is a client that calls
 * the same authenticated `heartbeat` tool a session already uses. Use the runner's
 * own `tasks:agent`-scoped key so the stamp lands on the claimant's agent row.
 *
 * BEST-EFFORT, NEVER FATAL: like every build-liveness hook, this must never fail
 * or slow a build. Unset credentials, a network error, a non-2xx — all are logged
 * to stderr and swallowed. build-liveness spawns us fire-and-forget (stdio
 * ignored, unref'd), so our exit code is irrelevant; we exit 0 regardless.
 *
 * CONFIG (env — documented in .claude/commands/dispatch.md):
 *   SPECBOOK_API_KEY   (required)  Bearer key with the `tasks:agent` scope; the
 *                                  runner's own key so the stamp is the claimant's.
 *                                  Absent → the hook no-ops (nothing to stamp with).
 *   SPECBOOK_MCP_URL   full MCP endpoint URL. Falls back to
 *                      `${SPECBOOK_BASE_URL}/api/mcp`, then to the prod endpoint.
 *   SPECBOOK_BASE_URL  base host (e.g. https://specbook.valmonto.com) — `/api/mcp`
 *                      is appended.
 *
 * The specbook MCP endpoint is stateless Streamable-HTTP
 * (`sessionIdGenerator: undefined`), so a single `tools/call` POST needs no
 * initialize handshake and no session header.
 *
 * USAGE (wired by the dispatcher, not called by hand):
 *   BUILD_LIFECYCLE_HOOK='node scripts/keep-claim-alive.mjs' \
 *   SPECBOOK_API_KEY=sk_… SPECBOOK_MCP_URL=https://specbook.valmonto.com/api/mcp \
 *   node scripts/build-liveness.mjs --label <taskId> -- <build command>
 */
import { pathToFileURL } from 'node:url';

// ── Pure, exported, unit-tested core (no I/O, no fetch) ──────────────────────

/** Prod MCP endpoint — the last-resort default when no URL env is given. */
export const DEFAULT_MCP_URL = 'https://specbook.valmonto.com/api/mcp';

/** How long a single heartbeat POST may take before we give up (best-effort). */
export const HEARTBEAT_TIMEOUT_MS = 10_000;

/**
 * Lifecycle events on which we refresh the claim. Stamp at `start` (immediate
 * freshness) and every `heartbeat` (keeps it fresh). NEVER on `end`/`timeout`:
 * once a build stops heartbeating, silence must be allowed to accrue so a dead
 * runner is still released by the existing stale-claim sweep.
 */
export const STAMP_EVENTS = Object.freeze(['start', 'heartbeat']);

/**
 * Parse the BUILD_EVENT env value (one JSON line emitted by build-liveness).
 * Never throws — a torn or absent value is simply "no event".
 * @param {unknown} raw
 * @returns {Record<string, unknown> | null}
 */
export function parseBuildEvent(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Decide whether this lifecycle event should refresh the claim.
 * @param {Record<string, unknown> | null} event
 * @returns {boolean}
 */
export function shouldStamp(event) {
  return !!event && typeof event.event === 'string' && STAMP_EVENTS.includes(event.event);
}

/**
 * Resolve the MCP endpoint + credential from an env-like object. The API key is
 * the gate: without it there is nothing to stamp with, so return null and let
 * the caller no-op. URL precedence: SPECBOOK_MCP_URL → SPECBOOK_BASE_URL+/api/mcp
 * → the prod default.
 * @param {Record<string, string | undefined>} env
 * @returns {{ url: string, apiKey: string } | null}
 */
export function resolveHeartbeatConfig(env = {}) {
  const apiKey = (env.SPECBOOK_API_KEY ?? '').trim();
  if (apiKey === '') return null;
  const explicitUrl = (env.SPECBOOK_MCP_URL ?? '').trim();
  const base = (env.SPECBOOK_BASE_URL ?? '').trim();
  const url =
    explicitUrl !== ''
      ? explicitUrl
      : base !== ''
        ? `${base.replace(/\/+$/, '')}/api/mcp`
        : DEFAULT_MCP_URL;
  return { url, apiKey };
}

/**
 * Build the JSON-RPC `tools/call` request that stamps the claimant heartbeat.
 * Pure: returns the URL and fetch init, sends nothing.
 * @param {{ url: string, apiKey: string }} config
 * @returns {{ url: string, init: { method: string, headers: Record<string,string>, body: string } }}
 */
export function buildHeartbeatRequest({ url, apiKey }) {
  return {
    url,
    init: {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        // Streamable-HTTP replies with an SSE stream by default; accept both.
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'heartbeat', arguments: {} },
      }),
    },
  };
}

/**
 * Extract the JSON-RPC message from a Streamable-HTTP response body. The server
 * frames it as SSE (`event: message\ndata: {json}\n\n`) but may also send raw
 * JSON; handle both. Returns the parsed message, or null if unparseable.
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

// ── CLI (only when executed directly; inert when imported by the test) ────────

function warn(message) {
  process.stderr.write(`keep-claim-alive: ${message}\n`);
}

async function main() {
  const event = parseBuildEvent(process.env.BUILD_EVENT);
  if (!shouldStamp(event)) return; // end/timeout/unknown — let silence accrue

  const config = resolveHeartbeatConfig(process.env);
  if (!config) {
    warn('SPECBOOK_API_KEY unset — cannot stamp claimant heartbeat; skipping');
    return;
  }

  const { url, init } = buildHeartbeatRequest(config);
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS) });
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      warn(`heartbeat POST returned ${res.status} on '${event.event}'`);
      return;
    }
    const payload = extractMcpPayload(text);
    if (payload && payload.error) {
      const err = payload.error;
      warn(`heartbeat tool error: ${(err && err.message) ?? JSON.stringify(err)}`);
    }
    // success → agent.last_seen_at freshly stamped; stay quiet (best-effort hook)
  } catch (error) {
    warn(`heartbeat request failed: ${error?.message ?? error}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => warn(`unexpected: ${error?.message ?? error}`));
}
