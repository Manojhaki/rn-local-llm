import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  initialLoadLockState,
  transitionLoadLock,
  InvalidLoadLockTransitionError,
  type LoadLockState,
} from './loadLock.ts';
import { InsufficientMemoryError } from './errors.ts';

function assertInvalidTransition(fn: () => unknown): void {
  assert.throws(fn, InvalidLoadLockTransitionError);
}

describe('initialLoadLockState', () => {
  test('starts idle', () => {
    assert.deepEqual(initialLoadLockState(), { status: 'idle' });
  });
});

describe('load', () => {
  test('idle -> loading, no model to unload', () => {
    const { state, modelToUnload } = transitionLoadLock(initialLoadLockState(), { type: 'load', modelId: 'a' });
    assert.deepEqual(state, { status: 'loading', modelId: 'a' });
    assert.equal(modelToUnload, undefined);
  });

  test('requesting the same model while it is already loading is a no-op', () => {
    const loading: LoadLockState = { status: 'loading', modelId: 'a' };
    const result = transitionLoadLock(loading, { type: 'load', modelId: 'a' });
    assert.deepEqual(result.state, loading);
    assert.equal(result.modelToUnload, undefined);
  });

  test('requesting the same model while it is already loaded is a no-op', () => {
    const loaded: LoadLockState = { status: 'loaded', modelId: 'a' };
    const result = transitionLoadLock(loaded, { type: 'load', modelId: 'a' });
    assert.deepEqual(result.state, loaded);
    assert.equal(result.modelToUnload, undefined);
  });

  test('a second model requested while the first is loading displaces it', () => {
    const loading: LoadLockState = { status: 'loading', modelId: 'a' };
    const result = transitionLoadLock(loading, { type: 'load', modelId: 'b' });
    assert.deepEqual(result.state, { status: 'loading', modelId: 'b' });
    assert.equal(result.modelToUnload, 'a');
  });

  test('a second model requested while the first is loaded displaces it', () => {
    const loaded: LoadLockState = { status: 'loaded', modelId: 'a' };
    const result = transitionLoadLock(loaded, { type: 'load', modelId: 'b' });
    assert.deepEqual(result.state, { status: 'loading', modelId: 'b' });
    assert.equal(result.modelToUnload, 'a');
  });
});

describe('loadComplete', () => {
  test('loading -> loaded', () => {
    const loading: LoadLockState = { status: 'loading', modelId: 'a' };
    const { state, modelToUnload } = transitionLoadLock(loading, { type: 'loadComplete' });
    assert.deepEqual(state, { status: 'loaded', modelId: 'a' });
    assert.equal(modelToUnload, undefined);
  });

  test('throws if nothing is loading', () => {
    assertInvalidTransition(() => transitionLoadLock(initialLoadLockState(), { type: 'loadComplete' }));
    assertInvalidTransition(() =>
      transitionLoadLock({ status: 'loaded', modelId: 'a' }, { type: 'loadComplete' })
    );
  });
});

describe('loadFailed', () => {
  test('loading -> idle', () => {
    const loading: LoadLockState = { status: 'loading', modelId: 'a' };
    const error = new InsufficientMemoryError('a', 2_000_000_000, 1_000_000_000);
    const { state, modelToUnload } = transitionLoadLock(loading, { type: 'loadFailed', error });
    assert.deepEqual(state, { status: 'idle' });
    assert.equal(modelToUnload, undefined);
  });

  test('throws if nothing is loading', () => {
    const error = new InsufficientMemoryError('a', 2_000_000_000, 1_000_000_000);
    assertInvalidTransition(() => transitionLoadLock(initialLoadLockState(), { type: 'loadFailed', error }));
  });
});

describe('cancel', () => {
  test('loading -> idle, reports the cancelled model for unload', () => {
    const loading: LoadLockState = { status: 'loading', modelId: 'a' };
    const { state, modelToUnload } = transitionLoadLock(loading, { type: 'cancel' });
    assert.deepEqual(state, { status: 'idle' });
    assert.equal(modelToUnload, 'a');
  });

  test('throws if idle', () => {
    assertInvalidTransition(() => transitionLoadLock(initialLoadLockState(), { type: 'cancel' }));
  });

  test('throws if already loaded (nothing in flight to cancel)', () => {
    assertInvalidTransition(() => transitionLoadLock({ status: 'loaded', modelId: 'a' }, { type: 'cancel' }));
  });
});

describe('unload', () => {
  test('loaded -> idle, reports the model for unload', () => {
    const loaded: LoadLockState = { status: 'loaded', modelId: 'a' };
    const { state, modelToUnload } = transitionLoadLock(loaded, { type: 'unload' });
    assert.deepEqual(state, { status: 'idle' });
    assert.equal(modelToUnload, 'a');
  });

  test('throws if idle', () => {
    assertInvalidTransition(() => transitionLoadLock(initialLoadLockState(), { type: 'unload' }));
  });

  test('throws if only loading (must cancel instead)', () => {
    assertInvalidTransition(() =>
      transitionLoadLock({ status: 'loading', modelId: 'a' }, { type: 'unload' })
    );
  });
});

describe('end-to-end paths', () => {
  test('happy path: load -> loadComplete -> unload', () => {
    let result = transitionLoadLock(initialLoadLockState(), { type: 'load', modelId: 'a' });
    result = transitionLoadLock(result.state, { type: 'loadComplete' });
    assert.deepEqual(result.state, { status: 'loaded', modelId: 'a' });

    result = transitionLoadLock(result.state, { type: 'unload' });
    assert.deepEqual(result.state, { status: 'idle' });
    assert.equal(result.modelToUnload, 'a');
  });

  test('second model requested while the first is loading (the documented test scenario)', () => {
    let result = transitionLoadLock(initialLoadLockState(), { type: 'load', modelId: 'a' });
    assert.equal(result.state.status, 'loading');

    // Model "b" requested before "a" finished loading.
    result = transitionLoadLock(result.state, { type: 'load', modelId: 'b' });
    assert.deepEqual(result.state, { status: 'loading', modelId: 'b' });
    assert.equal(result.modelToUnload, 'a'); // caller must unload a's partial native state

    result = transitionLoadLock(result.state, { type: 'loadComplete' });
    assert.deepEqual(result.state, { status: 'loaded', modelId: 'b' });
  });

  test('loading a second model while the first is fully resident unloads the first', () => {
    let result = transitionLoadLock(initialLoadLockState(), { type: 'load', modelId: 'a' });
    result = transitionLoadLock(result.state, { type: 'loadComplete' });
    assert.deepEqual(result.state, { status: 'loaded', modelId: 'a' });

    result = transitionLoadLock(result.state, { type: 'load', modelId: 'b' });
    assert.deepEqual(result.state, { status: 'loading', modelId: 'b' });
    assert.equal(result.modelToUnload, 'a');

    result = transitionLoadLock(result.state, { type: 'loadComplete' });
    assert.deepEqual(result.state, { status: 'loaded', modelId: 'b' });
  });

  test('a failed load returns to idle and a subsequent load works normally', () => {
    let result = transitionLoadLock(initialLoadLockState(), { type: 'load', modelId: 'a' });
    result = transitionLoadLock(result.state, {
      type: 'loadFailed',
      error: new InsufficientMemoryError('a', 2_000_000_000, 1_000_000_000),
    });
    assert.deepEqual(result.state, { status: 'idle' });

    result = transitionLoadLock(result.state, { type: 'load', modelId: 'a' });
    assert.deepEqual(result.state, { status: 'loading', modelId: 'a' });
  });
});
