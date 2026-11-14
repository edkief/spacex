import { describe, expect, it } from 'vitest';
import { firstPlanet } from '@tests/support/galaxy.ts';
import { generateStars } from '@shared/galaxy/stars.ts';
import { generateSurfaceChunk } from '@shared/galaxy/surface.ts';
import { generateSystemForStar } from '@shared/galaxy/system.ts';

/** Median wall time in ms of `fn` over `runs` runs after a warm-up (loose perf sanity only). */
function medianMs(fn: () => unknown, runs = 15): number {
  fn();
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    fn();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(runs / 2)] as number;
}

describe('generation performance (loose bounds; measured values are printed)', () => {
  it('generates 200 stars well under 10 ms', () => {
    const ms = medianMs(() => generateStars('drift-dev-seed-001'));
    console.log(`generateStars(200): median ${ms.toFixed(3)} ms`);
    expect(ms).toBeLessThan(10);
  });

  it('generates a system well under 10 ms', () => {
    const star = generateStars('drift-dev-seed-001')[1]!;
    const ms = medianMs(() => generateSystemForStar('drift-dev-seed-001', star));
    console.log(`generateSystemForStar: median ${ms.toFixed(3)} ms`);
    expect(ms).toBeLessThan(10);
  });

  it('generates a surface chunk well under 10 ms', () => {
    const { planet } = firstPlanet('drift-dev-seed-001', (p) => p.landable);
    let n = 0;
    const ms = medianMs(() => generateSurfaceChunk('drift-dev-seed-001', planet, n++, 7));
    console.log(`generateSurfaceChunk: median ${ms.toFixed(3)} ms`);
    expect(ms).toBeLessThan(10);
  });
});
