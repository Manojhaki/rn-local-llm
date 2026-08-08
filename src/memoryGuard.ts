/**
 * The memory guard's preflight check.
 *
 * This is the decision logic only: given a manifest and however many bytes
 * of RAM are currently available, decide whether a load may proceed.
 * Actually reading available RAM from the OS is native, platform-specific
 * work (`getDeviceCapabilities()`) that doesn't exist yet — this function
 * is what that native reading will feed into once it does.
 */

import { InsufficientMemoryError } from './errors.ts';
import type { ModelManifest } from './manifest.ts';

export interface MemoryCapabilityOptions {
  /**
   * Extra RAM, beyond the manifest's declared `minRamBytes`, to require
   * before allowing a load. A safety margin against the OS reporting
   * "available" memory more optimistically than what's actually free
   * before memory pressure hits. Defaults to 0.
   */
  readonly headroomBytes?: number;
}

/**
 * @throws {InsufficientMemoryError} if `availableRamBytes` is below the
 * manifest's `minRamBytes` plus any configured headroom.
 */
export function checkMemoryCapability(
  manifest: ModelManifest,
  availableRamBytes: number,
  options: MemoryCapabilityOptions = {}
): void {
  const headroomBytes = options.headroomBytes ?? 0;
  const requiredBytes = manifest.minRamBytes + headroomBytes;
  if (availableRamBytes < requiredBytes) {
    throw new InsufficientMemoryError(manifest.id, requiredBytes, availableRamBytes);
  }
}
