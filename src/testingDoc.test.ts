import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * TESTING.md cites specific test names as evidence for what each field
 * condition actually covers. Those citations are the whole value of the
 * document — and they rot the moment a test is renamed, which is exactly
 * the "a stale record is worse than none, because it will be believed"
 * failure CLAUDE.md warns about.
 *
 * So they're checked rather than trusted. This parses the "Covered today"
 * citations out of TESTING.md and asserts every one names a test that
 * really exists in the file it claims.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

/** Every test name declared in a given test file, via its `test('...')` calls. */
function testNamesIn(file: string): Set<string> {
  const source = readFileSync(join(here, file), 'utf8');
  const names = new Set<string>();
  for (const match of source.matchAll(/\btest\(\s*'((?:[^'\\]|\\.)*)'/g)) {
    const name = match[1];
    if (name !== undefined) {
      names.add(name.replace(/\\'/g, "'"));
    }
  }
  return names;
}

/**
 * Citations look like:
 *   - `download.test.ts` — `first test name`, `second test name`
 * possibly wrapped across lines. Returns [file, testName] pairs.
 */
function citationsIn(markdown: string): [string, string][] {
  const pairs: [string, string][] = [];
  const lines = markdown.split('\n');

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const start = /^- `([\w.]+\.test\.ts)` — (.*)$/.exec(line);
    if (!start) continue;

    const file = start[1];
    let rest = start[2] ?? '';
    // Absorb wrapped continuation lines (indented, not a new bullet).
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j] ?? '';
      if (!/^\s+\S/.test(next) || /^\s*-\s/.test(next)) break;
      rest += ` ${next.trim()}`;
      i = j;
    }

    for (const quoted of rest.matchAll(/`([^`]+)`/g)) {
      const name = quoted[1];
      if (file !== undefined && name !== undefined) {
        pairs.push([file, name]);
      }
    }
  }
  return pairs;
}

const markdown = readFileSync(join(repoRoot, 'TESTING.md'), 'utf8');
const citations = citationsIn(markdown);

describe('TESTING.md citations', () => {
  test('the document actually cites some tests', () => {
    // Guards against the parser silently matching nothing and this whole
    // suite passing vacuously — the exact failure mode CLAUDE.md rejects.
    assert.ok(citations.length >= 15, `expected many citations, found ${citations.length}`);
  });

  test('every cited file is a real test file', () => {
    const actual = new Set(readdirSync(here).filter((f) => f.endsWith('.test.ts')));
    for (const [file] of citations) {
      assert.ok(actual.has(file), `TESTING.md cites "${file}", which does not exist`);
    }
  });

  test('every cited test name exists in the file it is attributed to', () => {
    const cache = new Map<string, Set<string>>();
    const missing: string[] = [];

    for (const [file, name] of citations) {
      let names = cache.get(file);
      if (!names) {
        names = testNamesIn(file);
        cache.set(file, names);
      }
      if (!names.has(name)) {
        missing.push(`${file}: "${name}"`);
      }
    }

    assert.deepEqual(
      missing,
      [],
      `TESTING.md cites tests that no longer exist:\n  ${missing.join('\n  ')}`
    );
  });

  test('lists all eight field conditions from CLAUDE.md', () => {
    // The document's purpose is completeness; a dropped row is a silent gap.
    const rows = markdown.match(/^\| \d \| /gm) ?? [];
    assert.equal(rows.length, 8, 'expected exactly 8 rows in the status table');
  });
});
