/**
 * The typed error union for rn-local-llm.
 *
 * Every failure mode a consumer can hit — bad memory preflight, a missing
 * model, a corrupted download, an unavailable backend, a cancelled
 * operation, a prompt that overflows the context window — is one of the
 * classes below. Nothing in this library throws a bare string or an
 * untyped `Error`.
 */

export type LocalLlmErrorKind =
  | 'InsufficientMemory'
  | 'ModelNotFound'
  | 'ChecksumMismatch'
  | 'DownloadInterrupted'
  | 'BackendUnavailable'
  | 'Cancelled'
  | 'ContextOverflow';

export interface LocalLlmErrorOptions {
  cause?: unknown;
}

/**
 * Common base for every error this library throws.
 *
 * Subclasses `Error` (rather than being a plain discriminated-union object)
 * so failures reach a developer through a crash reporter with a real stack
 * and pass `instanceof Error` checks. `Object.setPrototypeOf(this,
 * new.target.prototype)` in the constructor — using `new.target`, not a
 * hardcoded class — guards the downlevel-transpilation footgun that breaks
 * `instanceof` for classes extending built-ins on Hermes and JSC, and it
 * keeps working no matter how many subclass levels sit below this one. Do
 * not remove it as dead code; `errors.test.ts` asserts on it directly.
 */
export abstract class LocalLlmErrorBase<K extends LocalLlmErrorKind> extends Error {
  readonly kind: K;
  override readonly cause: unknown;

  constructor(kind: K, message: string, options: LocalLlmErrorOptions = {}) {
    super(message);
    this.kind = kind;
    this.cause = options.cause;
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /**
   * Serializes every own field except `cause`, which may hold an
   * unserializable native object (a JSI value, a native exception). Use
   * this instead of relying on `Error`'s default (non-enumerable, mostly
   * empty) JSON shape when logging or sending an error to a crash reporter.
   */
  toJSON(): Record<string, unknown> {
    const json: Record<string, unknown> = { name: this.name, message: this.message };
    for (const [key, value] of Object.entries(this)) {
      if (key === 'cause') continue;
      json[key] = value;
    }
    return json;
  }
}

/**
 * Raised by the memory guard's preflight check when a model's declared
 * `minRamBytes` exceeds the device's currently available RAM. Raised
 * before any native allocation happens — it never follows a crash, it
 * prevents one.
 *
 * Recovery: free memory (unload the resident model, close other apps) and
 * retry, or resolve a manifest for a smaller quantization.
 */
export class InsufficientMemoryError extends LocalLlmErrorBase<'InsufficientMemory'> {
  readonly modelId: string;
  readonly requiredBytes: number;
  readonly availableBytes: number;

  constructor(
    modelId: string,
    requiredBytes: number,
    availableBytes: number,
    options?: LocalLlmErrorOptions
  ) {
    super(
      'InsufficientMemory',
      `Model "${modelId}" requires ${requiredBytes} bytes of RAM but only ${availableBytes} are available.`,
      options
    );
    this.modelId = modelId;
    this.requiredBytes = requiredBytes;
    this.availableBytes = availableBytes;
  }
}

/**
 * Raised when a model id doesn't resolve against any manifest the registry
 * has been given.
 *
 * Recovery: check the id against the registry's known ids, or confirm the
 * manifest source (bundled JSON or remote URL) was actually loaded.
 */
export class ModelNotFoundError extends LocalLlmErrorBase<'ModelNotFound'> {
  readonly modelId: string;

  constructor(modelId: string, options?: LocalLlmErrorOptions) {
    super('ModelNotFound', `No manifest is registered for model "${modelId}".`, options);
    this.modelId = modelId;
  }
}

/**
 * Raised when a downloaded file's computed SHA-256 does not match the
 * manifest's declared hash. Always raised before the file is moved out of
 * its temp path — a model that fails this check must never reach the
 * location the inference backend loads from.
 *
 * Recovery: discard the temp file (the downloader does this automatically)
 * and retry the download. A repeated mismatch on retry means the manifest's
 * hash is stale, not that the network is flaky.
 */
export class ChecksumMismatchError extends LocalLlmErrorBase<'ChecksumMismatch'> {
  readonly modelId: string;
  readonly expectedSha256: string;
  readonly actualSha256: string;

  constructor(
    modelId: string,
    expectedSha256: string,
    actualSha256: string,
    options?: LocalLlmErrorOptions
  ) {
    super(
      'ChecksumMismatch',
      `Model "${modelId}" failed checksum verification: expected ${expectedSha256}, got ${actualSha256}.`,
      options
    );
    this.modelId = modelId;
    this.expectedSha256 = expectedSha256;
    this.actualSha256 = actualSha256;
  }
}

/**
 * Raised when a download stops before completion — lost connectivity, a
 * server error, the app being force-quit. `bytesDownloaded` reflects
 * progress persisted to disk so a resumed download can continue from a
 * range request instead of starting over.
 *
 * Recovery: retry; the downloader resumes from `bytesDownloaded` rather
 * than re-fetching the whole file.
 */
export class DownloadInterruptedError extends LocalLlmErrorBase<'DownloadInterrupted'> {
  readonly modelId: string;
  readonly bytesDownloaded: number;
  readonly totalBytes: number;

  constructor(
    modelId: string,
    bytesDownloaded: number,
    totalBytes: number,
    options?: LocalLlmErrorOptions
  ) {
    super(
      'DownloadInterrupted',
      `Download of model "${modelId}" stopped at ${bytesDownloaded}/${totalBytes} bytes.`,
      options
    );
    this.modelId = modelId;
    this.bytesDownloaded = bytesDownloaded;
    this.totalBytes = totalBytes;
  }
}

/**
 * Raised when a manifest requires a backend (`llama.cpp` or `executorch`)
 * that isn't available in the current native build.
 *
 * Recovery: none at runtime — ship a build that includes the required
 * backend, or resolve a manifest whose backend is actually available.
 */
export class BackendUnavailableError extends LocalLlmErrorBase<'BackendUnavailable'> {
  readonly backend: 'llama.cpp' | 'executorch';
  readonly reason: string;

  constructor(backend: 'llama.cpp' | 'executorch', reason: string, options?: LocalLlmErrorOptions) {
    super('BackendUnavailable', `Backend "${backend}" is unavailable: ${reason}`, options);
    this.backend = backend;
    this.reason = reason;
  }
}

/**
 * Raised when a caller invokes `.cancel()` on a download, load, or
 * generation handle. Not a failure — it's the expected result of
 * cancellation and callers should treat it as control flow, not a bug to
 * report.
 *
 * Recovery: none needed. Start a new operation if one is still wanted.
 */
export class CancelledError extends LocalLlmErrorBase<'Cancelled'> {
  readonly operation: 'download' | 'load' | 'generate';

  constructor(operation: 'download' | 'load' | 'generate', options?: LocalLlmErrorOptions) {
    super('Cancelled', `The ${operation} operation was cancelled.`, options);
    this.operation = operation;
  }
}

/**
 * Raised when a `generate()` call's prompt plus requested output would
 * exceed the model's context length as declared in its manifest.
 *
 * Recovery: shorten the prompt, request fewer output tokens, or resolve a
 * manifest with a larger context length.
 */
export class ContextOverflowError extends LocalLlmErrorBase<'ContextOverflow'> {
  readonly modelId: string;
  readonly requestedTokens: number;
  readonly maxContextLength: number;

  constructor(
    modelId: string,
    requestedTokens: number,
    maxContextLength: number,
    options?: LocalLlmErrorOptions
  ) {
    super(
      'ContextOverflow',
      `Model "${modelId}" was asked for ${requestedTokens} tokens but its context length is ${maxContextLength}.`,
      options
    );
    this.modelId = modelId;
    this.requestedTokens = requestedTokens;
    this.maxContextLength = maxContextLength;
  }
}

export type LocalLlmError =
  | InsufficientMemoryError
  | ModelNotFoundError
  | ChecksumMismatchError
  | DownloadInterruptedError
  | BackendUnavailableError
  | CancelledError
  | ContextOverflowError;

/**
 * Compile-time guard against the exhaustiveness trap this file already fell
 * into once: adding a string to {@link LocalLlmErrorKind} without adding a
 * matching class leaves every `switch (err.kind)` silently non-exhaustive,
 * because switches narrow over the {@link LocalLlmError} class union, not
 * the kind string union directly. If this line stops compiling, a kind is
 * missing its class.
 */
type EveryKindHasAClass = LocalLlmErrorKind extends LocalLlmError['kind'] ? true : never;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _everyKindHasAClass: EveryKindHasAClass = true;
