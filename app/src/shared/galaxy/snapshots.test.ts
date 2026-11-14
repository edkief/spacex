import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  FIXTURE_DIR,
  expectMatchesFixture,
  firstDiffPath,
  readFixture,
} from '@tests/support/fixtures.ts';
import { snapshotCases } from '@tests/support/snapshotCases.ts';

// The determinism contract (SC-2): these committed fixtures lock star chart, systems and surface
// chunks for the dev seed. A failure means generator output drifted; read __fixtures__/README.md
// before regenerating anything.
describe('galaxy snapshot fixtures', () => {
  const cases = snapshotCases();

  it.each(cases.map(({ file, build }) => [file, build] as const))(
    '%s matches the regenerated output byte-for-byte',
    (file, build) => {
      expectMatchesFixture(file, build());
    },
  );

  it('covers the required fixtures plus the digest fixture and leaves no stale files behind', () => {
    const files = cases.map((c) => c.file).sort();
    expect(files).toEqual([
      'galaxy-digests.json',
      'stars-dev-seed.json',
      'surface-0-0.json',
      'surface-0-1.json',
      'surface-1-0.json',
      'surface-south-0-0.json',
      'system-star-0.json',
      'system-star-1.json',
    ]);
    const onDisk = readdirSync(FIXTURE_DIR)
      .filter((name) => name !== 'README.md')
      .sort();
    expect(onDisk).toEqual(files);
  });

  it('stores fixtures in canonical form (sorted keys, 2-space indent, trailing newline)', () => {
    for (const { file } of cases) {
      const text = readFixture(file);
      expect(text.endsWith('}\n')).toBe(true);
      expect(text).toBe(JSON.stringify(sortDeep(JSON.parse(text)), null, 2) + '\n');
    }
  });

  it('detects a corrupted generator output and reports the first differing path', () => {
    const stars = JSON.parse(readFixture('stars-dev-seed.json')) as { stars: { class: string }[] };
    const tampered = structuredClone(stars);
    tampered.stars[7]!.class = tampered.stars[7]!.class === 'M' ? 'K' : 'M';
    expect(firstDiffPath(stars, tampered)).toBe(
      '$.stars[7].class: "' + stars.stars[7]!.class + '" !== "' + tampered.stars[7]!.class + '"',
    );
    expect(() => expectMatchesFixture('stars-dev-seed.json', tampered)).toThrow(
      /stars\[7\]\.class/,
    );
  });
});

/** Recursively sorts object keys, mirroring what canonical serialisation should produce. */
function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, sortDeep(record[key])]),
  );
}
