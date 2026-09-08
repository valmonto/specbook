import { describe, expect, it } from 'vitest';
import { REMOTE_OPS } from '../../../src/modules/ssh/remote-ops.js';
import { isTransferStalled } from '../../../src/modules/ssh/ssh.service.js';

/**
 * The image transfer moves gigabytes across a WAN on every deploy, and its two
 * halves are shipped together by the same worker — so they must agree about
 * the wire format. A mismatch is not a type error; it is a deploy that fails
 * on the first byte, or worse, one that reports success on a truncated image.
 */
describe('image transfer wire format', () => {
  const exportOp = REMOTE_OPS['image-export'];
  const importOp = REMOTE_OPS['image-import'];

  it('compresses on the way out — these images run to gigabytes', () => {
    expect(exportOp).toMatch(/docker save "\$image" \| gzip/);
  });

  it('decompresses on the way in, matching the exporter', () => {
    expect(importOp).toMatch(/gzip -dc \| docker load/);
  });

  /**
   * Without `pipefail` a gzip failure is masked by docker load's exit code, so
   * a truncated transfer reports success and the deploy ships a broken image.
   */
  it.each([
    ['image-export', exportOp],
    ['image-import', importOp],
  ])('%s sets pipefail, so a broken pipe cannot report success', (_name, op) => {
    expect(op).toContain('set -euo pipefail');
  });

  /**
   * stdin is consumed by the first reader and cannot be replayed, so a
   * "try compressed, else raw" fallback silently loses the stream.
   */
  it('does not attempt an un-replayable fallback on stdin', () => {
    expect(importOp).not.toContain('|| docker load');
  });
});

/**
 * The transfer's liveness rule. This is the exact predicate pipeOp's interval
 * evaluates — not a restatement of it — because the last fix to this file
 * shipped a crash that its test missed by exercising a path production never
 * took.
 */
describe('transfer stall detection', () => {
  const stalled = (over: Partial<Parameters<typeof isTransferStalled>[0]> = {}) =>
    isTransferStalled({ moved: 1_000, seenAtLastCheck: 1_000, sourceDone: false, ...over });

  it('calls a transfer stalled when no bytes moved and the source is still sending', () => {
    expect(stalled()).toBe(true);
  });

  it('does not call it stalled while bytes are still arriving', () => {
    expect(stalled({ moved: 2_000, seenAtLastCheck: 1_000 })).toBe(false);
  });

  /**
   * The regression this fixes: `docker save` has exited, every byte is across,
   * `docker load` is unpacking. No source bytes arrive during that window and
   * it can outlast PIPE_STALL_MS — killing a transfer that already succeeded.
   */
  it('does not call it stalled once the source has closed cleanly', () => {
    expect(stalled({ sourceDone: true })).toBe(false);
  });

  it('stays quiet after a clean source close no matter how long the unpack takes', () => {
    // Several consecutive checks with zero new bytes — the exact shape that
    // failed four consecutive deploys at byte-identical offsets.
    for (let check = 0; check < 20; check++) {
      expect(stalled({ sourceDone: true, moved: 95_438_663, seenAtLastCheck: 95_438_663 })).toBe(
        false,
      );
    }
  });
});
