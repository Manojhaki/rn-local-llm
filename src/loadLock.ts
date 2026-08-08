/**
 * The global load lock's decision logic: locked architecture decision #4
 * — "one model resident at a time" — enforced as a state machine rather
 * than left as an implicit convention.
 *
 * This is the pure reducer only. It doesn't hold native memory or call
 * into a backend; it tracks which model id is loading or loaded and tells
 * the caller which model (if any) needs to be natively unloaded as a
 * result of a transition. A native load lock will be driven by dispatching
 * events into this reducer.
 */

import type { LocalLlmError } from './errors.ts';

export type LoadLockStatus = 'idle' | 'loading' | 'loaded';

export type LoadLockState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading'; readonly modelId: string }
  | { readonly status: 'loaded'; readonly modelId: string };

export type LoadLockEvent =
  /** A consumer wants `modelId` resident. If another model is loading or loaded, it's displaced, not queued. */
  | { readonly type: 'load'; readonly modelId: string }
  | { readonly type: 'loadComplete' }
  | { readonly type: 'loadFailed'; readonly error: LocalLlmError }
  /** The consumer cancelled an in-flight load. */
  | { readonly type: 'cancel' }
  /** A resident model is being torn down: explicit call, app backgrounded, or OS memory pressure. */
  | { readonly type: 'unload' };

export interface LoadLockTransitionResult {
  readonly state: LoadLockState;
  /**
   * Set when this transition displaces a model that was loading or resident.
   * The host must issue a native unload for this model id. When a `load`
   * displaces a different model's in-flight load, the host should also
   * reject that model's pending load promise with `new CancelledError('load')`
   * (see errors.ts) — the reducer only reports which model was displaced,
   * it doesn't hold the promise to reject.
   */
  readonly modelToUnload?: string;
}

/**
 * Raised when an event doesn't apply to the load lock's current status —
 * e.g. `loadComplete` with nothing loading, or `unload` while idle. A
 * caller bug, not a runtime/device condition, so — like
 * `InvalidDownloadTransitionError` — it isn't a member of `LocalLlmErrorKind`.
 */
export class InvalidLoadLockTransitionError extends Error {
  readonly status: LoadLockStatus;
  readonly eventType: LoadLockEvent['type'];

  constructor(status: LoadLockStatus, eventType: LoadLockEvent['type'], detail?: string) {
    super(`Cannot apply event "${eventType}" to a load lock in status "${status}"` + (detail ? `: ${detail}` : '.'));
    this.name = 'InvalidLoadLockTransitionError';
    this.status = status;
    this.eventType = eventType;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function initialLoadLockState(): LoadLockState {
  return { status: 'idle' };
}

/**
 * @throws {InvalidLoadLockTransitionError} if `event` doesn't apply to `state.status`.
 */
export function transitionLoadLock(state: LoadLockState, event: LoadLockEvent): LoadLockTransitionResult {
  switch (event.type) {
    case 'load': {
      if (state.status === 'idle') {
        return { state: { status: 'loading', modelId: event.modelId } };
      }
      if (state.modelId === event.modelId) {
        // Already loading or already resident — idempotent no-op.
        return { state };
      }
      // A different model was requested: it displaces whatever was
      // loading or resident, per the memory contract. Not queued.
      return { state: { status: 'loading', modelId: event.modelId }, modelToUnload: state.modelId };
    }

    case 'loadComplete': {
      if (state.status !== 'loading') {
        throw new InvalidLoadLockTransitionError(state.status, event.type, 'nothing is loading');
      }
      return { state: { status: 'loaded', modelId: state.modelId } };
    }

    case 'loadFailed': {
      if (state.status !== 'loading') {
        throw new InvalidLoadLockTransitionError(state.status, event.type, 'nothing is loading');
      }
      return { state: { status: 'idle' } };
    }

    case 'cancel': {
      if (state.status !== 'loading') {
        throw new InvalidLoadLockTransitionError(state.status, event.type, 'only an in-flight load can be cancelled');
      }
      return { state: { status: 'idle' }, modelToUnload: state.modelId };
    }

    case 'unload': {
      if (state.status !== 'loaded') {
        throw new InvalidLoadLockTransitionError(
          state.status,
          event.type,
          state.status === 'loading' ? 'a load in progress must be cancelled, not unloaded' : 'nothing is loaded'
        );
      }
      return { state: { status: 'idle' }, modelToUnload: state.modelId };
    }
  }
}
