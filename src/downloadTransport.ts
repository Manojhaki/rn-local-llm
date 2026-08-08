/**
 * The download transport adapter: drives `download.ts`'s `transition()`
 * reducer from expo-file-system's real `DownloadTask`.
 *
 * **Unverified beyond `tsc --noEmit`** — same situation as `hashing.ts`.
 * `DownloadTask` is a real native module; it can't be linked or executed
 * without an actual RN/Expo app (M0), which this environment can't build.
 * No test file for the same reason: a test that can only pass vacuously or
 * crash on an unlinked native module is worse than no test. Not exported
 * from `index.ts`, for the same reason as `hashing.ts` — it would make the
 * whole public API require these native packages to be resolvable.
 *
 * What this does NOT do: checksum verification (that's `checksum.ts` +
 * `hashing.ts`, run by the caller against the `File` this resolves with —
 * same separation `download.ts` itself keeps), free-disk precheck,
 * Wi-Fi-only gating, or anything else above the transport. And it inherits
 * `DownloadTask`'s own documented gap: on Android, `sessionType`
 * (requested as `'background'` below) is explicitly ignored — no confirmed
 * true background continuation there. See CLAUDE.md.
 */

import {
  DownloadTask,
  type DownloadPauseState,
  type DownloadTaskOptions,
  type File,
  type Directory,
} from 'expo-file-system';
import { transition, initialDownloadState, type DownloadState, type DownloadEvent } from './download.ts';
import { CancelledError, DownloadInterruptedError } from './errors.ts';

/**
 * Everything needed to resume a download after this transport's in-memory
 * state is gone — a JS restart, or a full force-quit and relaunch.
 *
 * `pauseState` is expo-file-system's opaque, platform-specific resume
 * token (`DownloadPauseState.resumeData`) — it does **not** carry a byte
 * count. `bytesDownloaded` is tracked here separately, from the last
 * `progress` event this transport saw, specifically so it can be handed
 * back to `download.ts`'s `transition()` as `start`'s `resumeFromBytes`.
 * Persisting only one half of this pair loses the other.
 */
export interface PersistedDownloadState {
  readonly pauseState: DownloadPauseState;
  readonly bytesDownloaded: number;
}

export interface DownloadTransportHandle {
  /**
   * Cancels the download. A no-op if the transfer already finished, failed,
   * or was already cancelled — matching `DownloadTask.cancel()`'s own
   * documented behavior.
   */
  cancel(): void;
  /**
   * Pauses the transfer and returns everything needed to resume it later,
   * including after a full force-quit — call this from an app-background
   * or termination hook and persist the result. Only valid while the
   * transfer is actively downloading.
   *
   * @throws {Error} if the transfer isn't currently in the `downloading` state.
   */
  pauseForBackground(): Promise<PersistedDownloadState>;
}

export interface StartDownloadOptions {
  readonly modelId: string;
  readonly url: string;
  readonly destination: File | Directory;
  readonly totalBytes: number;
  /** Present when resuming after a force-quit; omit to start fresh. */
  readonly resumeFrom?: PersistedDownloadState;
  /** Called with the new state after every transition — mirror this into `onStateChange`-driven UI or persistence. */
  readonly onStateChange: (state: DownloadState) => void;
}

export interface DownloadStart {
  readonly handle: DownloadTransportHandle;
  /**
   * Resolves with the downloaded file once the transfer completes.
   * Rejects with a {@link DownloadInterruptedError} on a transport failure
   * or a {@link CancelledError} on cancellation. Deliberately never settles
   * while merely paused — see the note on {@link PersistedDownloadState}.
   */
  readonly result: Promise<File>;
}

/**
 * Starts (or resumes, via `resumeFrom`) a download, dispatching
 * `download.ts` events as the real transfer progresses.
 *
 * A `DownloadTask` pause is modeled as `download.ts`'s `interrupted` →
 * `failed` transition, not a new "paused" status: `download.ts` doesn't
 * have one, and a paused-but-resumable transfer is exactly what a
 * `DownloadInterruptedError` already means there. Resuming a fresh
 * transport instance from persisted state goes through `start`'s
 * `resumeFromBytes`, not `retry` — there is no live reducer to retry from
 * after a process restart.
 */
export function startDownload(options: StartDownloadOptions): DownloadStart {
  const { modelId, url, destination, totalBytes, resumeFrom, onStateChange } = options;

  let state: DownloadState = resumeFrom
    ? transition(initialDownloadState(modelId), {
        type: 'start',
        totalBytes,
        resumeFromBytes: resumeFrom.bytesDownloaded,
      })
    : transition(initialDownloadState(modelId), { type: 'start', totalBytes });
  onStateChange(state);

  let cancelledByUs = false;

  function dispatch(event: DownloadEvent): void {
    state = transition(state, event);
    onStateChange(state);
  }

  const taskOptions: DownloadTaskOptions = {
    sessionType: 'background',
    onProgress: (progress) => {
      dispatch({ type: 'progress', bytesDownloaded: progress.bytesWritten });
    },
  };

  const task = resumeFrom
    ? DownloadTask.fromSavable(resumeFrom.pauseState, taskOptions)
    : new DownloadTask(url, destination, taskOptions);

  const result: Promise<File> = (resumeFrom ? task.resumeAsync() : task.downloadAsync()).then(
    (file) => {
      if (file === null) {
        // Paused — always a result of our own pauseForBackground() call,
        // since DownloadTask only enters `paused` through an explicit
        // pause request. The caller already has what it needs from that
        // call's own return value; the transfer hasn't finished or
        // failed, just suspended, so this deliberately never settles.
        return new Promise<File>(() => {
          // intentionally never resolves or rejects
        });
      }
      dispatch({ type: 'transferComplete' });
      return file;
    },
    (cause: unknown) => {
      if (cancelledByUs) {
        throw new CancelledError('download', { cause });
      }
      dispatch({ type: 'interrupted', cause });
      // `dispatch` just set `state.error` to a DownloadInterruptedError —
      // reject with that typed error rather than the raw native one, so
      // callers get the same typed-error contract as the rest of this
      // library instead of an opaque platform-specific rejection reason.
      throw state.error instanceof DownloadInterruptedError
        ? state.error
        : new DownloadInterruptedError(modelId, state.bytesDownloaded, state.totalBytes, { cause });
    }
  );

  const handle: DownloadTransportHandle = {
    cancel() {
      if (state.status !== 'downloading' && state.status !== 'verifying') {
        return;
      }
      cancelledByUs = true;
      dispatch({ type: 'cancel' });
      task.cancel();
    },

    async pauseForBackground() {
      if (state.status !== 'downloading') {
        throw new Error(
          `Cannot pause a download in status "${state.status}" — pauseForBackground() only applies while downloading.`
        );
      }
      const bytesDownloaded = state.bytesDownloaded;
      await task.pauseAsync();
      const pauseState = task.savable();
      dispatch({ type: 'interrupted' });
      return { pauseState, bytesDownloaded };
    },
  };

  return { handle, result };
}
