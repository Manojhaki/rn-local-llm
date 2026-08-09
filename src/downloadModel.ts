/**
 * The download orchestrator — the `downloadModel()` a consumer actually
 * calls, sequencing the pieces the rest of this library provides:
 *
 *   transfer to a temp path → hash it → compare against the manifest →
 *   atomically move into place
 *
 * Everything it touches from the outside world (the byte transfer, the
 * hasher, the filesystem) arrives as an injected port, so the
 * orchestration logic here — retry semantics, cancellation, cleanup of
 * bad bytes, the ordering guarantee that nothing reaches the destination
 * before it verifies — is fully testable with fakes, on a machine with no
 * device attached. `downloadModel.test.ts` does exactly that.
 *
 * This file has no native dependency and is safe to export publicly. The
 * real implementations of these ports are the parts that need M0.
 */

import { assertChecksumMatches } from './checksum.ts';
import { checkDiskCapacity } from './diskGuard.ts';
import { initialDownloadState, transition, type DownloadState, type DownloadEvent } from './download.ts';
import { CancelledError, DownloadInterruptedError, type LocalLlmError } from './errors.ts';
import type { ModelManifest } from './manifest.ts';

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export interface TransferRequest {
  readonly url: string;
  /** Where bytes accumulate. Never the final destination — see this module's header. */
  readonly tempPath: string;
  /**
   * Byte offset to resume from, as tracked by `download.ts`'s reducer. `0`
   * means start fresh. A transport with its own opaque resume mechanism
   * (expo-file-system's `DownloadPauseState`, for one) is responsible for
   * bridging this to whatever it actually needs.
   */
  readonly resumeFromBytes: number;
  readonly onProgress: (bytesDownloaded: number) => void;
}

export interface TransferHandle {
  cancel(): void;
  /** Resolves when every byte has landed in `tempPath`; rejects on transport failure. */
  readonly completed: Promise<void>;
}

export interface ModelTransfer {
  start(request: TransferRequest): TransferHandle;
}

export interface FileHasher {
  /** @returns the file's SHA-256 as lowercase hex. */
  computeSha256(path: string): Promise<string>;
}

export interface ModelFileStore {
  delete(path: string): Promise<void>;
  /** Must be atomic — a half-moved model file is worse than no model file. */
  move(fromPath: string, toPath: string): Promise<void>;
  /** Free space on the volume holding the temp path, for the preflight check. */
  freeDiskBytes(): Promise<number>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DownloadModelOptions {
  readonly manifest: ModelManifest;
  readonly tempPath: string;
  readonly destinationPath: string;
  readonly transfer: ModelTransfer;
  readonly hasher: FileHasher;
  readonly store: ModelFileStore;
  /**
   * Resume offset from a previous run that died before finishing — read it
   * from wherever the host persisted the last `onStateChange` state.
   * @default 0
   */
  readonly resumeFromBytes?: number;
  /**
   * Total attempts before giving up, including the first. Retries follow
   * `download.ts`'s semantics: a transport interruption resumes from the
   * bytes already on disk, a checksum mismatch restarts from zero.
   * @default 3
   */
  readonly maxAttempts?: number;
  /**
   * Free disk space to insist on beyond the bytes still to be written,
   * checked once before the transfer starts.
   * @default 0
   */
  readonly diskHeadroomBytes?: number;
  readonly onStateChange?: (state: DownloadState) => void;
}

export interface DownloadModelResult {
  readonly modelId: string;
  /** The destination path — the file is verified and in place by the time this resolves. */
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface DownloadModelHandle {
  /**
   * Cancels the download. Idempotent, and a no-op once the download has
   * already finished or failed.
   *
   * The partial file at `tempPath` is deliberately left on disk so a later
   * call can resume from it; reclaiming it is the host's job.
   */
  cancel(): void;
  /**
   * @throws {InsufficientDiskSpaceError} if the preflight check finds too little free space. Raised before any transfer begins.
   * @throws {ChecksumMismatchError} if the bytes fail verification on the final attempt.
   * @throws {DownloadInterruptedError} if the transfer, hashing, or move fails on the final attempt.
   * @throws {CancelledError} if {@link DownloadModelHandle.cancel} was called.
   */
  readonly result: Promise<DownloadModelResult>;
}

/**
 * Downloads, verifies, and installs the model described by `manifest`.
 *
 * Guarantees worth relying on:
 * - Free disk space is checked before the first byte is requested.
 * - Nothing reaches `destinationPath` until its SHA-256 matches the manifest.
 * - A checksum failure deletes the temp file before retrying, so a retry
 *   can never re-verify the same bad bytes.
 * - A transport failure leaves the temp file alone, so a retry resumes
 *   rather than restarting.
 *
 * @throws {Error} synchronously if the manifest's source is `bundled` — a
 * bundled model ships with the app and has nothing to download. That's a
 * caller bug, not a runtime condition, so it isn't a `LocalLlmError`.
 */
export function downloadModel(options: DownloadModelOptions): DownloadModelHandle {
  const { manifest, tempPath, destinationPath, transfer, hasher, store } = options;
  const maxAttempts = options.maxAttempts ?? 3;

  if (manifest.source.kind !== 'url') {
    throw new Error(
      `Model "${manifest.id}" has a bundled source and cannot be downloaded. Bundled models ship with the app.`
    );
  }
  const url = manifest.source.url;

  let state = initialDownloadState(manifest.id);
  let cancelled = false;
  let activeTransfer: TransferHandle | undefined;

  // Locked decision #5 says everything async is cancellable, with no
  // exceptions. Awaiting the transport's own promise would make that
  // contract only as good as the transport's manners — a transport that
  // never settles after `cancel()` would hang this forever. Racing every
  // await against this signal keeps cancellation this module's guarantee
  // rather than a hope. `cancel()` on the port is still called, so native
  // resources are released either way.
  let signalCancellation: () => void = () => undefined;
  const cancellationSignal = new Promise<never>((_resolve, reject) => {
    signalCancellation = () => reject(new CancelledError('download'));
  });
  // Keeps Node from reporting an unhandled rejection when a download
  // finishes normally and nothing ever raced against this.
  cancellationSignal.catch(() => undefined);

  function untilCancelled<T>(work: Promise<T>): Promise<T> {
    return Promise.race([work, cancellationSignal]);
  }

  function dispatch(event: DownloadEvent): void {
    state = transition(state, event);
    options.onStateChange?.(state);
  }

  /** The reducer always populates `error` on a failing transition; this avoids a non-null assertion. */
  function failure(fallbackCause?: unknown): LocalLlmError {
    const recorded: LocalLlmError | undefined = state.error;
    return (
      recorded ??
      new DownloadInterruptedError(manifest.id, state.bytesDownloaded, state.totalBytes, {
        cause: fallbackCause,
      })
    );
  }

  function throwIfCancelled(): void {
    if (cancelled) {
      throw new CancelledError('download');
    }
  }

  /** Records a mid-flight failure and throws it as this library's typed error. */
  function interrupt(cause: unknown): never {
    throwIfCancelled();
    dispatch({ type: 'interrupted', cause });
    throw failure(cause);
  }

  async function runAttempt(): Promise<void> {
    // Starting a transfer after cancellation would leak it: `cancel()` has
    // already run and had no handle to pass the cancel along to, so the
    // native transfer would keep going with nothing left to stop it.
    throwIfCancelled();

    const handle = transfer.start({
      url,
      tempPath,
      resumeFromBytes: state.bytesDownloaded,
      onProgress: (bytesDownloaded) => {
        // Late progress events after a cancel or failure would hit a
        // reducer that no longer accepts them; drop them rather than
        // throwing out of the transport's own callback.
        if (state.status === 'downloading') {
          dispatch({ type: 'progress', bytesDownloaded });
        }
      },
    });
    activeTransfer = handle;

    try {
      await untilCancelled(handle.completed);
    } catch (cause) {
      interrupt(cause);
    } finally {
      activeTransfer = undefined;
    }
    throwIfCancelled();

    // A transport isn't obliged to emit a final progress event; the reducer
    // requires every byte accounted for before it will leave `downloading`.
    if (state.bytesDownloaded < state.totalBytes) {
      dispatch({ type: 'progress', bytesDownloaded: state.totalBytes });
    }
    dispatch({ type: 'transferComplete' });

    let actualSha256: string;
    try {
      // Hashing a multi-gigabyte file is not instant, so it's cancellable too.
      actualSha256 = await untilCancelled(hasher.computeSha256(tempPath));
    } catch (cause) {
      interrupt(cause);
    }
    throwIfCancelled();

    try {
      assertChecksumMatches(manifest.id, manifest.sha256, actualSha256);
    } catch {
      dispatch({ type: 'checksumFailed', expectedSha256: manifest.sha256, actualSha256 });
      // These exact bytes failed verification — they must not survive to be
      // resumed onto. `download.ts` restarts a checksum retry from zero and
      // this is what makes that honest.
      await store.delete(tempPath).catch(() => undefined);
      throw failure();
    }

    // The move happens while still `verifying`, so a failure here is
    // recoverable rather than landing in a `complete` state that lied.
    try {
      await store.move(tempPath, destinationPath);
    } catch (cause) {
      interrupt(cause);
    }

    dispatch({ type: 'checksumVerified' });
  }

  async function run(): Promise<DownloadModelResult> {
    const resumeFromBytes = options.resumeFromBytes ?? 0;

    // Preflight runs before the state machine starts: if there's no room,
    // no download ever began, so there is no download state to report and
    // nothing on disk to clean up. That's exactly why this raises
    // InsufficientDiskSpace rather than DownloadInterrupted.
    checkDiskCapacity({
      modelId: manifest.id,
      fileSizeBytes: manifest.fileSizeBytes,
      alreadyDownloadedBytes: resumeFromBytes,
      availableBytes: await untilCancelled(store.freeDiskBytes()),
      ...(options.diskHeadroomBytes === undefined ? {} : { headroomBytes: options.diskHeadroomBytes }),
    });

    throwIfCancelled();

    dispatch({
      type: 'start',
      totalBytes: manifest.fileSizeBytes,
      resumeFromBytes,
    });

    for (let attempt = 1; ; attempt += 1) {
      try {
        await runAttempt();
        return {
          modelId: manifest.id,
          path: destinationPath,
          sha256: manifest.sha256,
          bytes: manifest.fileSizeBytes,
        };
      } catch (error) {
        if (cancelled) {
          throw error instanceof CancelledError ? error : new CancelledError('download', { cause: error });
        }
        if (attempt >= maxAttempts) {
          throw error;
        }
        dispatch({ type: 'retry' });
      }
    }
  }

  return {
    cancel() {
      if (cancelled) {
        return;
      }
      cancelled = true;
      // The reducer only accepts `cancel` from an active status, but
      // cancellation itself must work from any point — including before
      // the preflight check has resolved, when the reducer is still idle.
      // Gating the whole method on the reducer's status would silently
      // drop a cancel issued in that window.
      if (state.status === 'downloading' || state.status === 'verifying') {
        dispatch({ type: 'cancel' });
      }
      activeTransfer?.cancel();
      signalCancellation();
    },
    result: run(),
  };
}
