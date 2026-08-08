/**
 * The model registry's manifest schema.
 *
 * A manifest describes one model: which backend loads it, its quantization,
 * its file size and checksum, the minimum device RAM it needs, its context
 * length, and where to get the file. Manifests are static JSON — resolvable
 * from a bundled asset or a remote URL — never trust one without validating
 * it first.
 */

export type ModelBackend = 'llama.cpp' | 'executorch';

/** Where a model's file comes from: bundled with the app, or downloaded. */
export type ModelSource =
  | { readonly kind: 'bundled'; readonly path: string }
  | { readonly kind: 'url'; readonly url: string };

export interface ModelManifest {
  readonly id: string;
  readonly backend: ModelBackend;
  readonly quantization: string;
  readonly fileSizeBytes: number;
  /** Lowercase hex SHA-256 of the model file. Verified after download, before the file is used. */
  readonly sha256: string;
  readonly minRamBytes: number;
  readonly contextLength: number;
  readonly source: ModelSource;
}

/**
 * Raised by {@link validateManifest} when raw manifest data doesn't match
 * the {@link ModelManifest} shape.
 *
 * This is deliberately **not** a member of `LocalLlmErrorKind` (see
 * errors.ts): that union covers runtime failure modes a device or network
 * condition can trigger. A malformed manifest is a registry-authoring
 * mistake, caught once when the manifest is loaded — the two shouldn't be
 * handled through the same exhaustive `switch` a consumer writes for
 * generate()/load()/download() failures.
 */
export class ManifestValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid model manifest:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ManifestValidationError';
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

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

const SHA256_HEX = /^[0-9a-f]{64}$/i;
const MODEL_BACKENDS: readonly ModelBackend[] = ['llama.cpp', 'executorch'];

function validateSource(raw: unknown, issues: string[]): void {
  if (!isRecord(raw)) {
    issues.push('source must be an object');
    return;
  }
  if (raw['kind'] === 'bundled') {
    if (!isNonEmptyString(raw['path'])) {
      issues.push('source.path must be a non-empty string when source.kind is "bundled"');
    }
  } else if (raw['kind'] === 'url') {
    if (!isNonEmptyString(raw['url'])) {
      issues.push('source.url must be a non-empty string when source.kind is "url"');
    }
  } else {
    issues.push('source.kind must be "bundled" or "url"');
  }
}

/**
 * Validates raw, untyped data (parsed JSON, typically) against the
 * {@link ModelManifest} shape. Collects every problem found rather than
 * stopping at the first, so a registry author fixing a manifest sees the
 * whole list at once.
 *
 * @throws {ManifestValidationError} if `raw` doesn't match the manifest shape.
 */
export function validateManifest(raw: unknown): ModelManifest {
  const issues: string[] = [];

  if (!isRecord(raw)) {
    throw new ManifestValidationError(['manifest must be an object']);
  }

  if (!isNonEmptyString(raw['id'])) {
    issues.push('id must be a non-empty string');
  }
  if (!MODEL_BACKENDS.includes(raw['backend'] as ModelBackend)) {
    issues.push(`backend must be one of ${MODEL_BACKENDS.map((b) => `"${b}"`).join(', ')}`);
  }
  if (!isNonEmptyString(raw['quantization'])) {
    issues.push('quantization must be a non-empty string');
  }
  if (!isPositiveInteger(raw['fileSizeBytes'])) {
    issues.push('fileSizeBytes must be a positive integer');
  }
  if (typeof raw['sha256'] !== 'string' || !SHA256_HEX.test(raw['sha256'])) {
    issues.push('sha256 must be a 64-character lowercase hex string');
  }
  if (!isPositiveInteger(raw['minRamBytes'])) {
    issues.push('minRamBytes must be a positive integer');
  }
  if (!isPositiveInteger(raw['contextLength'])) {
    issues.push('contextLength must be a positive integer');
  }
  validateSource(raw['source'], issues);

  if (issues.length > 0) {
    throw new ManifestValidationError(issues);
  }

  return {
    id: raw['id'] as string,
    backend: raw['backend'] as ModelBackend,
    quantization: raw['quantization'] as string,
    fileSizeBytes: raw['fileSizeBytes'] as number,
    sha256: (raw['sha256'] as string).toLowerCase(),
    minRamBytes: raw['minRamBytes'] as number,
    contextLength: raw['contextLength'] as number,
    source: raw['source'] as ModelSource,
  };
}
