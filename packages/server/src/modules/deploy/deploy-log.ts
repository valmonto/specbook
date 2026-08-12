import { DEPLOYMENT_LOG_CAP_BYTES } from '@pkg/contracts';

/**
 * The deployment log: everything the remote ops say, scrubbed and tail-capped
 * BEFORE it touches the database — a log row must be safe to serialize to any
 * reader authorized to see the deploy, so secrets are removed at the write
 * boundary, not the read one.
 */

/** Head marker proving the log was cut; always the first line when present. */
export const LOG_TRUNCATION_MARKER = '…truncated…';

/**
 * Remove anything token-shaped: known literal secrets (the clone URL) and the
 * x-access-token credential pattern wherever it appears. Mirrors — and now
 * centralizes — the scrubbing the error column always had. ANSI escape
 * sequences go too: docker/compose color their output, and the log renders
 * as plain text where they'd show as literal glyphs.
 */
export function scrubDeployText(text: string, literals: string[] = []): string {
  let scrubbed = text;
  for (const literal of literals) {
    if (literal) scrubbed = scrubbed.replaceAll(literal, '<repo-url>');
  }
  return scrubbed
    .replace(/x-access-token:[^@\s]+@/g, 'x-access-token:***@')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

/**
 * Append a chunk keeping only the LAST `cap` bytes — during a long build the
 * newest output is the interesting end. Cuts on a line boundary and prepends
 * the truncation marker so a reader knows the head is gone.
 */
export function appendDeployLog(
  existing: string | null,
  chunk: string,
  cap: number = DEPLOYMENT_LOG_CAP_BYTES,
): string {
  const base =
    existing && existing.startsWith(LOG_TRUNCATION_MARKER)
      ? existing.slice(existing.indexOf('\n') + 1)
      : (existing ?? '');
  const joined = base + chunk;
  const buf = Buffer.from(joined, 'utf8');
  if (buf.byteLength <= cap) return joined;
  const tail = buf.subarray(buf.byteLength - cap).toString('utf8');
  const firstNewline = tail.indexOf('\n');
  return `${LOG_TRUNCATION_MARKER}\n${firstNewline >= 0 ? tail.slice(firstNewline + 1) : tail}`;
}
