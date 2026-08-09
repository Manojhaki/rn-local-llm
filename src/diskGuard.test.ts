import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { checkDiskCapacity } from './diskGuard.ts';
import { InsufficientDiskSpaceError } from './errors.ts';

const MODEL_ID = 'qwen3-1.7b-q4';
const FILE_SIZE = 1_200_000_000;

describe('checkDiskCapacity', () => {
  test('passes when there is more than enough space', () => {
    assert.doesNotThrow(() =>
      checkDiskCapacity({ modelId: MODEL_ID, fileSizeBytes: FILE_SIZE, availableBytes: 8_000_000_000 })
    );
  });

  test('passes when available space exactly equals what is needed', () => {
    assert.doesNotThrow(() =>
      checkDiskCapacity({ modelId: MODEL_ID, fileSizeBytes: FILE_SIZE, availableBytes: FILE_SIZE })
    );
  });

  test('throws InsufficientDiskSpaceError when space is short', () => {
    assert.throws(
      () =>
        checkDiskCapacity({ modelId: MODEL_ID, fileSizeBytes: FILE_SIZE, availableBytes: 500_000_000 }),
      (err: unknown) =>
        err instanceof InsufficientDiskSpaceError &&
        err.modelId === MODEL_ID &&
        err.requiredBytes === FILE_SIZE &&
        err.availableBytes === 500_000_000
    );
  });

  test('throws when short by a single byte', () => {
    assert.throws(
      () =>
        checkDiskCapacity({ modelId: MODEL_ID, fileSizeBytes: FILE_SIZE, availableBytes: FILE_SIZE - 1 }),
      InsufficientDiskSpaceError
    );
  });

  describe('headroom', () => {
    test('is added on top of the file size', () => {
      assert.throws(
        () =>
          checkDiskCapacity({
            modelId: MODEL_ID,
            fileSizeBytes: FILE_SIZE,
            availableBytes: FILE_SIZE,
            headroomBytes: 500_000_000,
          }),
        (err: unknown) =>
          err instanceof InsufficientDiskSpaceError && err.requiredBytes === FILE_SIZE + 500_000_000
      );
    });

    test('passes once headroom is genuinely available', () => {
      assert.doesNotThrow(() =>
        checkDiskCapacity({
          modelId: MODEL_ID,
          fileSizeBytes: FILE_SIZE,
          availableBytes: FILE_SIZE + 500_000_000,
          headroomBytes: 500_000_000,
        })
      );
    });
  });

  describe('resumed downloads', () => {
    test('only reserves the bytes still to be written', () => {
      // 1.2 GB model, 1 GB already on disk — 200 MB free is plenty.
      assert.doesNotThrow(() =>
        checkDiskCapacity({
          modelId: MODEL_ID,
          fileSizeBytes: FILE_SIZE,
          alreadyDownloadedBytes: 1_000_000_000,
          availableBytes: 200_000_001,
        })
      );
    });

    test('still throws when even the remainder does not fit', () => {
      assert.throws(
        () =>
          checkDiskCapacity({
            modelId: MODEL_ID,
            fileSizeBytes: FILE_SIZE,
            alreadyDownloadedBytes: 1_000_000_000,
            availableBytes: 100_000_000,
          }),
        (err: unknown) => err instanceof InsufficientDiskSpaceError && err.requiredBytes === 200_000_000
      );
    });

    test('a fully downloaded file requires no additional space', () => {
      assert.doesNotThrow(() =>
        checkDiskCapacity({
          modelId: MODEL_ID,
          fileSizeBytes: FILE_SIZE,
          alreadyDownloadedBytes: FILE_SIZE,
          availableBytes: 0,
        })
      );
    });

    test('never demands negative space if more bytes are on disk than expected', () => {
      assert.doesNotThrow(() =>
        checkDiskCapacity({
          modelId: MODEL_ID,
          fileSizeBytes: FILE_SIZE,
          alreadyDownloadedBytes: FILE_SIZE + 999,
          availableBytes: 0,
        })
      );
    });

    test('headroom still applies to a resumed download', () => {
      assert.throws(
        () =>
          checkDiskCapacity({
            modelId: MODEL_ID,
            fileSizeBytes: FILE_SIZE,
            alreadyDownloadedBytes: FILE_SIZE,
            availableBytes: 0,
            headroomBytes: 100,
          }),
        (err: unknown) => err instanceof InsufficientDiskSpaceError && err.requiredBytes === 100
      );
    });
  });
});
