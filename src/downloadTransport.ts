/**
 * The real `ModelTransfer` implementation, backed by expo-file-system's
 * `DownloadTask`.
 *
 * **Unverified beyond `tsc --noEmit`.** `DownloadTask` is a real native
 * module; it can't be linked or executed without an actual RN/Expo app
 * (M0), which this environment can't build. No test file, for the same
 * reason as `hashing.ts`: a test that can only pass vacuously or crash on
 * an unlinked native module is worse than no test. Not exported from
 * `index.ts` — that would make the whole public API require these native
 * packages to be resolvable.
 *
 * Deliberately dumb. All the orchestration — retry semantics, checksum
 * verification, the atomic move, cancellation policy — lives in
 * `downloadModel.ts` where it is testable with fakes. This file only turns
 * a `DownloadTask` into bytes-on-disk plus progress callbacks. An earlier
 * draft drove `download.ts`'s reducer from in here; that made two separate
 * owners of one state machine once the orchestrator existed, so it was
 * cut back to this.
 *
 * Known platform gap, inherited from `DownloadTask` itself: `sessionType:
 * 'background'` is a real background `URLSession` on iOS, but is
 * explicitly ignored on Android — no confirmed true background
 * continuation there. See CLAUDE.md.
 */

import { DownloadTask, type DownloadPauseState, type Directory, type File } from 'expo-file-system';
import type { ModelTransfer, TransferHandle, TransferRequest } from './downloadModel.ts';

/**
 * Everything needed to resume a transfer after this object is gone — a JS
 * restart, or a force-quit and relaunch.
 *
 * `pauseState` is expo-file-system's opaque, platform-specific resume
 * token; it carries no byte count of its own. `bytesDownloaded` is tracked
 * separately from the last progress callback, precisely because
 * `download.ts` needs that number for `resumeFromBytes` and `savable()`
 * won't give it. Persisting one half without the other loses the ability
 * to resume correctly.
 */
export interface PersistedTransferState {
  readonly pauseState: DownloadPauseState;
  readonly bytesDownloaded: number;
}

export interface ExpoModelTransferOptions {
  /**
   * Resolves the temp path the orchestrator asked for into the `File` (or
   * `Directory`) `DownloadTask` wants. Injected rather than constructed
   * here so this module holds no opinion about where models live.
   */
  readonly resolveDestination: (tempPath: string) => File | Directory;
  /** Restored state from a previous process, if this is a resume. */
  readonly resumeFrom?: PersistedTransferState;
}

export class ExpoModelTransfer implements ModelTransfer {
  readonly #resolveDestination: (tempPath: string) => File | Directory;
  #resumeFrom: PersistedTransferState | undefined;
  #task: DownloadTask | undefined;
  #lastBytesDownloaded = 0;

  constructor(options: ExpoModelTransferOptions) {
    this.#resolveDestination = options.resolveDestination;
    this.#resumeFrom = options.resumeFrom;
  }

  start(request: TransferRequest): TransferHandle {
    this.#lastBytesDownloaded = request.resumeFromBytes;

    const taskOptions = {
      sessionType: 'background' as const,
      onProgress: (progress: { bytesWritten: number }) => {
        this.#lastBytesDownloaded = progress.bytesWritten;
        request.onProgress(progress.bytesWritten);
      },
    };

    // A resume token only applies to the transfer it came from. The
    // orchestrator restarts from byte zero after a checksum failure, and
    // reusing a stale token there would resume onto bytes it just deleted.
    const resumeFrom = request.resumeFromBytes > 0 ? this.#resumeFrom : undefined;
    this.#resumeFrom = undefined;

    const task = resumeFrom
      ? DownloadTask.fromSavable(resumeFrom.pauseState, taskOptions)
      : new DownloadTask(request.url, this.#resolveDestination(request.tempPath), taskOptions);
    this.#task = task;

    const completed = (resumeFrom ? task.resumeAsync() : task.downloadAsync()).then((file) => {
      if (file === null) {
        // `null` means paused, which only happens through an explicit
        // `pauseForBackground()` call. That caller already holds the
        // resume state it needs, and the transfer is suspended rather than
        // finished or failed — so this deliberately never settles, leaving
        // the orchestrator's own cancellation signal in charge.
        return new Promise<void>(() => undefined);
      }
      return undefined;
    });

    return {
      cancel: () => {
        task.cancel();
      },
      completed,
    };
  }

  /**
   * Pauses the in-flight transfer and returns state that survives a
   * force-quit. Call this from an app-background or termination hook and
   * persist the result; hand it back via
   * {@link ExpoModelTransferOptions.resumeFrom} on the next launch, along
   * with `bytesDownloaded` as the orchestrator's `resumeFromBytes`.
   *
   * @throws {Error} if no transfer has been started.
   */
  async pauseForBackground(): Promise<PersistedTransferState> {
    const task = this.#task;
    if (!task) {
      throw new Error('Cannot pause: no transfer has been started.');
    }
    const bytesDownloaded = this.#lastBytesDownloaded;
    await task.pauseAsync();
    return { pauseState: task.savable(), bytesDownloaded };
  }
}
