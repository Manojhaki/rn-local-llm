import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest, ManifestValidationError, type ModelManifest } from './manifest.ts';

const VALID_RAW = {
  id: 'qwen3-1.7b-q4',
  backend: 'llama.cpp',
  quantization: 'Q4_K_M',
  fileSizeBytes: 1_200_000_000,
  sha256: 'a'.repeat(64),
  minRamBytes: 3_000_000_000,
  contextLength: 4096,
  source: { kind: 'url', url: 'https://example.com/qwen3-1.7b-q4.gguf' },
};

describe('validateManifest', () => {
  test('accepts a fully valid manifest', () => {
    const manifest: ModelManifest = validateManifest(VALID_RAW);
    assert.equal(manifest.id, 'qwen3-1.7b-q4');
    assert.equal(manifest.backend, 'llama.cpp');
    assert.equal(manifest.fileSizeBytes, 1_200_000_000);
    assert.deepEqual(manifest.source, { kind: 'url', url: 'https://example.com/qwen3-1.7b-q4.gguf' });
  });

  test('accepts a bundled source', () => {
    const manifest = validateManifest({
      ...VALID_RAW,
      source: { kind: 'bundled', path: 'assets://models/qwen3.gguf' },
    });
    assert.deepEqual(manifest.source, { kind: 'bundled', path: 'assets://models/qwen3.gguf' });
  });

  test('lowercases sha256', () => {
    const manifest = validateManifest({ ...VALID_RAW, sha256: 'A'.repeat(64) });
    assert.equal(manifest.sha256, 'a'.repeat(64));
  });

  test('rejects a non-object', () => {
    assert.throws(() => validateManifest('not an object'), ManifestValidationError);
    assert.throws(() => validateManifest(null), ManifestValidationError);
    assert.throws(() => validateManifest([1, 2, 3]), ManifestValidationError);
  });

  test('rejects an empty id', () => {
    assert.throws(
      () => validateManifest({ ...VALID_RAW, id: '' }),
      (err: unknown) => err instanceof ManifestValidationError && err.issues.some((i) => i.includes('id'))
    );
  });

  test('rejects an unknown backend', () => {
    assert.throws(
      () => validateManifest({ ...VALID_RAW, backend: 'onnx' }),
      (err: unknown) => err instanceof ManifestValidationError && err.issues.some((i) => i.includes('backend'))
    );
  });

  test('rejects a non-integer fileSizeBytes', () => {
    assert.throws(
      () => validateManifest({ ...VALID_RAW, fileSizeBytes: 1.5 }),
      (err: unknown) =>
        err instanceof ManifestValidationError && err.issues.some((i) => i.includes('fileSizeBytes'))
    );
  });

  test('rejects a negative minRamBytes', () => {
    assert.throws(
      () => validateManifest({ ...VALID_RAW, minRamBytes: -1 }),
      (err: unknown) => err instanceof ManifestValidationError && err.issues.some((i) => i.includes('minRamBytes'))
    );
  });

  test('rejects a malformed sha256', () => {
    assert.throws(
      () => validateManifest({ ...VALID_RAW, sha256: 'not-a-hash' }),
      (err: unknown) => err instanceof ManifestValidationError && err.issues.some((i) => i.includes('sha256'))
    );
  });

  test('rejects a source with an unknown kind', () => {
    assert.throws(
      () => validateManifest({ ...VALID_RAW, source: { kind: 'ftp', url: 'ftp://x' } }),
      (err: unknown) => err instanceof ManifestValidationError && err.issues.some((i) => i.includes('source.kind'))
    );
  });

  test('rejects a bundled source missing path', () => {
    assert.throws(
      () => validateManifest({ ...VALID_RAW, source: { kind: 'bundled' } }),
      (err: unknown) => err instanceof ManifestValidationError && err.issues.some((i) => i.includes('source.path'))
    );
  });

  test('collects every issue at once rather than stopping at the first', () => {
    try {
      validateManifest({ id: '', backend: 'onnx' });
      assert.fail('expected validateManifest to throw');
    } catch (err) {
      assert.ok(err instanceof ManifestValidationError);
      // id, backend, quantization, fileSizeBytes, sha256, minRamBytes, contextLength, source
      assert.equal(err.issues.length, 8);
    }
  });

  test('error message includes every issue', () => {
    try {
      validateManifest({ id: '', backend: 'onnx' });
      assert.fail('expected validateManifest to throw');
    } catch (err) {
      assert.ok(err instanceof ManifestValidationError);
      assert.ok(err.message.includes('id must be'));
      assert.ok(err.message.includes('backend must be'));
    }
  });
});
