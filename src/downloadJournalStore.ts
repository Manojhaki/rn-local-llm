/**
 * A `DownloadJournalStore` backed by one small JSON file per model,
 * written through expo-file-system.
 *
 * **Unverified beyond `tsc --noEmit`**, like the other two adapters:
 * `expo-file-system` is a real native module and can't be linked or run
 * without an actual RN/Expo app (M0). No test file, for the reason this
 * repo keeps repeating — a test that can only pass vacuously is worse than
 * no test. Not exported from `index.ts`; reachable at
 * `rn-local-llm/journal-store`.
 *
 * No new dependency: `expo-file-system` is already a peer, and a handful of
 * small JSON files is the right shape for this. A key-value store (MMKV,
 * AsyncStorage) would be a second storage dependency to persist a few
 * hundred bytes per in-flight download.
 *
 * One file per model rather than a single shared index, deliberately: two
 * concurrent downloads writing one file would race, and a torn write to a
 * shared index would lose every entry instead of one. A corrupt individual
 * file costs exactly one resume, and `validateJournalEntry()` turns that
 * into a clean restart rather than a crash.
 */

import { Directory, File } from 'expo-file-system';
import {
  validateJournalEntry,
  type DownloadJournalEntry,
  type DownloadJournalStore,
} from './downloadJournal.ts';

/** Keeps a model id safe to use as a filename, and reversible enough to debug. */
function fileNameFor(modelId: string): string {
  return `${encodeURIComponent(modelId)}.json`;
}

export class ExpoDownloadJournalStore implements DownloadJournalStore {
  readonly #directory: Directory;

  /**
   * @param directory where journal files live. Use a location the OS does
   * not sweep — a cache directory would defeat the point, since the journal
   * has to outlive exactly the kind of pressure that clears caches.
   */
  constructor(directory: Directory) {
    this.#directory = directory;
  }

  #fileFor(modelId: string): File {
    return new File(this.#directory, fileNameFor(modelId));
  }

  async write(entry: DownloadJournalEntry): Promise<void> {
    if (!this.#directory.exists) {
      this.#directory.create({ intermediates: true });
    }
    const file = this.#fileFor(entry.modelId);
    if (!file.exists) {
      file.create();
    }
    file.write(JSON.stringify(entry));
  }

  async clear(modelId: string): Promise<void> {
    const file = this.#fileFor(modelId);
    if (file.exists) {
      file.delete();
    }
  }

  /**
   * @returns the entry, or `undefined` if there is none — including when a
   * file exists but is unreadable or fails validation. A corrupt journal is
   * treated as no journal: the caller restarts the download, which is the
   * only safe reading of bytes we can't account for.
   */
  async read(modelId: string): Promise<DownloadJournalEntry | undefined> {
    const file = this.#fileFor(modelId);
    if (!file.exists) {
      return undefined;
    }
    try {
      return validateJournalEntry(JSON.parse(file.textSync()));
    } catch {
      return undefined;
    }
  }

  /**
   * Every readable entry. Unreadable ones are skipped rather than throwing,
   * so one corrupt file can't block sweeping the rest.
   */
  async list(): Promise<readonly DownloadJournalEntry[]> {
    if (!this.#directory.exists) {
      return [];
    }
    const entries: DownloadJournalEntry[] = [];
    for (const item of this.#directory.list()) {
      if (!(item instanceof File) || !item.name.endsWith('.json')) {
        continue;
      }
      try {
        entries.push(validateJournalEntry(JSON.parse(item.textSync())));
      } catch {
        continue;
      }
    }
    return entries;
  }
}
