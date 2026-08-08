/**
 * Checksum verification's decision logic.
 *
 * Computing a SHA-256 over a downloaded file needs a hashing implementation
 * — `node:crypto` isn't available in React Native, and no crypto library has
 * been chosen yet (that's a dependency decision, not made here; see
 * CLAUDE.md's "Ask before adding a dependency" rule). This module only
 * compares an already-computed hash against the manifest's expected one and
 * raises the typed error — the comparison the downloader runs right before
 * it atomically moves a verified file into place.
 */

import { ChecksumMismatchError } from './errors.ts';

/**
 * @throws {ChecksumMismatchError} if `actualSha256` doesn't match `expectedSha256` (case-insensitive).
 */
export function assertChecksumMatches(modelId: string, expectedSha256: string, actualSha256: string): void {
  if (expectedSha256.toLowerCase() !== actualSha256.toLowerCase()) {
    throw new ChecksumMismatchError(modelId, expectedSha256, actualSha256);
  }
}
