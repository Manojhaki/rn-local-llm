import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  LocalLlmErrorBase,
  InsufficientMemoryError,
  ModelNotFoundError,
  ChecksumMismatchError,
  DownloadInterruptedError,
  BackendUnavailableError,
  CancelledError,
  ContextOverflowError,
  type LocalLlmError,
  type LocalLlmErrorKind,
} from './errors.ts';

/**
 * One sample per kind. If a kind is ever added to `LocalLlmErrorKind`
 * without a matching entry here, this object literal fails to typecheck
 * against `Record<LocalLlmErrorKind, LocalLlmError>` — the test-side half
 * of the exhaustiveness guard described in errors.ts.
 */
const SAMPLES: Record<LocalLlmErrorKind, LocalLlmError> = {
  InsufficientMemory: new InsufficientMemoryError('qwen3-1.7b-q4', 2_000_000_000, 1_200_000_000),
  ModelNotFound: new ModelNotFoundError('does-not-exist'),
  ChecksumMismatch: new ChecksumMismatchError('qwen3-1.7b-q4', 'abc123', 'def456'),
  DownloadInterrupted: new DownloadInterruptedError('qwen3-1.7b-q4', 400_000_000, 1_200_000_000),
  BackendUnavailable: new BackendUnavailableError('executorch', 'not compiled into this build'),
  Cancelled: new CancelledError('download'),
  ContextOverflow: new ContextOverflowError('qwen3-1.7b-q4', 5000, 4096),
};

describe('every LocalLlmError kind', () => {
  for (const [kind, error] of Object.entries(SAMPLES) as [LocalLlmErrorKind, LocalLlmError][]) {
    describe(kind, () => {
      test('is an instance of Error', () => {
        assert.ok(error instanceof Error);
      });

      test('is an instance of LocalLlmErrorBase', () => {
        assert.ok(error instanceof LocalLlmErrorBase);
      });

      test('kind matches the discriminant', () => {
        assert.equal(error.kind, kind);
      });

      test('name matches the concrete class name', () => {
        assert.equal(error.name, error.constructor.name);
      });

      test('message is a non-empty string', () => {
        assert.equal(typeof error.message, 'string');
        assert.ok(error.message.length > 0);
      });

      test('has a captured stack trace', () => {
        assert.equal(typeof error.stack, 'string');
      });

      test('toJSON omits cause', () => {
        assert.ok(!('cause' in error.toJSON()));
      });

      test('toJSON includes kind, name, and message', () => {
        const json = error.toJSON();
        assert.equal(json['kind'], kind);
        assert.equal(json['name'], error.name);
        assert.equal(json['message'], error.message);
      });

      test('toJSON round-trips through JSON.stringify without throwing', () => {
        assert.doesNotThrow(() => JSON.stringify(error));
      });
    });
  }
});

describe('cause', () => {
  test('is preserved on the instance even though toJSON omits it', () => {
    const native = new Error('native boom');
    const err = new ModelNotFoundError('missing-model', { cause: native });
    assert.equal(err.cause, native);
    assert.ok(!('cause' in err.toJSON()));
  });

  test('defaults to undefined when not provided', () => {
    const err = new ModelNotFoundError('missing-model');
    assert.equal(err.cause, undefined);
  });
});

describe('instanceof under subclassing (Hermes/JSC downlevel-transpilation guard)', () => {
  test('a caught error narrows correctly through instanceof chains', () => {
    function raise(): never {
      throw new InsufficientMemoryError('qwen3-1.7b-q4', 2_000_000_000, 1_200_000_000);
    }

    try {
      raise();
      assert.fail('expected raise() to throw');
    } catch (err) {
      assert.ok(err instanceof Error);
      assert.ok(err instanceof LocalLlmErrorBase);
      assert.ok(err instanceof InsufficientMemoryError);
      assert.ok(!(err instanceof ModelNotFoundError));
    }
  });
});

describe('typed fields', () => {
  test('InsufficientMemoryError carries the numbers a developer needs', () => {
    const err = new InsufficientMemoryError('qwen3-1.7b-q4', 2_000_000_000, 1_200_000_000);
    assert.equal(err.modelId, 'qwen3-1.7b-q4');
    assert.equal(err.requiredBytes, 2_000_000_000);
    assert.equal(err.availableBytes, 1_200_000_000);
  });

  test('ChecksumMismatchError carries both hashes', () => {
    const err = new ChecksumMismatchError('qwen3-1.7b-q4', 'abc123', 'def456');
    assert.equal(err.expectedSha256, 'abc123');
    assert.equal(err.actualSha256, 'def456');
  });

  test('CancelledError carries which operation was cancelled', () => {
    const err = new CancelledError('generate');
    assert.equal(err.operation, 'generate');
  });
});
