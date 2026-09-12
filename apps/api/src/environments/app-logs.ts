import { MCP_DATA_PLANE_LIMITS } from '@pkg/contracts';

/**
 * The shared half of "read a deployed unit's container logs".
 *
 * Two callers want it and must not drift: a human through
 * `GET /environments/:id/logs`, and an agent through `data_plane_logs`. They
 * differ ONLY in who may ask — the agent needs a live grant and writes an
 * audit row, the human needs neither, the same way the deploy log has always
 * been there to click. What gets run and how it is bounded is identical, so it
 * lives here as plain functions rather than in either module (a Nest provider
 * would put a cycle between EnvironmentModule and DataPlaneModule).
 */

export interface AppLogsQuery {
  service?: string;
  lines?: number;
}

export interface AppLogsResult {
  service: string;
  lines: number;
  text: string;
  truncated: boolean;
}

/** Clamp to the contract's window, whatever the caller asked for. */
export const logLineCount = (requested: number | undefined): number =>
  Math.min(
    Math.max(1, requested ?? MCP_DATA_PLANE_LIMITS.logsDefaultLines),
    MCP_DATA_PLANE_LIMITS.logsMaxLines,
  );

/** Positional args for the `app-logs` remote op. */
export const logOpArgs = (
  dir: string,
  unit: string,
  query: AppLogsQuery,
): [string, string, string, string] => [
  dir,
  unit,
  query.service ?? '',
  String(logLineCount(query.lines)),
];

/**
 * Cap by BYTES as well as lines, and keep the NEWEST end.
 *
 * A line cap alone does not bound the output: one stack trace can be longer
 * than the whole tail it arrived in, and the interesting part of a log is
 * always the bottom. Truncation is marked in-band rather than silent, so a
 * reader can tell "nothing else happened" from "we stopped showing you".
 */
const TRUNCATION_MARKER = '… earlier output dropped …\n';

export const capLogText = (out: string, service: string, lines: number): AppLogsResult => {
  const max = MCP_DATA_PLANE_LIMITS.logsMaxBytes;
  const bytes = Buffer.from(out, 'utf8');
  if (bytes.byteLength <= max) {
    return { service: service || 'all', lines, text: out, truncated: false };
  }
  // The marker counts against the budget, or a log barely over the cap comes
  // back LARGER than it went in — a cap that does not cap.
  const budget = max - Buffer.byteLength(TRUNCATION_MARKER, 'utf8');
  // Slicing bytes can land mid-character; decoding with fatal:false turns that
  // into one replacement char immediately after the marker, which is the least
  // surprising place for it.
  const tail = new TextDecoder('utf-8').decode(bytes.subarray(-budget));
  return {
    service: service || 'all',
    lines,
    text: TRUNCATION_MARKER + tail,
    truncated: true,
  };
};
