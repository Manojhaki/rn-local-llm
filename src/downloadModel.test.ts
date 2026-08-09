import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  downloadModel,
  type FileHasher,
  type ModelFileStore,
  type ModelTransfer,
  type TransferHandle,
  type TransferRequest,
} from './downloadModel.ts';
import {
  CancelledError,
  ChecksumMismatchError,
  DownloadInterruptedError,
  InsufficientDiskSpaceError,
} from './errors.ts';
import type { DownloadState } from './download.ts';
import type { ModelManifest } from './manifest.ts';

const GOOD_SHA = 'a'.repeat(64);
const BAD_SHA = 'b'.repeat(64);
const TOTAL_BYTES = 1000;

function manifest(overrides: Partial<ModelManifest> = {}): ModelManifest {
  return {
    id: 'qwen3-1.7b-q4',
    backend: 'llama.cpp',
    quantization: 'Q4_K_M',
    fileSizeBytes: TOTAL_BYTES,
    sha256: GOOD_SHA,
    minRamBytes: 3_000_000_000,
    contextLength: 4096,
    source: { kind: 'url', url: 'https://example.com/model.gguf' },
    ...overrides,
  };
}

/**
 * A transport whose every attempt is scripted. Each entry describes what
 * the nth transfer should do, so a test can say "fail the first attempt,
 * succeed the second" without any timing games.
 */
type Script =
  | { kind: 'succeed'; emitProgress?: number }
  | { kind: 'fail'; cause?: unknown }
  /** In flight until cancelled, which rejects it — how a well-behaved transport acts. */
  | { kind: 'pending' }
  /** Never settles, even after cancel() — a badly-behaved transport, deliberately. */
  | { kind: 'hang' };

class FakeTransfer implements ModelTransfer {
  readonly requests: TransferRequest[] = [];
  cancelCount = 0;
  #scripts: Script[];

  constructor(scripts: Script[]) {
    this.#scripts = scripts;
  }

  start(request: TransferRequest): TransferHandle {
    this.requests.push(request);
    const script = this.#scripts.shift() ?? { kind: 'succeed' };

    if (script.kind === 'hang') {
      return {
        cancel: () => {
          this.cancelCount += 1;
        },
        completed: new Promise<void>(() => undefined),
      };
    }

    if (script.kind === 'pending') {
      let rejectCompleted: (reason: unknown) => void = () => undefined;
      const completed = new Promise<void>((_resolve, reject) => {
        rejectCompleted = reject;
      });
      completed.catch(() => undefined);
      return {
        cancel: () => {
          this.cancelCount += 1;
          rejectCompleted(new Error('cancelled by caller'));
        },
        completed,
      };
    }

    if (script.kind === 'fail') {
      return {
        cancel: () => {
          this.cancelCount += 1;
        },
        completed: Promise.reject(script.cause ?? new Error('transport blew up')),
      };
    }

    const emitted = script.emitProgress;
    if (emitted !== undefined) {
      request.onProgress(emitted);
    }
    return {
      cancel: () => {
        this.cancelCount += 1;
      },
      completed: Promise.resolve(),
    };
  }
}

class FakeHasher implements FileHasher {
  calls = 0;
  #results: (string | Error)[];

  constructor(results: (string | Error)[]) {
    this.#results = results;
  }

  async computeSha256(): Promise<string> {
    this.calls += 1;
    const next = this.#results.shift() ?? GOOD_SHA;
    if (next instanceof Error) throw next;
    return next;
  }
}

class FakeStore implements ModelFileStore {
  readonly deleted: string[] = [];
  readonly moved: { from: string; to: string }[] = [];
  moveError: Error | undefined;
  /** Generous by default, so tests opt in to disk pressure rather than tripping over it. */
  freeBytes = Number.MAX_SAFE_INTEGER;
  freeDiskCalls = 0;
  /** Ordered log of every side effect, for asserting that verify precedes move. */
  readonly log: string[] = [];

  async freeDiskBytes(): Promise<number> {
    this.freeDiskCalls += 1;
    return this.freeBytes;
  }

  async delete(path: string): Promise<void> {
    this.deleted.push(path);
    this.log.push(`delete:${path}`);
  }

  async move(fromPath: string, toPath: string): Promise<void> {
    this.log.push(`move:${fromPath}->${toPath}`);
    if (this.moveError) throw this.moveError;
    this.moved.push({ from: fromPath, to: toPath });
  }
}

interface Harness {
  transfer: FakeTransfer;
  hasher: FakeHasher;
  store: FakeStore;
  states: DownloadState[];
}

function run(
  opts: {
    scripts?: Script[];
    hashes?: (string | Error)[];
    maxAttempts?: number;
    resumeFromBytes?: number;
    manifestOverrides?: Partial<ModelManifest>;
    moveError?: Error;
    freeBytes?: number;
    diskHeadroomBytes?: number;
  } = {}
): { handle: ReturnType<typeof downloadModel>; harness: Harness } {
  const transfer = new FakeTransfer(opts.scripts ?? [{ kind: 'succeed', emitProgress: TOTAL_BYTES }]);
  const hasher = new FakeHasher(opts.hashes ?? [GOOD_SHA]);
  const store = new FakeStore();
  if (opts.moveError) store.moveError = opts.moveError;
  if (opts.freeBytes !== undefined) store.freeBytes = opts.freeBytes;
  const states: DownloadState[] = [];

  const handle = downloadModel({
    manifest: manifest(opts.manifestOverrides),
    tempPath: '/tmp/model.gguf.part',
    destinationPath: '/models/model.gguf',
    transfer,
    hasher,
    store,
    ...(opts.maxAttempts === undefined ? {} : { maxAttempts: opts.maxAttempts }),
    ...(opts.resumeFromBytes === undefined ? {} : { resumeFromBytes: opts.resumeFromBytes }),
    ...(opts.diskHeadroomBytes === undefined ? {} : { diskHeadroomBytes: opts.diskHeadroomBytes }),
    onStateChange: (s) => states.push(s),
  });

  return { handle, harness: { transfer, hasher, store, states } };
}

/**
 * Yields until the transfer is actually in flight. The free-disk precheck
 * is async, so a `cancel()` issued synchronously after `downloadModel()`
 * lands *before* any transfer starts — a genuinely different case, covered
 * by its own test.
 */
async function whenTransferring(harness: Harness): Promise<void> {
  for (let i = 0; i < 50 && harness.transfer.requests.length === 0; i += 1) {
    await Promise.resolve();
  }
  assert.ok(harness.transfer.requests.length > 0, 'expected a transfer to have started');
}

describe('downloadModel — happy path', () => {
  test('resolves with the destination path after verifying and moving', async () => {
    const { handle, harness } = run();
    const result = await handle.result;

    assert.equal(result.modelId, 'qwen3-1.7b-q4');
    assert.equal(result.path, '/models/model.gguf');
    assert.equal(result.sha256, GOOD_SHA);
    assert.equal(result.bytes, TOTAL_BYTES);
    assert.deepEqual(harness.store.moved, [{ from: '/tmp/model.gguf.part', to: '/models/model.gguf' }]);
  });

  test('downloads to the temp path, never straight to the destination', async () => {
    const { handle, harness } = run();
    await handle.result;
    assert.equal(harness.transfer.requests[0]?.tempPath, '/tmp/model.gguf.part');
  });

  test('reaches the complete status', async () => {
    const { handle, harness } = run();
    await handle.result;
    assert.equal(harness.states.at(-1)?.status, 'complete');
  });

  test('moves into place only after the hash is verified', async () => {
    const { handle, harness } = run();
    await handle.result;
    // Hashing happens before any filesystem move; the log's only entry is the move.
    assert.equal(harness.hasher.calls, 1);
    assert.deepEqual(harness.store.log, ['move:/tmp/model.gguf.part->/models/model.gguf']);
  });

  test('tolerates a transport that never emits a final progress event', async () => {
    const { handle, harness } = run({ scripts: [{ kind: 'succeed' }] });
    await handle.result;
    assert.equal(harness.states.at(-1)?.status, 'complete');
  });

  test('passes resumeFromBytes through to the transport on a fresh resume', async () => {
    const { handle, harness } = run({ resumeFromBytes: 400 });
    await handle.result;
    assert.equal(harness.transfer.requests[0]?.resumeFromBytes, 400);
  });
});

describe('downloadModel — checksum failure', () => {
  test('deletes the temp file so a retry cannot re-verify the same bad bytes', async () => {
    const { handle, harness } = run({
      hashes: [BAD_SHA, GOOD_SHA],
      scripts: [
        { kind: 'succeed', emitProgress: TOTAL_BYTES },
        { kind: 'succeed', emitProgress: TOTAL_BYTES },
      ],
    });
    await handle.result;
    assert.deepEqual(harness.store.deleted, ['/tmp/model.gguf.part']);
  });

  test('retries from byte zero, not from the bytes that failed', async () => {
    const { handle, harness } = run({
      hashes: [BAD_SHA, GOOD_SHA],
      scripts: [
        { kind: 'succeed', emitProgress: TOTAL_BYTES },
        { kind: 'succeed', emitProgress: TOTAL_BYTES },
      ],
    });
    await handle.result;
    assert.equal(harness.transfer.requests[1]?.resumeFromBytes, 0);
  });

  test('never moves bad bytes into place', async () => {
    const { handle, harness } = run({ hashes: [BAD_SHA], maxAttempts: 1 });
    await assert.rejects(handle.result, ChecksumMismatchError);
    assert.deepEqual(harness.store.moved, []);
  });

  test('rejects with ChecksumMismatchError carrying both hashes once attempts run out', async () => {
    const { handle } = run({ hashes: [BAD_SHA], maxAttempts: 1 });
    await assert.rejects(handle.result, (err: unknown) => {
      assert.ok(err instanceof ChecksumMismatchError);
      assert.equal(err.expectedSha256, GOOD_SHA);
      assert.equal(err.actualSha256, BAD_SHA);
      return true;
    });
  });

  test('recovers when a later attempt verifies', async () => {
    const { handle, harness } = run({
      hashes: [BAD_SHA, GOOD_SHA],
      scripts: [
        { kind: 'succeed', emitProgress: TOTAL_BYTES },
        { kind: 'succeed', emitProgress: TOTAL_BYTES },
      ],
    });
    const result = await handle.result;
    assert.equal(result.path, '/models/model.gguf');
    assert.equal(harness.store.moved.length, 1);
  });
});

describe('downloadModel — transport interruption', () => {
  test('retries resuming from the bytes already on disk', async () => {
    const { handle, harness } = run({
      scripts: [
        { kind: 'fail', cause: new Error('ENETDOWN') },
        { kind: 'succeed', emitProgress: TOTAL_BYTES },
      ],
    });
    await handle.result;
    // Nothing was downloaded before the failure, so resume is 0 here;
    // the point is that the temp file was NOT deleted.
    assert.deepEqual(harness.store.deleted, []);
    assert.equal(harness.transfer.requests.length, 2);
  });

  test('resumes from progress reported before the interruption', async () => {
    const transfer = new FakeTransfer([]);
    // Hand-rolled: emit partial progress, then fail.
    let attempt = 0;
    const scripted: ModelTransfer = {
      start(request) {
        attempt += 1;
        if (attempt === 1) {
          request.onProgress(400);
          return { cancel: () => undefined, completed: Promise.reject(new Error('ENETDOWN')) };
        }
        transfer.requests.push(request);
        request.onProgress(TOTAL_BYTES);
        return { cancel: () => undefined, completed: Promise.resolve() };
      },
    };

    const handle = downloadModel({
      manifest: manifest(),
      tempPath: '/tmp/m.part',
      destinationPath: '/models/m.gguf',
      transfer: scripted,
      hasher: new FakeHasher([GOOD_SHA]),
      store: new FakeStore(),
    });
    await handle.result;
    assert.equal(transfer.requests[0]?.resumeFromBytes, 400);
  });

  test('rejects with DownloadInterruptedError once attempts run out', async () => {
    const { handle } = run({
      scripts: [{ kind: 'fail', cause: new Error('ENETDOWN') }],
      maxAttempts: 1,
    });
    await assert.rejects(handle.result, (err: unknown) => {
      assert.ok(err instanceof DownloadInterruptedError);
      assert.equal(err.totalBytes, TOTAL_BYTES);
      return true;
    });
  });

  test('preserves the underlying cause', async () => {
    const cause = new Error('airplane mode');
    const { handle } = run({ scripts: [{ kind: 'fail', cause }], maxAttempts: 1 });
    await assert.rejects(handle.result, (err: unknown) => {
      assert.ok(err instanceof DownloadInterruptedError);
      assert.equal(err.cause, cause);
      return true;
    });
  });

  test('stops after maxAttempts rather than retrying forever', async () => {
    const { handle, harness } = run({
      scripts: [{ kind: 'fail' }, { kind: 'fail' }, { kind: 'fail' }, { kind: 'fail' }],
      maxAttempts: 3,
    });
    await assert.rejects(handle.result, DownloadInterruptedError);
    assert.equal(harness.transfer.requests.length, 3);
  });
});

describe('downloadModel — hashing and move failures', () => {
  test('a hashing failure is interruption, not corruption — temp file survives', async () => {
    const { handle, harness } = run({ hashes: [new Error('EIO')], maxAttempts: 1 });
    await assert.rejects(handle.result, DownloadInterruptedError);
    assert.deepEqual(harness.store.deleted, []);
  });

  test('a failed move does not report success', async () => {
    const { handle } = run({ moveError: new Error('ENOSPC'), maxAttempts: 1 });
    await assert.rejects(handle.result, DownloadInterruptedError);
  });

  test('a failed move leaves the state failed, never complete', async () => {
    const { handle, harness } = run({ moveError: new Error('ENOSPC'), maxAttempts: 1 });
    await assert.rejects(handle.result);
    assert.equal(harness.states.at(-1)?.status, 'failed');
  });
});

describe('downloadModel — cancellation', () => {
  test('cancelling mid-transfer rejects with CancelledError', async () => {
    const { handle, harness } = run({ scripts: [{ kind: 'pending' }] });
    await whenTransferring(harness);
    handle.cancel();
    await assert.rejects(handle.result, CancelledError);
  });

  test('cancelling propagates to the transport', async () => {
    const { handle, harness } = run({ scripts: [{ kind: 'pending' }] });
    await whenTransferring(harness);
    handle.cancel();
    await assert.rejects(handle.result);
    assert.equal(harness.transfer.cancelCount, 1);
  });

  test('cancelling leaves the partial file on disk so it can be resumed later', async () => {
    const { handle, harness } = run({ scripts: [{ kind: 'pending' }] });
    await whenTransferring(harness);
    handle.cancel();
    await assert.rejects(handle.result);
    assert.deepEqual(harness.store.deleted, []);
  });

  test('cancelling reaches the cancelled status', async () => {
    const { handle, harness } = run({ scripts: [{ kind: 'pending' }] });
    await whenTransferring(harness);
    handle.cancel();
    await assert.rejects(handle.result);
    assert.equal(harness.states.at(-1)?.status, 'cancelled');
  });

  test('a cancelled download never moves anything into place', async () => {
    const { handle, harness } = run({ scripts: [{ kind: 'pending' }] });
    await whenTransferring(harness);
    handle.cancel();
    await assert.rejects(handle.result);
    assert.deepEqual(harness.store.moved, []);
  });

  test('cancel is idempotent', async () => {
    const { handle, harness } = run({ scripts: [{ kind: 'pending' }] });
    await whenTransferring(harness);
    handle.cancel();
    handle.cancel();
    handle.cancel();
    await assert.rejects(handle.result);
    assert.equal(harness.transfer.cancelCount, 1);
  });

  test('cancelling after completion is a no-op, not an error', async () => {
    const { handle, harness } = run();
    await handle.result;
    assert.doesNotThrow(() => handle.cancel());
    assert.equal(harness.states.at(-1)?.status, 'complete');
  });

  test('a cancelled download is not retried', async () => {
    const { handle, harness } = run({ scripts: [{ kind: 'pending' }, { kind: 'succeed' }], maxAttempts: 3 });
    await whenTransferring(harness);
    handle.cancel();
    await assert.rejects(handle.result, CancelledError);
    assert.equal(harness.transfer.requests.length, 1);
  });

  test('cancelling before the preflight check resolves still cancels', async () => {
    // cancel() lands while the reducer is still `idle` — the disk check
    // hasn't resolved, so no transfer has started. An earlier version
    // gated cancel() on the reducer's status and silently dropped this.
    const { handle, harness } = run({ scripts: [{ kind: 'pending' }] });
    handle.cancel(); // deliberately synchronous — no waiting for the transfer
    await assert.rejects(handle.result, CancelledError);
    assert.deepEqual(harness.transfer.requests, []);
  });

  test('cancels even a transport that never settles after cancel()', async () => {
    // Locked decision #5 has no exceptions: cancellation must not depend on
    // the transport being well-behaved. A `hang` script never rejects its
    // promise, so this only passes because the orchestrator races its own
    // cancellation signal rather than awaiting the transport alone.
    const { handle, harness } = run({ scripts: [{ kind: 'hang' }] });
    await whenTransferring(harness);
    handle.cancel();
    await assert.rejects(handle.result, CancelledError);
    assert.equal(harness.transfer.cancelCount, 1);
  });
});

describe('downloadModel — free-disk precheck', () => {
  test('rejects with InsufficientDiskSpaceError when there is not enough room', async () => {
    const { handle } = run({ freeBytes: 10 });
    await assert.rejects(handle.result, (err: unknown) => {
      assert.ok(err instanceof InsufficientDiskSpaceError);
      assert.equal(err.requiredBytes, TOTAL_BYTES);
      assert.equal(err.availableBytes, 10);
      return true;
    });
  });

  test('never starts a transfer it knows cannot finish', async () => {
    const { handle, harness } = run({ freeBytes: 10 });
    await assert.rejects(handle.result);
    assert.deepEqual(harness.transfer.requests, []);
  });

  test('emits no download state, because no download began', async () => {
    const { handle, harness } = run({ freeBytes: 10 });
    await assert.rejects(handle.result);
    assert.deepEqual(harness.states, []);
  });

  test('does not retry a disk-space failure — retrying cannot create space', async () => {
    const { handle, harness } = run({ freeBytes: 10, maxAttempts: 3 });
    await assert.rejects(handle.result, InsufficientDiskSpaceError);
    assert.equal(harness.store.freeDiskCalls, 1);
  });

  test('proceeds when there is exactly enough room', async () => {
    const { handle } = run({ freeBytes: TOTAL_BYTES });
    const result = await handle.result;
    assert.equal(result.path, '/models/model.gguf');
  });

  test('applies the configured headroom margin', async () => {
    const { handle } = run({ freeBytes: TOTAL_BYTES, diskHeadroomBytes: 500 });
    await assert.rejects(handle.result, (err: unknown) => {
      assert.ok(err instanceof InsufficientDiskSpaceError);
      assert.equal(err.requiredBytes, TOTAL_BYTES + 500);
      return true;
    });
  });

  test('only requires the bytes still missing when resuming', async () => {
    // 400 of 1000 bytes already on disk, so 600 free is enough.
    const { handle } = run({ resumeFromBytes: 400, freeBytes: 600 });
    const result = await handle.result;
    assert.equal(result.path, '/models/model.gguf');
  });

  test('checks the disk once up front, not on every attempt', async () => {
    const { handle, harness } = run({
      scripts: [{ kind: 'fail' }, { kind: 'succeed', emitProgress: TOTAL_BYTES }],
    });
    await handle.result;
    assert.equal(harness.store.freeDiskCalls, 1);
    assert.equal(harness.transfer.requests.length, 2);
  });
});

describe('downloadModel — caller errors', () => {
  test('throws synchronously for a bundled manifest', () => {
    assert.throws(
      () =>
        downloadModel({
          manifest: manifest({ source: { kind: 'bundled', path: 'assets://m.gguf' } }),
          tempPath: '/tmp/m.part',
          destinationPath: '/models/m.gguf',
          transfer: new FakeTransfer([]),
          hasher: new FakeHasher([]),
          store: new FakeStore(),
        }),
      /bundled source and cannot be downloaded/
    );
  });
});

describe('downloadModel — observable state', () => {
  test('reports progress through onStateChange', async () => {
    const { handle, harness } = run({ scripts: [{ kind: 'succeed', emitProgress: 600 }] });
    await handle.result;
    const progressed = harness.states.filter((s) => s.status === 'downloading').map((s) => s.bytesDownloaded);
    assert.ok(progressed.includes(600));
  });

  test('walks downloading -> verifying -> complete', async () => {
    const { handle, harness } = run();
    await handle.result;
    const statuses = harness.states.map((s) => s.status);
    assert.ok(statuses.indexOf('downloading') < statuses.indexOf('verifying'));
    assert.ok(statuses.indexOf('verifying') < statuses.indexOf('complete'));
  });
});
