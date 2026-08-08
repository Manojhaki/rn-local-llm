import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { assertChecksumMatches } from './checksum.ts';
import { ChecksumMismatchError } from './errors.ts';

describe('assertChecksumMatches', () => {
  test('does not throw when hashes match', () => {
    assert.doesNotThrow(() => assertChecksumMatches('qwen3-1.7b-q4', 'a'.repeat(64), 'a'.repeat(64)));
  });

  test('is case-insensitive', () => {
    assert.doesNotThrow(() => assertChecksumMatches('qwen3-1.7b-q4', 'A'.repeat(64), 'a'.repeat(64)));
  });

  test('throws ChecksumMismatchError when hashes differ, flipping a single byte', () => {
    const expected = 'a'.repeat(64);
    const actual = 'b' + 'a'.repeat(63);
    assert.throws(
      () => assertChecksumMatches('qwen3-1.7b-q4', expected, actual),
      (err: unknown) =>
        err instanceof ChecksumMismatchError &&
        err.modelId === 'qwen3-1.7b-q4' &&
        err.expectedSha256 === expected &&
        err.actualSha256 === actual
    );
  });
});
