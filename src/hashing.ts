/**
 * The SHA-256 computation `checksum.ts` deliberately doesn't do (see its
 * header comment) — this is that missing half.
 *
 * **Unverified beyond `tsc --noEmit`.** `expo-file-system` and
 * `react-native-quick-crypto` are real native modules; they can't be linked
 * or executed under plain `node:test`, and this environment has no RN/Expo
 * app project (M0) to run them in either. There is deliberately no
 * `hashing.test.ts` — a test that can only ever pass vacuously (or crash on
 * an unlinked native module) is worse than no test, per this repo's own
 * testing rules. This file typechecks against the real, installed
 * `.d.ts` of both packages (confirmed by reading them directly — see
 * CLAUDE.md's "Decisions already made") but has never been run.
 */

import { createHash } from 'react-native-quick-crypto';
import type { File } from 'expo-file-system';

/**
 * Computes the lowercase-hex SHA-256 of a file's contents, streaming it in
 * chunks rather than reading the whole file into memory — required for
 * multi-gigabyte model files on memory-constrained devices.
 *
 * @throws whatever `file.stream()` throws if the file doesn't exist or can't be read.
 */
export async function computeSha256(file: File): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of file.stream()) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}
