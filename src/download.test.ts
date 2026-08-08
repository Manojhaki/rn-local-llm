import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  initialDownloadState,
  transition,
  InvalidDownloadTransitionError,
  type DownloadState,
} from './download.ts';
import { ChecksumMismatchError, DownloadInterruptedError } from './errors.ts';

function assertInvalidTransition(fn: () => unknown): void {
  assert.throws(fn, InvalidDownloadTransitionError);
}

describe('initialDownloadState', () => {
  test('starts idle with zeroed progress', () => {
    const state = initialDownloadState('qwen3-1.7b-q4');
    assert.deepEqual(state, {
      modelId: 'qwen3-1.7b-q4',
      status: 'idle',
      bytesDownloaded: 0,
      totalBytes: 0,
    });
  });
});

describe('start', () => {
  test('moves idle -> downloading with the given totalBytes', () => {
    const state = transition(initialDownloadState('m'), { type: 'start', totalBytes: 1000 });
    assert.equal(state.status, 'downloading');
    assert.equal(state.totalBytes, 1000);
    assert.equal(state.bytesDownloaded, 0);
  });

  test('resumeFromBytes seeds bytesDownloaded, modeling a resume after force-quit', () => {
    const state = transition(initialDownloadState('m'), { type: 'start', totalBytes: 1000, resumeFromBytes: 400 });
    assert.equal(state.status, 'downloading');
    assert.equal(state.bytesDownloaded, 400);
  });

  test('throws if resumeFromBytes exceeds totalBytes', () => {
    assertInvalidTransition(() =>
      transition(initialDownloadState('m'), { type: 'start', totalBytes: 1000, resumeFromBytes: 1001 })
    );
  });

  test('throws if resumeFromBytes is negative', () => {
    assertInvalidTransition(() =>
      transition(initialDownloadState('m'), { type: 'start', totalBytes: 1000, resumeFromBytes: -1 })
    );
  });

  test('throws if not idle', () => {
    const downloading = transition(initialDownloadState('m'), { type: 'start', totalBytes: 1000 });
    assertInvalidTransition(() => transition(downloading, { type: 'start', totalBytes: 1000 }));
  });
});

describe('progress', () => {
  const downloading = transition(initialDownloadState('m'), { type: 'start', totalBytes: 1000 });

  test('updates bytesDownloaded', () => {
    const state = transition(downloading, { type: 'progress', bytesDownloaded: 400 });
    assert.equal(state.bytesDownloaded, 400);
    assert.equal(state.status, 'downloading');
  });

  test('throws if not downloading', () => {
    assertInvalidTransition(() => transition(initialDownloadState('m'), { type: 'progress', bytesDownloaded: 10 }));
  });

  test('throws if progress moves backwards', () => {
    const advanced = transition(downloading, { type: 'progress', bytesDownloaded: 400 });
    assertInvalidTransition(() => transition(advanced, { type: 'progress', bytesDownloaded: 399 }));
  });

  test('throws if progress exceeds totalBytes', () => {
    assertInvalidTransition(() => transition(downloading, { type: 'progress', bytesDownloaded: 1001 }));
  });

  test('allows progress to hold steady (a duplicate progress event)', () => {
    const advanced = transition(downloading, { type: 'progress', bytesDownloaded: 400 });
    const state = transition(advanced, { type: 'progress', bytesDownloaded: 400 });
    assert.equal(state.bytesDownloaded, 400);
  });
});

describe('transferComplete', () => {
  test('moves downloading -> verifying once bytesDownloaded reaches totalBytes', () => {
    const full = transition(
      transition(initialDownloadState('m'), { type: 'start', totalBytes: 1000 }),
      { type: 'progress', bytesDownloaded: 1000 }
    );
    const state = transition(full, { type: 'transferComplete' });
    assert.equal(state.status, 'verifying');
  });

  test('throws if bytesDownloaded has not reached totalBytes', () => {
    const partial = transition(
      transition(initialDownloadState('m'), { type: 'start', totalBytes: 1000 }),
      { type: 'progress', bytesDownloaded: 400 }
    );
    assertInvalidTransition(() => transition(partial, { type: 'transferComplete' }));
  });

  test('throws if not downloading', () => {
    assertInvalidTransition(() => transition(initialDownloadState('m'), { type: 'transferComplete' }));
  });
});

function verifyingState(totalBytes = 1000): DownloadState {
  return transition(
    transition(
      transition(initialDownloadState('m'), { type: 'start', totalBytes }),
      { type: 'progress', bytesDownloaded: totalBytes }
    ),
    { type: 'transferComplete' }
  );
}

describe('checksumVerified', () => {
  test('moves verifying -> complete', () => {
    const state = transition(verifyingState(), { type: 'checksumVerified' });
    assert.equal(state.status, 'complete');
  });

  test('throws if not verifying', () => {
    assertInvalidTransition(() => transition(initialDownloadState('m'), { type: 'checksumVerified' }));
  });
});

describe('checksumFailed', () => {
  test('moves verifying -> failed carrying a ChecksumMismatchError', () => {
    const state = transition(verifyingState(), {
      type: 'checksumFailed',
      expectedSha256: 'a'.repeat(64),
      actualSha256: 'b'.repeat(64),
    });
    assert.equal(state.status, 'failed');
    assert.ok(state.error instanceof ChecksumMismatchError);
    assert.equal(state.error.modelId, 'm');
  });

  test('throws if not verifying', () => {
    assertInvalidTransition(() =>
      transition(initialDownloadState('m'), {
        type: 'checksumFailed',
        expectedSha256: 'a'.repeat(64),
        actualSha256: 'b'.repeat(64),
      })
    );
  });
});

describe('interrupted', () => {
  test('moves downloading -> failed carrying a DownloadInterruptedError with progress so far', () => {
    const partial = transition(
      transition(initialDownloadState('m'), { type: 'start', totalBytes: 1000 }),
      { type: 'progress', bytesDownloaded: 400 }
    );
    const state = transition(partial, { type: 'interrupted' });
    assert.equal(state.status, 'failed');
    assert.ok(state.error instanceof DownloadInterruptedError);
    assert.equal(state.error.bytesDownloaded, 400);
    assert.equal(state.error.totalBytes, 1000);
    assert.equal(state.bytesDownloaded, 400);
  });

  test('carries an underlying cause (e.g. airplane mode / lost connectivity)', () => {
    const partial = transition(initialDownloadState('m'), { type: 'start', totalBytes: 1000 });
    const networkError = new Error('ENETDOWN');
    const state = transition(partial, { type: 'interrupted', cause: networkError });
    assert.ok(state.error instanceof DownloadInterruptedError);
    assert.equal(state.error.cause, networkError);
  });

  test('moves verifying -> failed too (e.g. a disk read error while hashing)', () => {
    const state = transition(verifyingState(), { type: 'interrupted' });
    assert.equal(state.status, 'failed');
    assert.ok(state.error instanceof DownloadInterruptedError);
  });

  test('throws if nothing is in flight', () => {
    assertInvalidTransition(() => transition(initialDownloadState('m'), { type: 'interrupted' }));
  });
});

describe('retry', () => {
  test('after a transport interruption, resumes from bytesDownloaded', () => {
    const partial = transition(
      transition(initialDownloadState('m'), { type: 'start', totalBytes: 1000 }),
      { type: 'progress', bytesDownloaded: 400 }
    );
    const failed = transition(partial, { type: 'interrupted' });
    const retried = transition(failed, { type: 'retry' });
    assert.equal(retried.status, 'downloading');
    assert.equal(retried.bytesDownloaded, 400);
    assert.equal(retried.totalBytes, 1000);
  });

  test('after a checksum mismatch, restarts from zero', () => {
    const failed = transition(verifyingState(1000), {
      type: 'checksumFailed',
      expectedSha256: 'a'.repeat(64),
      actualSha256: 'b'.repeat(64),
    });
    const retried = transition(failed, { type: 'retry' });
    assert.equal(retried.status, 'downloading');
    assert.equal(retried.bytesDownloaded, 0);
    assert.equal(retried.totalBytes, 1000);
  });

  test('throws if not failed', () => {
    assertInvalidTransition(() => transition(initialDownloadState('m'), { type: 'retry' }));
  });
});

describe('cancel', () => {
  test('moves downloading -> cancelled', () => {
    const downloading = transition(initialDownloadState('m'), { type: 'start', totalBytes: 1000 });
    const state = transition(downloading, { type: 'cancel' });
    assert.equal(state.status, 'cancelled');
  });

  test('moves verifying -> cancelled', () => {
    const state = transition(verifyingState(), { type: 'cancel' });
    assert.equal(state.status, 'cancelled');
  });

  test('throws from idle', () => {
    assertInvalidTransition(() => transition(initialDownloadState('m'), { type: 'cancel' }));
  });

  test('throws from complete', () => {
    const complete = transition(verifyingState(), { type: 'checksumVerified' });
    assertInvalidTransition(() => transition(complete, { type: 'cancel' }));
  });
});

describe('terminal states reject further events', () => {
  test('complete rejects progress, start, and cancel', () => {
    const complete = transition(verifyingState(), { type: 'checksumVerified' });
    assertInvalidTransition(() => transition(complete, { type: 'progress', bytesDownloaded: 1 }));
    assertInvalidTransition(() => transition(complete, { type: 'start', totalBytes: 1000 }));
    assertInvalidTransition(() => transition(complete, { type: 'cancel' }));
  });

  test('cancelled rejects retry and progress', () => {
    const downloading = transition(initialDownloadState('m'), { type: 'start', totalBytes: 1000 });
    const cancelled = transition(downloading, { type: 'cancel' });
    assertInvalidTransition(() => transition(cancelled, { type: 'retry' }));
    assertInvalidTransition(() => transition(cancelled, { type: 'progress', bytesDownloaded: 1 }));
  });
});

describe('end-to-end paths', () => {
  test('happy path: start -> progress -> transferComplete -> checksumVerified -> complete', () => {
    let state = initialDownloadState('qwen3-1.7b-q4');
    state = transition(state, { type: 'start', totalBytes: 1000 });
    state = transition(state, { type: 'progress', bytesDownloaded: 400 });
    state = transition(state, { type: 'progress', bytesDownloaded: 1000 });
    state = transition(state, { type: 'transferComplete' });
    state = transition(state, { type: 'checksumVerified' });
    assert.equal(state.status, 'complete');
    assert.equal(state.bytesDownloaded, 1000);
  });

  test('interrupted then resumed, then a checksum failure forces a full restart', () => {
    let state = initialDownloadState('qwen3-1.7b-q4');
    state = transition(state, { type: 'start', totalBytes: 1000 });
    state = transition(state, { type: 'progress', bytesDownloaded: 400 });
    state = transition(state, { type: 'interrupted', cause: new Error('ENETDOWN') });
    assert.equal(state.status, 'failed');

    state = transition(state, { type: 'retry' });
    assert.equal(state.bytesDownloaded, 400); // resumed, not restarted

    state = transition(state, { type: 'progress', bytesDownloaded: 1000 });
    state = transition(state, { type: 'transferComplete' });
    state = transition(state, {
      type: 'checksumFailed',
      expectedSha256: 'a'.repeat(64),
      actualSha256: 'b'.repeat(64),
    });
    assert.equal(state.status, 'failed');

    state = transition(state, { type: 'retry' });
    assert.equal(state.bytesDownloaded, 0); // restarted, not resumed

    state = transition(state, { type: 'progress', bytesDownloaded: 1000 });
    state = transition(state, { type: 'transferComplete' });
    state = transition(state, { type: 'checksumVerified' });
    assert.equal(state.status, 'complete');
  });

  test('force-quit mid-download: a fresh state machine can resume from persisted progress', () => {
    // Simulates: process died mid-download, host code persisted bytesDownloaded=400
    // out-of-band, and on relaunch builds a fresh state machine that starts
    // already knowing where to resume from.
    const state = transition(initialDownloadState('qwen3-1.7b-q4'), {
      type: 'start',
      totalBytes: 1000,
      resumeFromBytes: 400,
    });
    assert.equal(state.status, 'downloading');
    assert.equal(state.bytesDownloaded, 400);
  });
});
