import { Duplex, PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SshService } from '../../../src/modules/ssh/ssh.service.js';

/**
 * These drive pipeOp's REAL wiring, not its decision function.
 *
 * An earlier fix here had a mutation-checked unit test on the stall predicate.
 * The predicate was correct and the fix shipped broken anyway, because the flag
 * it reads is set from an event that never fired. Testing the decision while
 * leaving the trigger unexercised is how four transfers were failed after
 * delivering every byte.
 */

/**
 * An ssh2 exec channel: writes go to the remote process's STDIN, reads come
 * from its STDOUT. They are independent — a PassThrough conflates them, so the
 * script written to stdin reappears as output, which hides the very bug this
 * file exists to pin.
 */
function channel() {
  const stdout = new PassThrough();
  const ch = new Duplex({
    emitClose: false,
    write(_chunk, _enc, cb) {
      cb(); // remote stdin: consumed, never echoed back
    },
    read() {
      // fed from `stdout` below
    },
  }) as Duplex & { stderr: PassThrough; stdout: PassThrough };
  stdout.on('data', (d: Buffer) => ch.push(d));
  stdout.on('end', () => ch.push(null));
  ch.stderr = new PassThrough();
  ch.stdout = stdout;
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
    // under test from firing and the tests would pass for the wrong reason.
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
   * THE root cause. pipeOp wrote the script to the source's stdin and left it
   * open, so `bash -s` delivered the whole image and then waited forever for
   * more commands. Its channel never closed, the destination's stdin was never
   * ended, and `docker load` parked on EOF with the image already loaded — two
   * processes deadlocked on an end-of-stream that one call would have sent.
   * exec() has always used end(); pipeOp had not, so no transfer ever finished.
   */
  it('closes the source stdin so the remote shell can exit', async () => {
    const promise = run();
    await flushIO();

    expect(src.writableEnded).toBe(true);
    // The destination stays open — the image is still being piped into it.
    expect(dst.writableEnded).toBe(false);

    src.stdout.end();
    await flushIO();
    dst.emit('close', 0);
    await promise;
  });

  /** A finished source must end the destination, or `docker load` never exits. */
  it('ends the destination once the source is done', async () => {
    const promise = run();
    await flushIO();

    src.stdout.write(Buffer.alloc(64 * 1024));
    src.stdout.end();
    await flushIO();

    expect(dst.writableEnded).toBe(true);

    dst.emit('close', 0);
    await promise;
  });

  /** The safety net still has to catch a link that is actually dead. */
  it('still fails a transfer that is silent past the stall window', async () => {
    const settled: string[] = [];
    const promise = run().then(
      () => settled.push('resolved'),
      (e: Error) => settled.push(`rejected: ${e.message}`),
    );

    await flushIO();
    src.stdout.write(Buffer.alloc(1024)); // some bytes, then the link dies
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
    src.stdout.write(Buffer.alloc(512));
    src.emit('close'); // no code
    await flushIO();

    dst.emit('close', 0);
    await promise;
    expect(settled).toEqual(['resolved']);
  });

  /**
   * THE last deadlock. `docker load` prints "Loaded image: <tag>" on stdout.
   * pipeOp read the destination's stderr and never its stdout — and a Node
   * readable nobody reads never ends, so the channel never emitted 'close'
   * and the transfer waited out its 45-minute ceiling with every byte already
   * delivered and the remote command already exited. exec() has always
   * consumed stdout; pipeOp did not.
   */
  it('consumes the destination stdout, and reports what it said', async () => {
    const lines: string[] = [];
    const promise = run((l) => lines.push(l));
    await flushIO();

    src.stdout.write(Buffer.alloc(2048));
    src.stdout.end();
    await flushIO();

    // The far end announces itself on stdout, then exits.
    dst.stdout.write(Buffer.from('Loaded image: unit-api:abc123\n'));
    await flushIO();

    expect(lines.some((l) => l.includes('Loaded image: unit-api:abc123'))).toBe(true);

    dst.emit('close', 0);
    await promise;
  });

  /** The transfer used to print nothing at all for its entire duration. */
  it('reports how many bytes have moved while the transfer runs', async () => {
    const lines: string[] = [];
    const promise = run((l) => lines.push(l));

    await flushIO();
    src.stdout.write(Buffer.alloc(64 * 1024));
    await flushIO();
    await vi.advanceTimersByTimeAsync(6_000);

    expect(lines.some((l) => /^transfer: .*B \(.*B\/s\)$/.test(l))).toBe(true);

    src.stdout.end();
    await flushIO();
    dst.emit('close', 0);
    await promise;
  });
});
