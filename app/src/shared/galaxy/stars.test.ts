import { describe, it, expect } from 'vitest';
import { generateStars } from './stars';
import { canonicalize } from './utils';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const GOLDEN_SEED = 'drift-dev-seed-001';

function getChecksum(data: any) {
  const canonical = JSON.stringify(canonicalize(data));
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

describe('Star Generator', () => {
  it('is deterministic', () => {
    const stars1 = generateStars(GOLDEN_SEED);
    const stars2 = generateStars(GOLDEN_SEED);
    expect(stars1).toEqual(stars2);
  });

  it('generates unique names', () => {
    const stars = generateStars(GOLDEN_SEED, 1000);
    const names = new Set(stars.map(s => s.name));
    expect(names.size).toBe(stars.length);
  });

  it('generates unique ids', () => {
    const stars = generateStars(GOLDEN_SEED, 1000);
    const ids = new Set(stars.map(s => s.id));
    expect(ids.size).toBe(stars.length);
  });

  it('matches spectral distribution (approx)', () => {
    const stars = generateStars(GOLDEN_SEED, 10000);
    const counts: Record<string, number> = {};
    stars.forEach(s => {
      counts[s.class] = (counts[s.class] || 0) + 1;
    });

    // O should be very rare, M should be common
    expect(counts['O']).toBeLessThan(counts['M']);
    expect(counts['O']).toBeLessThan(counts['G']);
    expect(counts['M']).toBeGreaterThan(500);
  });

  it('snapshot test', () => {
    const stars = generateStars(GOLDEN_SEED);
    const fixturePath = path.join(__dirname, '__fixtures__/stars-dev-seed.json');
    
    if (!fs.existsSync(fixturePath)) {
      // Generate fixture if it doesn't exist
      const fixture = {
        first25: stars.slice(0, 25),
        totalCount: stars.length,
        checksum: getChecksum(stars)
      };
      
      fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
      fs.writeFileSync(fixturePath, JSON.stringify(fixture, null, 2));
      console.log('Generated golden fixture at', fixturePath);
      // We fail this test once to signal that the fixture was created
      throw new Error('Golden fixture was created. Please run tests again.');
    }

    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
    expect(stars.slice(0, 25)).toEqual(fixture.first25);
    expect(stars.length).toBe(fixture.totalCount);
    expect(getChecksum(stars)).toBe(fixture.checksum);
  });
});
