import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ModelRegistry } from './registry.ts';
import { ManifestValidationError, type ModelManifest } from './manifest.ts';
import { ModelNotFoundError } from './errors.ts';

function manifest(overrides: Partial<ModelManifest> = {}): ModelManifest {
  return {
    id: 'qwen3-1.7b-q4',
    backend: 'llama.cpp',
    quantization: 'Q4_K_M',
    fileSizeBytes: 1_200_000_000,
    sha256: 'a'.repeat(64),
    minRamBytes: 3_000_000_000,
    contextLength: 4096,
    source: { kind: 'url', url: 'https://example.com/qwen3-1.7b-q4.gguf' },
    ...overrides,
  };
}

describe('ModelRegistry', () => {
  test('resolves a registered manifest by id', () => {
    const registry = new ModelRegistry();
    const m = manifest();
    registry.register(m);
    assert.equal(registry.resolve('qwen3-1.7b-q4'), m);
  });

  test('resolve throws ModelNotFoundError for an unregistered id', () => {
    const registry = new ModelRegistry();
    assert.throws(
      () => registry.resolve('nonexistent'),
      (err: unknown) => err instanceof ModelNotFoundError && err.modelId === 'nonexistent'
    );
  });

  test('has() reflects registration state', () => {
    const registry = new ModelRegistry();
    assert.equal(registry.has('qwen3-1.7b-q4'), false);
    registry.register(manifest());
    assert.equal(registry.has('qwen3-1.7b-q4'), true);
  });

  test('registering the same id twice replaces the manifest', () => {
    const registry = new ModelRegistry();
    registry.register(manifest({ contextLength: 4096 }));
    registry.register(manifest({ contextLength: 8192 }));
    assert.equal(registry.resolve('qwen3-1.7b-q4').contextLength, 8192);
    assert.equal(registry.list().length, 1);
  });

  test('list() returns every registered manifest', () => {
    const registry = new ModelRegistry();
    registry.register(manifest({ id: 'a' }));
    registry.register(manifest({ id: 'b' }));
    assert.deepEqual(
      registry.list().map((m) => m.id),
      ['a', 'b']
    );
  });

  describe('fromManifestList', () => {
    test('builds a registry from raw entries', () => {
      const registry = ModelRegistry.fromManifestList([manifest({ id: 'a' }), manifest({ id: 'b' })]);
      assert.equal(registry.list().length, 2);
      assert.equal(registry.resolve('a').id, 'a');
    });

    test('throws and registers nothing if any entry is invalid', () => {
      assert.throws(
        () => ModelRegistry.fromManifestList([manifest({ id: 'a' }), { id: 'bad' }]),
        ManifestValidationError
      );
    });
  });
});
