import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SshService } from '../../../src/modules/ssh/ssh.service.js';

/**
 * These drive pipeOp's REAL wiring, not its decision function.
 *
 * The stall predicate was extracted, unit-tested and mutation-checked — and
 * the fix still shipped broken, because the flag it reads is set from an event
 * that never fires while the source is paused under backpressure. Testing the
 * decision and leaving the trigger unexercised is how four transfers were
 * failed after delivering every byte.
 */

/** An ssh2-shaped channel. Nothing reads `dst`, so it applies backpressure. */
function channel() {
  const ch = new PassThrough({ emitClose: false }) as PassThrough & { stderr: PassThrough };
  ch.stderr = new PassThrough();
  return ch;
}

function fakeClient(ch: ReturnType<typeof channel>) {
  return {
    exec: (_cmd: string, cb: (err: Error | null, stream: unknown) => void) => cb(null, ch),
    end: () => undefined,
    on: () => undefined,
  };
}

describe('pipeOp transfer lifecycle', () => {
  let service: SshService;
  let src: ReturnType<typeof channel>;
  let dst: ReturnType<typeof channel>;

  beforeEach(() => {
    // Fake ONLY the wall-clock timers pipeOp arms. Streams deliver 'data' and
    // 'end' through nextTick/setImmediate; faking those would stop the events
    // under test from firing and the test would pass for the wrong reason.
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    service = new SshService();
    src = channel();
    dst = channel();
    let call = 0;
    // pipeOp connects to the source first, then the destination.
    (service as unknown as { connect: () => Promise<unknown> }).connect = () =>
      Promise.resolve({ client: fakeClient(call++ === 0 ? src : dst), fingerprint: 'x' });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Let real stream events (nextTick/setImmediate) drain. */
  const flushIO = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  };

  const run = (onProgress?: (l: string) => void) =>
    service.pipeOp(
      {} as never,
      'image-export',
      ['img'],
      {} as never,
      'image-import',
      undefined,
      onProgress,
    );

  /**
   * THE regression. A big write fills the destination, Node pauses the source,
   * and the byte counter goes quiet while `docker load` works. Under the old
   * 120s window this rejected — after every byte had already been delivered.
   */
  it('survives a backpressure pause far longer than the old 120s window', async () => {
    const settled: string[] = [];
    const promise = run().then(
      () => settled.push('resolved'),
      (e: Error) => settled.push(`rejected: ${e.message}`),
    );

    await flushIO();
    src.write(Buffer.alloc(1024 * 1024)); // fills dst, pauses src
    src.end();
    await flushIO();

    // Five minutes of silence: fatal before, fine now.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(settled).toEqual([]);

    dst.emit('close', 0);
    await promise;
    expect(settled).toEqual(['resolved']);
  });

  /** The safety net still has to catch a link that is actually dead. */
  it('still fails a transfer that is silent past the stall window', async () => {
    const settled: string[] = [];
    const promise = run().then(
      () => settled.push('resolved'),
      (e: Error) => settled.push(`rejected: ${e.message}`),
    );

    await flushIO();
    src.write(Buffer.alloc(1024));
    await flushIO();
    await vi.advanceTimersByTimeAsync(25 * 60_000);

    await promise;
    expect(settled[0]).toMatch(/transfer stalled/);
  });

  /**
   * ssh2 may close a channel without an exit code. Treating that as `!== 0`
   * would fail a transfer that worked; the destination's exit code is what
   * actually gates success.
   */
  it('treats a close with no exit code as success, not "exited undefined"', async () => {
    const settled: string[] = [];
    const promise = run().then(
      () => settled.push('resolved'),
      (e: Error) => settled.push(`rejected: ${e.message}`),
    );

    await flushIO();
    src.write(Buffer.alloc(512));
    src.emit('close'); // no code
    await flushIO();

    dst.emit('close', 0);
    await promise;
    expect(settled).toEqual(['resolved']);
  });

  /** The transfer used to print nothing at all for its entire duration. */
  it('reports how many bytes have moved while the transfer runs', async () => {
    const lines: string[] = [];
    const promise = run((l) => lines.push(l));

    await flushIO();
    src.write(Buffer.alloc(64 * 1024));
    await flushIO();
    await vi.advanceTimersByTimeAsync(6_000);

    expect(lines.some((l) => /^transfer: .*B \(.*B\/s\)$/.test(l))).toBe(true);

    dst.emit('close', 0);
    await promise;
  });
});
