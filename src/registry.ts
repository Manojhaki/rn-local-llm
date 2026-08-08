/**
 * The model registry: holds validated manifests and resolves a model id to
 * one.
 */

import { ModelNotFoundError } from './errors.ts';
import { validateManifest, type ModelManifest } from './manifest.ts';

export class ModelRegistry {
  readonly #manifests = new Map<string, ModelManifest>();

  /** Adds a manifest, replacing any existing entry with the same id. */
  register(manifest: ModelManifest): void {
    this.#manifests.set(manifest.id, manifest);
  }

  /**
   * @throws {ModelNotFoundError} if no manifest with this id was registered.
   */
  resolve(modelId: string): ModelManifest {
    const manifest = this.#manifests.get(modelId);
    if (!manifest) {
      throw new ModelNotFoundError(modelId);
    }
    return manifest;
  }

  has(modelId: string): boolean {
    return this.#manifests.has(modelId);
  }

  /** All registered manifests, in registration order. */
  list(): readonly ModelManifest[] {
    return Array.from(this.#manifests.values());
  }

  /**
   * Builds a registry from an array of raw, untyped manifest entries —
   * e.g. a parsed manifest JSON file. Validates every entry before
   * registering any of them, so a registry never ends up partially loaded
   * from a file with one bad entry.
   *
   * @throws {import('./manifest.ts').ManifestValidationError} if any entry is invalid.
   */
  static fromManifestList(raw: readonly unknown[]): ModelRegistry {
    const manifests = raw.map((entry) => validateManifest(entry));
    const registry = new ModelRegistry();
    for (const manifest of manifests) {
      registry.register(manifest);
    }
    return registry;
  }
}
