/**
 * The downloader's free-disk preflight check.
 *
 * Deliberately shaped like `memoryGuard.ts`: pure decision logic, with the
 * platform-specific part (actually asking the OS how much space is free)
 * left to an injected port. A download that fills the user's disk and
 * fails at 98% is exactly the field condition this library exists to
 * prevent, and the cheapest place to catch it is before the first byte.
 */

import { InsufficientDiskSpaceError } from './errors.ts';

export interface DiskCapacityRequest {
  readonly modelId: string;
  /** The model's full size on disk, from its manifest. */
  readonly fileSizeBytes: number;
  /** Bytes already on disk from an interrupted attempt; those don't need re-reserving. */
  readonly alreadyDownloadedBytes?: number;
  readonly availableBytes: number;
  /**
   * Extra free space to insist on beyond the model itself, so a download
   * doesn't leave the device with an unusable amount of headroom. The OS
   * also tends to report "available" optimistically.
   * @default 0
   */
  readonly headroomBytes?: number;
}

/**
 * Checks whether there's room to finish this download.
 *
 * Assumes the temp path and the final destination live on the same
 * filesystem, so moving the verified file into place is a rename rather
 * than a second full-size copy. If a host ever puts them on different
 * volumes, this check would need to reserve roughly twice the file size.
 *
 * @throws {InsufficientDiskSpaceError} if the remaining bytes plus headroom
 * exceed `availableBytes`.
 */
export function checkDiskCapacity(request: DiskCapacityRequest): void {
  const alreadyDownloadedBytes = request.alreadyDownloadedBytes ?? 0;
  const headroomBytes = request.headroomBytes ?? 0;
  const remainingBytes = Math.max(0, request.fileSizeBytes - alreadyDownloadedBytes);
  const requiredBytes = remainingBytes + headroomBytes;

  if (request.availableBytes < requiredBytes) {
    throw new InsufficientDiskSpaceError(request.modelId, requiredBytes, request.availableBytes);
  }
}
