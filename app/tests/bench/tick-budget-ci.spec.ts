/**
 * TASK-60 step 4: the FAST CI version of the worst-case tick benchmark.
 *
 * Runs the SAME scripted worst-case scene (16 conns / 10 AI / ground items /
 * deposits — tests/bench/worstCase.ts) on the REAL SimLoop for 10 s and
 * asserts only the EFFECTIVE-RATE rule (works on any machine, unlike the
 * absolute ms budgets): the 20 Hz loop must never drop below 15 Hz
 * effective, i.e. ≥ 150 ticks in 10 s, and the catch-up logic must never
 * engage for more than 5 consecutive ticks. The full 120 s run with the ms
 * budgets + per-phase table + heap check is `npm run bench:tick`.
 */
import { describe, expect, it } from 'vitest';

import { TICK_DT_MS } from '@server/shard/shard';
import { buildWorstCase } from './worstCase';

const RUN_MS = 10_000;
/** 20 Hz nominal → 15 Hz floor (the AC's effective-rate rule). */
const MIN_TICKS_10S = 150;
const MAX_CATCHUP_STREAK = 5;

describe('TASK-60 worst-case tick (10 s CI check)', () => {
  it('holds ≥ 15 Hz effective with no > 5-tick catch-up streak', async () => {
    const bench = buildWorstCase();
    const { shard } = bench;

    let ticks = 0;
    let lastTickAt = 0;
    let stallStreak = 0;
    let maxStallStreak = 0;
    shard.events.on('tick', () => {
      ticks += 1;
      const nowMs = performance.now();
      if (lastTickAt > 0 && nowMs - lastTickAt > TICK_DT_MS * 1.5) {
        stallStreak += 1;
        maxStallStreak = Math.max(maxStallStreak, stallStreak);
      } else {
        stallStreak = 0;
      }
      lastTickAt = nowMs;
    });

    const start = Date.now();
    shard.sim.start();
    let frame = 0;
    const timer = setInterval(() => bench.sendScript(frame++), 100);

    await new Promise((r) => setTimeout(r, RUN_MS));
    clearInterval(timer);
    shard.stop();

    const effectiveHz = ticks / (RUN_MS / 1000);
    expect(
      `effective rate ${effectiveHz.toFixed(2)} Hz over ${RUN_MS / 1000}s`,
    ).toBeGreaterThanOrEqual(15);
    expect(ticks).toBeGreaterThanOrEqual(MIN_TICKS_10S);
    expect(
      `catch-up engaged for ${maxStallStreak} consecutive ticks`,
    ).toBeLessThanOrEqual(MAX_CATCHUP_STREAK);
  }, 60_000);
});
