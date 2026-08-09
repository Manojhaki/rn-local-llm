export {
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
  type LocalLlmErrorOptions,
} from './errors.ts';

export {
  validateManifest,
  ManifestValidationError,
  type ModelManifest,
  type ModelBackend,
  type ModelSource,
} from './manifest.ts';

export { ModelRegistry } from './registry.ts';

export { checkMemoryCapability, type MemoryCapabilityOptions } from './memoryGuard.ts';

export { assertChecksumMatches } from './checksum.ts';

export {
  initialDownloadState,
  transition,
  InvalidDownloadTransitionError,
  type DownloadState,
  type DownloadStatus,
  type DownloadEvent,
} from './download.ts';

export {
  downloadModel,
  type DownloadModelOptions,
  type DownloadModelResult,
  type DownloadModelHandle,
  type ModelTransfer,
  type TransferRequest,
  type TransferHandle,
  type FileHasher,
  type ModelFileStore,
} from './downloadModel.ts';

export {
  initialLoadLockState,
  transitionLoadLock,
  InvalidLoadLockTransitionError,
  type LoadLockState,
  type LoadLockStatus,
  type LoadLockEvent,
  type LoadLockTransitionResult,
} from './loadLock.ts';
