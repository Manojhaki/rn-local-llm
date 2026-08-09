import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  reconcileJournalEntry,
  shouldPersistProgress,
  validateJournalEntry,
  JournalValidationError,
  type DownloadJournalEntry,
} from './downloadJournal.ts';
import type { ModelManifest } from './manifest.ts';

const SHA = 'a'.repeat(64);
const OTHER_SHA = 'b'.repeat(64);
const FILE_SIZE = 1_200_000_000;
const NOW = 1_700_000_000_000;

function manifest(overrides: Partial<ModelManifest> = {}): ModelManifest {
  return {
    id: 'qwen3-1.7b-q4',
    backend: 'llama.cpp',
    quantization: 'Q4_K_M',
    fileSizeBytes: FILE_SIZE,
    sha256: SHA,
    minRamBytes: 3_000_000_000,
    contextLength: 4096,
    source: { kind: 'url', url: 'https://example.com/m.gguf' },
    ...overrides,
  };
}

function entry(overrides: Partial<DownloadJournalEntry> = {}): DownloadJournalEntry {
  return {
    modelId: 'qwen3-1.7b-q4',
    sha256: SHA,
    fileSizeBytes: FILE_SIZE,
    tempPath: '/tmp/m.part',
    destinationPath: '/models/m.gguf',
    bytesDownloaded: 400_000_000,
    updatedAt: NOW - 60_000,
    ...overrides,
  };
}

describe('reconcileJournalEntry — resuming', () => {
  test('resumes from the recorded offset when everything agrees', () => {
    const result = reconcileJournalEntry({
      entry: entry(),
      manifest: manifest(),
      tempFileBytes: 400_000_000,
      now: NOW,
    });
    assert.deepEqual(result, { action: 'resume', resumeFromBytes: 400_000_000 });
  });

  test('carries the transport resume token through when present', () => {
    const token = { resumeData: 'opaque-platform-token' };
    const result = reconcileJournalEntry({
      entry: entry({ transferState: token }),
      manifest: manifest(),
      tempFileBytes: 400_000_000,
      now: NOW,
    });
    assert.equal(result.action, 'resume');
    assert.equal(result.action === 'resume' ? result.transferState : undefined, token);
  });

  test('omits transferState entirely when the entry has none', () => {
    const result = reconcileJournalEntry({
      entry: entry(),
      manifest: manifest(),
      tempFileBytes: 400_000_000,
      now: NOW,
    });
    assert.ok(!('transferState' in result));
  });

  test('tolerates sha256 case differing between entry and manifest', () => {
    const result = reconcileJournalEntry({
      entry: entry({ sha256: SHA.toUpperCase() }),
      manifest: manifest(),
      tempFileBytes: 400_000_000,
      now: NOW,
    });
    assert.equal(result.action, 'resume');
  });
});

describe('reconcileJournalEntry — trusting the filesystem over the journal', () => {
  test('resumes from the file size when the file is shorter than the journal claims', () => {
    // A torn write, or bytes lost when the process died.
    const result = reconcileJournalEntry({
      entry: entry({ bytesDownloaded: 400_000_000 }),
      manifest: manifest(),
      tempFileBytes: 380_000_000,
      now: NOW,
    });
    assert.deepEqual(result, { action: 'resume', resumeFromBytes: 380_000_000 });
  });

  test('resumes from the journal when the file is longer than the journal claims', () => {
    // Bytes written after the last throttled journal flush. They are the
    // most likely to be a torn tail, so they are deliberately re-fetched.
    const result = reconcileJournalEntry({
      entry: entry({ bytesDownloaded: 400_000_000 }),
      manifest: manifest(),
      tempFileBytes: 420_000_000,
      now: NOW,
    });
    assert.deepEqual(result, { action: 'resume', resumeFromBytes: 400_000_000 });
  });

  test('never resumes past the manifest total, even if both disagree upward', () => {
    const result = reconcileJournalEntry({
      entry: entry({ bytesDownloaded: FILE_SIZE + 5000 }),
      manifest: manifest(),
      tempFileBytes: FILE_SIZE + 9000,
      now: NOW,
    });
    assert.deepEqual(result, { action: 'resume', resumeFromBytes: FILE_SIZE });
  });

  test('a fully downloaded temp file resumes at the total, not a restart', () => {
    const result = reconcileJournalEntry({
      entry: entry({ bytesDownloaded: FILE_SIZE }),
      manifest: manifest(),
      tempFileBytes: FILE_SIZE,
      now: NOW,
    });
    assert.deepEqual(result, { action: 'resume', resumeFromBytes: FILE_SIZE });
  });
});

describe('reconcileJournalEntry — restarting', () => {
  test('restarts when the manifest sha256 changed under the same model id', () => {
    // The single most dangerous case: resuming here would build a file that
    // can never verify, and the mismatch would only surface after hashing.
    const result = reconcileJournalEntry({
      entry: entry({ sha256: OTHER_SHA }),
      manifest: manifest(),
      tempFileBytes: 400_000_000,
      now: NOW,
    });
    assert.deepEqual(result, { action: 'restart', reason: 'manifest-changed' });
  });

  test('restarts when the manifest file size changed', () => {
    const result = reconcileJournalEntry({
      entry: entry({ fileSizeBytes: FILE_SIZE - 1000 }),
      manifest: manifest(),
      tempFileBytes: 400_000_000,
      now: NOW,
    });
    assert.deepEqual(result, { action: 'restart', reason: 'manifest-changed' });
  });

  test('restarts when the entry belongs to a different model', () => {
    const result = reconcileJournalEntry({
      entry: entry({ modelId: 'some-other-model' }),
      manifest: manifest(),
      tempFileBytes: 400_000_000,
      now: NOW,
    });
    assert.deepEqual(result, { action: 'restart', reason: 'model-mismatch' });
  });

  test('restarts when the temp file is gone', () => {
    const result = reconcileJournalEntry({
      entry: entry(),
      manifest: manifest(),
      tempFileBytes: undefined,
      now: NOW,
    });
    assert.deepEqual(result, { action: 'restart', reason: 'temp-file-missing' });
  });

  test('restarts when the temp file exists but is empty', () => {
    const result = reconcileJournalEntry({
      entry: entry(),
      manifest: manifest(),
      tempFileBytes: 0,
      now: NOW,
    });
    assert.deepEqual(result, { action: 'restart', reason: 'no-progress' });
  });

  test('restarts when the journal recorded no progress', () => {
    const result = reconcileJournalEntry({
      entry: entry({ bytesDownloaded: 0 }),
      manifest: manifest(),
      tempFileBytes: 100,
      now: NOW,
    });
    assert.deepEqual(result, { action: 'restart', reason: 'no-progress' });
  });

  describe('expiry', () => {
    test('restarts when the entry is older than maxAgeMs', () => {
      const result = reconcileJournalEntry({
        entry: entry({ updatedAt: NOW - 100_000 }),
        manifest: manifest(),
        tempFileBytes: 400_000_000,
        now: NOW,
        maxAgeMs: 50_000,
      });
      assert.deepEqual(result, { action: 'restart', reason: 'entry-expired' });
    });

    test('resumes when the entry is within maxAgeMs', () => {
      const result = reconcileJournalEntry({
        entry: entry({ updatedAt: NOW - 10_000 }),
        manifest: manifest(),
        tempFileBytes: 400_000_000,
        now: NOW,
        maxAgeMs: 50_000,
      });
      assert.equal(result.action, 'resume');
    });

    test('never expires when maxAgeMs is omitted', () => {
      const result = reconcileJournalEntry({
        entry: entry({ updatedAt: 0 }),
        manifest: manifest(),
        tempFileBytes: 400_000_000,
        now: NOW,
      });
      assert.equal(result.action, 'resume');
    });
  });

  test('a changed manifest wins over an intact temp file', () => {
    // Ordering matters: the file being present is not a reason to trust it
    // when the manifest says those bytes are for a different build.
    const result = reconcileJournalEntry({
      entry: entry({ sha256: OTHER_SHA }),
      manifest: manifest(),
      tempFileBytes: FILE_SIZE,
      now: NOW,
    });
    assert.deepEqual(result, { action: 'restart', reason: 'manifest-changed' });
  });
});

describe('shouldPersistProgress', () => {
  test('always persists the first mark', () => {
    assert.equal(shouldPersistProgress(undefined, { bytes: 0, at: NOW }), true);
  });

  test('does not persist a small increment shortly after the last write', () => {
    assert.equal(
      shouldPersistProgress({ bytes: 1000, at: NOW }, { bytes: 2000, at: NOW + 10 }),
      false
    );
  });

  test('persists once the byte threshold is crossed', () => {
    assert.equal(
      shouldPersistProgress({ bytes: 0, at: NOW }, { bytes: 8 * 1024 * 1024, at: NOW + 1 }),
      true
    );
  });

  test('persists on the time threshold even when barely any bytes moved', () => {
    // The stalled-but-alive connection case, which a bytes-only policy misses.
    assert.equal(shouldPersistProgress({ bytes: 0, at: NOW }, { bytes: 1, at: NOW + 5_000 }), true);
  });

  test('honours a custom byte threshold', () => {
    assert.equal(
      shouldPersistProgress({ bytes: 0, at: NOW }, { bytes: 100, at: NOW }, { everyBytes: 100 }),
      true
    );
    assert.equal(
      shouldPersistProgress({ bytes: 0, at: NOW }, { bytes: 99, at: NOW }, { everyBytes: 100 }),
      false
    );
  });

  test('honours a custom time threshold', () => {
    assert.equal(
      shouldPersistProgress({ bytes: 0, at: NOW }, { bytes: 0, at: NOW + 100 }, { everyMs: 100 }),
      true
    );
  });

  test('does not persist on a backwards byte count', () => {
    assert.equal(
      shouldPersistProgress({ bytes: 5000, at: NOW }, { bytes: 10, at: NOW + 1 }),
      false
    );
  });
});

describe('validateJournalEntry', () => {
  const raw = {
    modelId: 'qwen3-1.7b-q4',
    sha256: SHA,
    fileSizeBytes: FILE_SIZE,
    tempPath: '/tmp/m.part',
    destinationPath: '/models/m.gguf',
    bytesDownloaded: 400_000_000,
    updatedAt: NOW,
  };

  test('accepts a well-formed entry', () => {
    assert.deepEqual(validateJournalEntry(raw), raw);
  });

  test('lowercases sha256', () => {
    assert.equal(validateJournalEntry({ ...raw, sha256: SHA.toUpperCase() }).sha256, SHA);
  });

  test('preserves an opaque transferState without inspecting it', () => {
    const token = { nested: { platform: 'ios' } };
    assert.deepEqual(validateJournalEntry({ ...raw, transferState: token }).transferState, token);
  });

  test('rejects non-objects, including corrupt-file leftovers', () => {
    assert.throws(() => validateJournalEntry('{"truncated'), JournalValidationError);
    assert.throws(() => validateJournalEntry(null), JournalValidationError);
    assert.throws(() => validateJournalEntry([raw]), JournalValidationError);
  });

  test('rejects a missing modelId', () => {
    const { modelId: _omitted, ...rest } = raw;
    assert.throws(
      () => validateJournalEntry(rest),
      (err: unknown) => err instanceof JournalValidationError && err.issues.some((i) => i.includes('modelId'))
    );
  });

  test('rejects a negative byte count', () => {
    assert.throws(
      () => validateJournalEntry({ ...raw, bytesDownloaded: -1 }),
      (err: unknown) =>
        err instanceof JournalValidationError && err.issues.some((i) => i.includes('bytesDownloaded'))
    );
  });

  test('rejects a non-integer byte count', () => {
    assert.throws(() => validateJournalEntry({ ...raw, bytesDownloaded: 1.5 }), JournalValidationError);
  });

  test('collects every issue at once', () => {
    try {
      validateJournalEntry({ modelId: '' });
      assert.fail('expected a throw');
    } catch (err) {
      assert.ok(err instanceof JournalValidationError);
      // modelId, sha256, fileSizeBytes, tempPath, destinationPath, bytesDownloaded, updatedAt
      assert.equal(err.issues.length, 7);
    }
  });
});
