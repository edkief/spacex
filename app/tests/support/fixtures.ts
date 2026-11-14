import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect } from 'vitest';
import { canonicalStringify } from '@shared/canonical.ts';

export const FIXTURE_DIR = path.join(import.meta.dirname, '../../src/shared/galaxy/__fixtures__');

/** Serialises a fixture value exactly as committed: canonical keys, 2-space indent, final newline. */
export function serializeFixture(value: unknown): string {
  return canonicalStringify(value, 2) + '\n';
}

const DIGEST_KEYS = new Set(['checksum', 'sha256']);

/** Sort order for diffing: ordinary keys alphabetically, digest keys last so data diffs first. */
function byDataFirst(a: string, b: string): number {
  const digestOrder = Number(DIGEST_KEYS.has(a)) - Number(DIGEST_KEYS.has(b));
  return digestOrder !== 0 ? digestOrder : a < b ? -1 : a > b ? 1 : 0;
}

/** Finds the first differing path between two JSON values, or undefined when equal. */
export function firstDiffPath(a: unknown, b: unknown, at = '$'): string | undefined {
  if (Object.is(a, b)) return undefined;
  const bothObjects = typeof a === 'object' && typeof b === 'object' && a !== null && b !== null;
  if (!bothObjects) return `${at}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`;
  if (Array.isArray(a) !== Array.isArray(b)) return `${at}: array/object mismatch`;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort(byDataFirst);
  for (const key of keys) {
    if (!(key in left) || !(key in right)) return `${at}.${key}: present on one side only`;
    const diff = firstDiffPath(
      left[key],
      right[key],
      Array.isArray(a) ? `${at}[${key}]` : `${at}.${key}`,
    );
    if (diff) return diff;
  }
  return undefined;
}

/** Reads a committed fixture as text. */
export function readFixture(file: string): string {
  const full = path.join(FIXTURE_DIR, file);
  if (!existsSync(full)) throw new Error(`Missing fixture ${file}; run npm run snapshot:update`);
  return readFileSync(full, 'utf8');
}

/**
 * Asserts a freshly generated value matches its committed fixture byte-for-byte, reporting the
 * first differing path (generator drift) before falling back to the raw text comparison.
 */
export function expectMatchesFixture(file: string, value: unknown): void {
  const committed = readFixture(file);
  const generated = serializeFixture(value);
  const diff = firstDiffPath(JSON.parse(committed), JSON.parse(generated));
  expect(diff, `${file}: first difference at ${diff ?? '-'}`).toBeUndefined();
  expect(generated === committed, `${file}: same data but different serialization`).toBe(true);
}
