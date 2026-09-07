import { describe, expect, it } from 'vitest';
import { REMOTE_OPS } from '../../../src/modules/ssh/remote-ops.js';

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
