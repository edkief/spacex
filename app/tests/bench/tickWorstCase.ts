/**
 * TASK-60: the worst-case tick benchmark (the deliverable of steps 1-3).
 *
 * Runs the REAL SimLoop (real wall clock, no fake timers) for 120 s on the
 * scripted worst-case shard (tests/bench/worstCase.ts: 16 player conns —
 * 8 in flight firing, 4 on foot mining/walking, 4 idle — + 10 AI ships,
 * a missile volley at t=30 s, 20 ground items + 30 deposits) and reports:
 *
 * - the tick histogram (p50 / p95 / max — the AC budgets: p50 < 15 ms,
 *   p95 < 30 ms, max < 60 ms, sustained > 60 ms = fail);
 * - the effective tick rate (must stay ≥ 15 Hz; the catch-up logic must
 *   never engage for more than 5 consecutive ticks);
 * - the PER-PHASE tick cost table (top-3 hotspots — AC 3);
 * - the shard's heap growth over the run (AC 5: < 20 MB after a final GC).
 *
 * Usage: npm run bench:tick          (120 s, NODE_OPTIONS=--expose-gc)
 *        BENCH_MS=30000 npm run bench:tick   (quick smoke)
 *        BENCH_BASELINE=1 npm run bench:tick (pre-tuning baseline: no
 *                                            dormant AI — the delta is the
 *                                            tuning win, recorded for TASK-61)
 */
import { performance } from 'node:perf_hooks';

import { PROJECTILE_CAP, TICK_DT_MS } from '@server/shard/shard';
import type { TickPhase } from '@server/shard/shard';
import { buildWorstCase, BENCH_SEED } from './worstCase';

const RUN_MS = Number(process.env.BENCH_MS ?? 120_000);
const BASELINE = process.env.BENCH_BASELINE === '1';
const VOLLEY_AT_MS = 30_000; // the scripted missile volley (the AC's t=30 s)

// --- AC budgets -----------------------------------------------------------
const P50_BUDGET_MS = 15;
const P95_BUDGET_MS = 30;
const MAX_BUDGET_MS = 60; // a single GC spike is tolerable if RARE...
const SUSTAINED_MAX_FRACTION = 0.01; // ...> 60 ms on >1% of ticks = fail
const MIN_EFFECTIVE_HZ = 15;
const MAX_CATCHUP_STREAK = 5;
const HEAP_GROWTH_BUDGET_BYTES = 20 * 1024 * 1024;
const WARMUP_MS = Math.min(10_000, RUN_MS / 3); // settle before the heap baseline

type Gc = () => void;
const gc = (globalThis as { gc?: Gc }).gc;

function heap(): number {
  return process.memoryUsage().heapUsed;
}

/** Accumulates the per-phase tick cost table (the AC-3 deliverable). */
function makePhaseAccumulator(): Record<TickPhase, { total: number; max: number; samples: number }> {
  const acc = {} as Record<TickPhase, { total: number; max: number; samples: number }>;
  for (const phase of [
    'sweep',
    'ships',
    'characters',
    'hazards',
    'mining',
    'ai',
    'projectiles',
    'snapshot-build',
    'snapshot-serialize',
    'broadcast-send',
  ]) {
    acc[phase as TickPhase] = { total: 0, max: 0, samples: 0 };
  }
  return acc;
}

async function main(): Promise<void> {
  const phases = makePhaseAccumulator();
  const bench = buildWorstCase({
    phaseProfile: (phase, ms) => {
      const p = phases[phase];
      p.total += ms;
      p.max = Math.max(p.max, ms);
      p.samples += 1;
    },
    dormantAi: !BASELINE,
  });
  const { shard } = bench;

  // --- tick accounting (effective rate + catch-up streaks) ---------------
  let ticks = 0;
  let peakProjectiles = 0;
  let overMaxTicks = 0;
  let lastTickAt = 0;
  let stallStreak = 0;
  let maxStallStreak = 0;
  shard.events.on('tick', (e: { ms: number }) => {
    if (e.ms > MAX_BUDGET_MS) overMaxTicks += 1;
    ticks += 1;
    const nowMs = performance.now();
    if (lastTickAt > 0) {
      // A gap > 1.5 tick periods = the event loop stalled and the
      // accumulator caught up (that is one engaged catch-up burst).
      if (nowMs - lastTickAt > TICK_DT_MS * 1.5) {
        stallStreak += 1;
        maxStallStreak = Math.max(maxStallStreak, stallStreak);
      } else {
        stallStreak = 0;
      }
    }
    lastTickAt = nowMs;
    let projs = 0;
    for (const e of shard.entities.values()) if (e.kind === 'projectile') projs += 1;
    peakProjectiles = Math.max(peakProjectiles, projs);
  });

  const startWall = Date.now();
  let volleyFired = false;
  let frame = 0;
  let heapBaseline = 0;
  let heapWarmed = false;

  shard.sim.start();
  const timer = setInterval(() => {
    bench.sendScript(frame++);
    const t = Date.now() - startWall;
    if (!volleyFired && t >= VOLLEY_AT_MS && RUN_MS > VOLLEY_AT_MS) {
      bench.missileVolley();
      volleyFired = true;
    }
    // Heap baseline after a warm-up (one-time allocations have settled).
    if (!heapWarmed && t >= WARMUP_MS) {
      gc?.();
      heapBaseline = heap();
      heapWarmed = true;
    }
  }, 100);

  await new Promise((r) => setTimeout(r, RUN_MS));
  clearInterval(timer);
  shard.stop();

  // --- memory: final GC + heap diff (AC 5) -------------------------------
  gc?.();
  const heapEnd = heap();
  const heapGrowth = heapEnd - heapBaseline;

  // --- the report ---------------------------------------------------------
  const runSec = RUN_MS / 1000;
  const p50 = shard.histogram.percentile(0.5);
  const p95 = shard.histogram.percentile(0.95);
  const { max } = shard.histogram.range();
  const sustainedOverMax = overMaxTicks / Math.max(1, ticks) > SUSTAINED_MAX_FRACTION;
  const effectiveHz = ticks / runSec;

  const checks: Array<[string, boolean, string]> = [
    [`p50 ${p50.toFixed(2)} ms < ${P50_BUDGET_MS}`, p50 < P50_BUDGET_MS, ''],
    [`p95 ${p95.toFixed(2)} ms < ${P95_BUDGET_MS}`, p95 < P95_BUDGET_MS, ''],
    [
      `max ${max.toFixed(2)} ms (budget < ${MAX_BUDGET_MS} unless rare)`,
      !sustainedOverMax,
      // AC: a single GC spike is tolerable if RARE — sustained > 60 ms
      // (>1% of ticks) is the fail.
      sustainedOverMax
        ? `${overMaxTicks}/${ticks} ticks over budget = sustained (fail)`
        : `${overMaxTicks}/${ticks} ticks over budget (rare spikes tolerated)`,
    ],
    [
      `effective rate ${effectiveHz.toFixed(2)} Hz ≥ ${MIN_EFFECTIVE_HZ}`,
      effectiveHz >= MIN_EFFECTIVE_HZ,
      '',
    ],
    [
      `catch-up streak ${maxStallStreak} ≤ ${MAX_CATCHUP_STREAK}`,
      maxStallStreak <= MAX_CATCHUP_STREAK,
      '',
    ],
  ];
  if (heapWarmed && RUN_MS >= 60_000) {
    const ok = heapGrowth < HEAP_GROWTH_BUDGET_BYTES;
    checks.push([
      `heap growth ${(heapGrowth / 1048576).toFixed(1)} MB < 20 MB (after warm-up + final GC)`,
      ok,
      '',
    ]);
  }
  if (RUN_MS >= VOLLEY_AT_MS + 1000) {
    checks.push([
      `peak in-flight missiles ${peakProjectiles} reached the cap (${PROJECTILE_CAP})`,
      peakProjectiles >= PROJECTILE_CAP,
      'the volley (16 concurrent) engaged the cap',
    ]);
  }

  console.log('');
  console.log(`TASK-60 worst-case tick bench — ${runSec.toFixed(0)} s, seed ${BENCH_SEED}${BASELINE ? '  [BASELINE: dormant AI OFF]' : ''}`);
  console.log(`scene: 16 conns (8 firing / 4 foot / 4 idle) + 10 AI (5 near, 5 far) + 20 ground items + 30 deposits`);
  console.log(`ticks: ${ticks} (${effectiveHz.toFixed(2)} Hz effective) · entities: ${shard.entities.size} · snapshot bytes: ${bench.bytesSent()}`);
  console.log('');
  console.log('tick histogram:');
  console.log(`  p50  = ${p50.toFixed(3)} ms   (budget < ${P50_BUDGET_MS})`);
  console.log(`  p95  = ${p95.toFixed(3)} ms   (budget < ${P95_BUDGET_MS})`);
  console.log(`  max  = ${max.toFixed(3)} ms   (budget < ${MAX_BUDGET_MS}, rare spikes tolerated)`);
  console.log('');
  console.log('per-phase tick cost (summed over the run; top-3 marked):');
  const totalPhaseMs = Object.values(phases).reduce((a, p) => a + p.total, 0);
  const ranked = (Object.entries(phases) as [TickPhase, { total: number; max: number; samples: number }][]).sort(
    (a, b) => b[1].total - a[1].total,
  );
  ranked.forEach(([phase, p], i) => {
    const avgPerTick = ticks > 0 ? (p.total / ticks).toFixed(4) : '0';
    const share = totalPhaseMs > 0 ? ((p.total / totalPhaseMs) * 100).toFixed(1) : '0';
    console.log(
      `  ${i < 3 ? 'TOP ' + (i + 1) : '     '}: ${phase.padEnd(20)} ${p.total.toFixed(1).padStart(10)} ms total · ${avgPerTick} ms/tick · ${share}% · max ${p.max.toFixed(3)}`,
    );
  });
  console.log('');
  console.log('budgets:');
  let allPass = true;
  for (const [label, ok, note] of checks) {
    allPass = allPass && ok;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${note ? `  (${note})` : ''}`);
  }
  console.log('');
  console.log(allPass ? 'TASK-60: ALL BUDGETS GREEN' : 'TASK-60: BUDGET FAILURES — see above');
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
