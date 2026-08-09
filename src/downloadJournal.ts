/**
 * The download journal: what makes "survives force-quit mid-download and
 * resumes on next launch" true rather than aspirational.
 *
 * `download.ts` proves the *shape* of a resume is correct if someone hands
 * back a byte offset. Until this module existed, nobody did — the offset
 * lived only in memory, which is exactly what a force-quit destroys, so
 * every resume silently restarted from zero.
 *
 * The valuable part here is `reconcileJournalEntry()`. Persisting a number
 * is easy; deciding whether that number can still be trusted on the next
 * launch is where the bugs are. The file may have been swept by the OS,
 * truncated by a torn write, or left behind by a manifest that has since
 * been republished with different bytes under the same model id. All of
 * that is pure decision logic and fully tested here; only reading and
 * writing the file needs a device.
 */

import type { ModelManifest } from './manifest.ts';

export interface DownloadJournalEntry {
  readonly modelId: string;
  /**
   * The manifest's `sha256` at the time this entry was written. If the
   * manifest is later republished with different bytes under the same id,
   * this is what catches it — resuming onto bytes from the old file would
   * produce a file that can never verify.
   */
  readonly sha256: string;
  /** The manifest's `fileSizeBytes` when written, for the same reason. */
  readonly fileSizeBytes: number;
  readonly tempPath: string;
  readonly destinationPath: string;
  readonly bytesDownloaded: number;
  /** Epoch milliseconds, for expiry. */
  readonly updatedAt: number;
  /**
   * The transport's own opaque resume token, if it has one (see
   * `downloadTransport.ts`'s `PersistedTransferState`).
   *
   * **`downloadModel()` never populates this** — it doesn't hold the
   * transport's internals. It's written by the app-background pause path,
   * which is the only place that token exists. An entry without it is
   * still perfectly resumable via a byte offset; the token just lets a
   * transport resume more efficiently when it has one.
   */
  readonly transferState?: unknown;
}

/** The write half, which is all `downloadModel()` needs. */
export interface DownloadJournalWriter {
  write(entry: DownloadJournalEntry): Promise<void>;
  clear(modelId: string): Promise<void>;
}

export interface DownloadJournalStore extends DownloadJournalWriter {
  read(modelId: string): Promise<DownloadJournalEntry | undefined>;
  /** Every entry, for sweeping temp files belonging to downloads nobody wants any more. */
  list(): Promise<readonly DownloadJournalEntry[]>;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Raised when persisted journal data doesn't match {@link DownloadJournalEntry}.
 *
 * Like `ManifestValidationError`, this is deliberately not a
 * `LocalLlmErrorKind`: a malformed journal is corrupt local state, and the
 * only sane recovery is to discard the entry and restart the download —
 * not something a consumer should have to handle in the same exhaustive
 * `switch` as a device or network condition.
 */
export class JournalValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid download journal entry:\n  - ${issues.join('\n  - ')}`);
    this.name = 'JournalValidationError';
    this.issues = issues;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Validates raw persisted data. Journal files are read back from disk after
 * an arbitrary gap — a crash mid-write, a schema change across an app
 * update, or plain corruption — so nothing read from one is trusted.
 *
 * @throws {JournalValidationError} if `raw` doesn't match the entry shape.
 */
export function validateJournalEntry(raw: unknown): DownloadJournalEntry {
  if (!isRecord(raw)) {
    throw new JournalValidationError(['entry must be an object']);
  }

  const issues: string[] = [];
  if (!isNonEmptyString(raw['modelId'])) issues.push('modelId must be a non-empty string');
  if (!isNonEmptyString(raw['sha256'])) issues.push('sha256 must be a non-empty string');
  if (!isNonNegativeInteger(raw['fileSizeBytes'])) issues.push('fileSizeBytes must be a non-negative integer');
  if (!isNonEmptyString(raw['tempPath'])) issues.push('tempPath must be a non-empty string');
  if (!isNonEmptyString(raw['destinationPath'])) issues.push('destinationPath must be a non-empty string');
  if (!isNonNegativeInteger(raw['bytesDownloaded'])) issues.push('bytesDownloaded must be a non-negative integer');
  if (!isNonNegativeInteger(raw['updatedAt'])) issues.push('updatedAt must be a non-negative integer');

  if (issues.length > 0) {
    throw new JournalValidationError(issues);
  }

  const entry: DownloadJournalEntry = {
    modelId: raw['modelId'] as string,
    sha256: (raw['sha256'] as string).toLowerCase(),
    fileSizeBytes: raw['fileSizeBytes'] as number,
    tempPath: raw['tempPath'] as string,
    destinationPath: raw['destinationPath'] as string,
    bytesDownloaded: raw['bytesDownloaded'] as number,
    updatedAt: raw['updatedAt'] as number,
  };
  return raw['transferState'] === undefined ? entry : { ...entry, transferState: raw['transferState'] };
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

export type JournalRestartReason =
  /** The entry belongs to a different model than the one being downloaded. */
  | 'model-mismatch'
  /** The manifest's bytes changed since the entry was written; the partial file is for the old version. */
  | 'manifest-changed'
  /** The entry is older than the configured maximum age. */
  | 'entry-expired'
  /** The temp file is gone — OS cleanup, user action, or it was never written. */
  | 'temp-file-missing'
  /** Nothing usable was on disk, so there is nothing to resume from. */
  | 'no-progress';

export type JournalReconciliation =
  | {
      readonly action: 'resume';
      readonly resumeFromBytes: number;
      readonly transferState?: unknown;
    }
  | {
      readonly action: 'restart';
      readonly reason: JournalRestartReason;
    };

export interface ReconcileJournalInput {
  readonly entry: DownloadJournalEntry;
  readonly manifest: ModelManifest;
  /**
   * The temp file's actual size on disk, or `undefined` if it isn't there.
   * The filesystem is the authority here, not the journal — see below.
   */
  readonly tempFileBytes: number | undefined;
  /** Epoch milliseconds. Injected rather than read from a clock, so this stays pure. */
  readonly now: number;
  /**
   * Discard entries older than this. A months-old partial download is
   * usually garbage occupying space, not a resume opportunity.
   * Omit for no expiry.
   */
  readonly maxAgeMs?: number;
}

/**
 * Decides what to do with a persisted entry when a download for the same
 * model is requested again.
 *
 * A `restart` result means the partial file is unusable: **the caller must
 * delete the temp file and clear the entry**, then download from zero.
 * A `resume` result gives the byte offset to pass to `downloadModel()` as
 * `resumeFromBytes`.
 *
 * The offset is the minimum of what the journal claims, what's actually on
 * disk, and the manifest's total size. Trusting the smallest of the three
 * is deliberate: the journal is written periodically rather than on every
 * byte, so after a crash the file can hold *more* than the journal recorded
 * — and those extra bytes are the ones most likely to be a torn partial
 * write. Re-fetching a few unnecessary kilobytes is a much better trade
 * than resuming onto a corrupt tail and only finding out after hashing a
 * gigabyte.
 */
export function reconcileJournalEntry(input: ReconcileJournalInput): JournalReconciliation {
  const { entry, manifest, tempFileBytes, now, maxAgeMs } = input;

  if (entry.modelId !== manifest.id) {
    return { action: 'restart', reason: 'model-mismatch' };
  }

  if (entry.sha256.toLowerCase() !== manifest.sha256.toLowerCase() || entry.fileSizeBytes !== manifest.fileSizeBytes) {
    return { action: 'restart', reason: 'manifest-changed' };
  }

  if (maxAgeMs !== undefined && now - entry.updatedAt > maxAgeMs) {
    return { action: 'restart', reason: 'entry-expired' };
  }

  if (tempFileBytes === undefined) {
    return { action: 'restart', reason: 'temp-file-missing' };
  }

  const resumeFromBytes = Math.min(entry.bytesDownloaded, tempFileBytes, manifest.fileSizeBytes);
  if (resumeFromBytes <= 0) {
    return { action: 'restart', reason: 'no-progress' };
  }

  return entry.transferState === undefined
    ? { action: 'resume', resumeFromBytes }
    : { action: 'resume', resumeFromBytes, transferState: entry.transferState };
}

// ---------------------------------------------------------------------------
// Write throttling
// ---------------------------------------------------------------------------

export interface ProgressPersistPolicy {
  /** Persist after this many new bytes. @default 8 MiB */
  readonly everyBytes?: number;
  /** Persist after this long, regardless of byte progress. @default 5000 */
  readonly everyMs?: number;
}

export interface ProgressMark {
  readonly bytes: number;
  /** Epoch milliseconds. */
  readonly at: number;
}

const DEFAULT_EVERY_BYTES = 8 * 1024 * 1024;
const DEFAULT_EVERY_MS = 5_000;

/**
 * Decides whether progress is worth writing to disk yet.
 *
 * Writing on every progress event would mean thousands of filesystem writes
 * across a multi-gigabyte download, for a number that only matters if the
 * process dies. Both thresholds exist because either alone has a bad case:
 * bytes-only never persists on a stalled-but-alive connection, and
 * time-only writes constantly on a fast one.
 *
 * The cost of a coarse threshold is bounded and known — at most that much
 * re-downloading after a crash, which {@link reconcileJournalEntry} handles
 * by resuming from the smaller of the journal and the file.
 */
export function shouldPersistProgress(
  last: ProgressMark | undefined,
  current: ProgressMark,
  policy: ProgressPersistPolicy = {}
): boolean {
  if (last === undefined) {
    return true;
  }
  const everyBytes = policy.everyBytes ?? DEFAULT_EVERY_BYTES;
  const everyMs = policy.everyMs ?? DEFAULT_EVERY_MS;
  return current.bytes - last.bytes >= everyBytes || current.at - last.at >= everyMs;
}
