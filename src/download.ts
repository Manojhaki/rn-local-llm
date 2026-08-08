/**
 * The download state machine's orchestration logic.
 *
 * This is the pure reducer only: given a current state and an event, decide
 * the next state. It owns none of the I/O the real doc-described downloader
 * needs — no HTTP, no range requests, no background transfer, no disk
 * writes, no persistence across a force-quit. Those are native/transport
 * concerns (see CLAUDE.md's open questions on the download transport
 * dependency) that will drive this reducer by dispatching events; this file
 * is what they'll drive once they exist.
 *
 * What *is* real here, and worth getting right before any transport exists:
 * the retry semantics. A transport interruption resumes from where it left
 * off via a range request; a checksum mismatch must restart from zero,
 * because the bytes already on disk are the ones that failed verification.
 */

import { ChecksumMismatchError, DownloadInterruptedError, type LocalLlmError } from './errors.ts';

export type DownloadStatus = 'idle' | 'downloading' | 'verifying' | 'complete' | 'failed' | 'cancelled';

export interface DownloadState {
  readonly modelId: string;
  readonly status: DownloadStatus;
  readonly bytesDownloaded: number;
  readonly totalBytes: number;
  readonly error?: LocalLlmError;
}

export type DownloadEvent =
  /** Begins a download, or resumes one whose progress was persisted before a force-quit. */
  | { readonly type: 'start'; readonly totalBytes: number; readonly resumeFromBytes?: number }
  | { readonly type: 'progress'; readonly bytesDownloaded: number }
  | { readonly type: 'transferComplete' }
  | { readonly type: 'checksumVerified' }
  | { readonly type: 'checksumFailed'; readonly expectedSha256: string; readonly actualSha256: string }
  | { readonly type: 'interrupted'; readonly cause?: unknown }
  | { readonly type: 'retry' }
  | { readonly type: 'cancel' };

/**
 * Raised when an event doesn't apply to the state machine's current status —
 * e.g. `progress` before `start`, or any event after `complete`. This is a
 * caller bug (the host code driving the state machine is out of sync with
 * it), not a runtime/device condition, so it isn't a member of
 * `LocalLlmErrorKind` — see the same reasoning on `ManifestValidationError`
 * in manifest.ts.
 */
export class InvalidDownloadTransitionError extends Error {
  readonly status: DownloadStatus;
  readonly eventType: DownloadEvent['type'];

  constructor(status: DownloadStatus, eventType: DownloadEvent['type'], detail?: string) {
    super(
      `Cannot apply event "${eventType}" to a download in status "${status}"` +
        (detail ? `: ${detail}` : '.')
    );
    this.name = 'InvalidDownloadTransitionError';
    this.status = status;
    this.eventType = eventType;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function initialDownloadState(modelId: string): DownloadState {
  return { modelId, status: 'idle', bytesDownloaded: 0, totalBytes: 0 };
}

/**
 * @throws {InvalidDownloadTransitionError} if `event` doesn't apply to `state.status`.
 */
export function transition(state: DownloadState, event: DownloadEvent): DownloadState {
  switch (event.type) {
    case 'start': {
      if (state.status !== 'idle') {
        throw new InvalidDownloadTransitionError(state.status, event.type, 'a download can only start from idle');
      }
      const resumeFromBytes = event.resumeFromBytes ?? 0;
      if (resumeFromBytes < 0 || resumeFromBytes > event.totalBytes) {
        throw new InvalidDownloadTransitionError(
          state.status,
          event.type,
          `resumeFromBytes (${resumeFromBytes}) must be between 0 and totalBytes (${event.totalBytes})`
        );
      }
      return { modelId: state.modelId, status: 'downloading', bytesDownloaded: resumeFromBytes, totalBytes: event.totalBytes };
    }

    case 'progress': {
      if (state.status !== 'downloading') {
        throw new InvalidDownloadTransitionError(state.status, event.type, 'progress only applies while downloading');
      }
      if (event.bytesDownloaded < state.bytesDownloaded) {
        throw new InvalidDownloadTransitionError(
          state.status,
          event.type,
          `progress cannot move backwards (was ${state.bytesDownloaded}, got ${event.bytesDownloaded})`
        );
      }
      if (event.bytesDownloaded > state.totalBytes) {
        throw new InvalidDownloadTransitionError(
          state.status,
          event.type,
          `progress (${event.bytesDownloaded}) cannot exceed totalBytes (${state.totalBytes})`
        );
      }
      return { ...state, bytesDownloaded: event.bytesDownloaded };
    }

    case 'transferComplete': {
      if (state.status !== 'downloading') {
        throw new InvalidDownloadTransitionError(state.status, event.type, 'only a download in progress can finish transferring');
      }
      if (state.bytesDownloaded !== state.totalBytes) {
        throw new InvalidDownloadTransitionError(
          state.status,
          event.type,
          `bytesDownloaded (${state.bytesDownloaded}) must equal totalBytes (${state.totalBytes}) before verifying`
        );
      }
      return { ...state, status: 'verifying' };
    }

    case 'checksumVerified': {
      if (state.status !== 'verifying') {
        throw new InvalidDownloadTransitionError(state.status, event.type, 'checksum can only be verified after the transfer completes');
      }
      return { ...state, status: 'complete' };
    }

    case 'checksumFailed': {
      if (state.status !== 'verifying') {
        throw new InvalidDownloadTransitionError(state.status, event.type, 'checksum can only fail after the transfer completes');
      }
      return {
        modelId: state.modelId,
        status: 'failed',
        bytesDownloaded: state.bytesDownloaded,
        totalBytes: state.totalBytes,
        error: new ChecksumMismatchError(state.modelId, event.expectedSha256, event.actualSha256),
      };
    }

    case 'interrupted': {
      if (state.status !== 'downloading' && state.status !== 'verifying') {
        throw new InvalidDownloadTransitionError(state.status, event.type, 'nothing is in flight to interrupt');
      }
      return {
        modelId: state.modelId,
        status: 'failed',
        bytesDownloaded: state.bytesDownloaded,
        totalBytes: state.totalBytes,
        error: new DownloadInterruptedError(state.modelId, state.bytesDownloaded, state.totalBytes, {
          cause: event.cause,
        }),
      };
    }

    case 'retry': {
      if (state.status !== 'failed') {
        throw new InvalidDownloadTransitionError(state.status, event.type, 'only a failed download can be retried');
      }
      // A checksum mismatch means the bytes on disk are the ones that failed
      // verification — resuming from them would re-verify bad data. A
      // transport interruption leaves good bytes on disk, so it resumes.
      const resumeFromBytes = state.error?.kind === 'ChecksumMismatch' ? 0 : state.bytesDownloaded;
      return { modelId: state.modelId, status: 'downloading', bytesDownloaded: resumeFromBytes, totalBytes: state.totalBytes };
    }

    case 'cancel': {
      if (state.status !== 'downloading' && state.status !== 'verifying') {
        throw new InvalidDownloadTransitionError(state.status, event.type, 'only an active download can be cancelled');
      }
      return { modelId: state.modelId, status: 'cancelled', bytesDownloaded: state.bytesDownloaded, totalBytes: state.totalBytes };
    }
  }
}
