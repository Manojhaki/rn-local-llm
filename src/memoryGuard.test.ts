import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { checkMemoryCapability } from './memoryGuard.ts';
import { InsufficientMemoryError } from './errors.ts';
import type { ModelManifest } from './manifest.ts';

const MANIFEST: ModelManifest = {
  id: 'qwen3-1.7b-q4',
  backend: 'llama.cpp',
  quantization: 'Q4_K_M',
  fileSizeBytes: 1_200_000_000,
  sha256: 'a'.repeat(64),
  minRamBytes: 3_000_000_000,
  contextLength: 4096,
  source: { kind: 'url', url: 'https://example.com/qwen3-1.7b-q4.gguf' },
};

describe('checkMemoryCapability', () => {
  test('does not throw when available RAM meets the minimum', () => {
    assert.doesNotThrow(() => checkMemoryCapability(MANIFEST, 3_000_000_000));
  });

  test('does not throw when available RAM exceeds the minimum', () => {
    assert.doesNotThrow(() => checkMemoryCapability(MANIFEST, 8_000_000_000));
  });

  test('throws InsufficientMemoryError when available RAM is below the minimum', () => {
    assert.throws(
      () => checkMemoryCapability(MANIFEST, 1_200_000_000),
      (err: unknown) =>
        err instanceof InsufficientMemoryError &&
        err.modelId === 'qwen3-1.7b-q4' &&
        err.availableBytes === 1_200_000_000 &&
        err.requiredBytes === 3_000_000_000
    );
  });

  test('applies headroom on top of minRamBytes', () => {
    assert.throws(
      () => checkMemoryCapability(MANIFEST, 3_000_000_000, { headroomBytes: 500_000_000 }),
      (err: unknown) => err instanceof InsufficientMemoryError && err.requiredBytes === 3_500_000_000
    );

    assert.doesNotThrow(() => checkMemoryCapability(MANIFEST, 3_500_000_000, { headroomBytes: 500_000_000 }));
  });

  test('exactly enough RAM (no headroom) is sufficient, not a boundary failure', () => {
    assert.doesNotThrow(() => checkMemoryCapability(MANIFEST, MANIFEST.minRamBytes));
  });
});
