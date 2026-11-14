import { describe, expect, it } from 'vitest';
import { generateStars } from '@shared/galaxy/stars.ts';

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
});
