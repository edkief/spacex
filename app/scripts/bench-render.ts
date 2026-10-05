/**
 * TASK-58: `npm run bench:render` — the committed 60 s render benchmark.
 *
 * Runs the AC-1 scene (16 ships in combat over the streaming surface)
 * ONCE untuned (the pre-tuning baseline) and FIVE times tuned, then:
 *   - prints the per-run table (the numbers recorded for TASK-61);
 *   - fails (exit 1) when the no-spike rule breaks in ANY tuned run
 *     (a frame > 50 ms), when the draw / material / triangle budgets
 *     break, or when the 5 tuned runs' p95 varies by ≥ 20 % (AC-6:
 *     the benchmark must be repeatable);
 *   - reports the p95 delta vs the baseline (AC-2's ≥ 30 % target).
 *
 * Headless (no WebGL — the scene-graph tally stands in for renderer.info,
 * the same proxy the transitionCycle harness uses); the numbers are a
 * machine-dependent proxy: the DELTA is the machine-independent contract.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BENCH_DEFAULT_FRAMES,
  BENCH_SPIKE_MS,
  runRenderBenchmark,
  type RenderBenchmarkReport,
} from '../src/client/test/renderBenchmark';
import { PERF_PROFILES } from '../src/shared/perf';

const here = dirname(fileURLToPath(import.meta.url));

function fmt(r: RenderBenchmarkReport): string {
  return [
    `p50=${r.p50Ms}ms`,
    `p95=${r.p95Ms}ms`,
    `max=${r.maxMs}ms`,
    `spikes>${BENCH_SPIKE_MS}ms=${r.spikes50Ms}`,
    `draws=${r.drawCallsP95}p95/${r.drawCallsMax}max`,
    `mats=${r.materialsMax}`,
    `tris=${r.trianglesMax}`,
    `fx(flash=${r.maxLaserFlashes},sets=${r.maxDebrisSets},missiles=${r.maxMissiles})`,
    `wall=${r.wallMs}ms`,
  ].join(' ');
}

function main(): void {
  const budgets = PERF_PROFILES.high.budgets;
  const out: string[] = [];
  const log = (s: string): void => {
    console.log(s);
    out.push(s);
  };

  log(`TASK-58 render benchmark — AC-1 scene, ${BENCH_DEFAULT_FRAMES} frames (60 s @ 60 Hz), High preset`);

  const baseline = runRenderBenchmark({ tuned: false });
  log(`\nBASELINE (pre-tuning: legacy 7-mesh ships, per-rock ore, uncapped FX)`);
  log(`  ${fmt(baseline)}`);

  const tunedRuns: RenderBenchmarkReport[] = [];
  for (let i = 1; i <= 5; i++) {
    const r = runRenderBenchmark({ tuned: true });
    tunedRuns.push(r);
    log(`\nTUNED run ${i}/5`);
    log(`  ${fmt(r)}`);
  }

  // ---- AC-6: repeatability — 5 tuned runs, p95 variance < 20 % ----
  const p95s = tunedRuns.map((r) => r.p95Ms);
  const p95Mean = p95s.reduce((a, b) => a + b, 0) / p95s.length;
  const p95Spread = (Math.max(...p95s) - Math.min(...p95s)) / p95Mean;
  log(`\np95 across 5 tuned runs: [${p95s.join(', ')}] ms — spread ${
    (p95Spread * 100).toFixed(1)
  } % (budget < 20 %)`);

  const best = tunedRuns.reduce((a, b) => (b.p95Ms < a.p95Ms ? b : a));
  const worst = tunedRuns.reduce((a, b) => (b.maxMs > a.maxMs ? b : a));
  const deltaP95 = (baseline.p95Ms - best.p95Ms) / baseline.p95Ms;
  const deltaMax = (baseline.maxMs - worst.maxMs) / baseline.maxMs;
  log(`\nDELTA vs baseline (AC-2: ≥ 30 % worst-case frame-time reduction)`);
  log(`  p95:  ${baseline.p95Ms} ms → ${best.p95Ms} ms  (${(deltaP95 * 100).toFixed(1)} % reduction)`);
  log(`  max:  ${baseline.maxMs} ms → ${worst.maxMs} ms  (${(deltaMax * 100).toFixed(1)} % reduction)`);
  log(`  draws p95: ${baseline.drawCallsP95} → ${best.drawCallsP95} (AC-3: < ${budgets.drawCalls})`);
  log(`  materials: ${baseline.materialsMax} → ${best.materialsMax} (AC-3: < ${budgets.materials})`);
  log(`  triangles: ${baseline.trianglesMax} → ${best.trianglesMax} (AC-4: < ${budgets.triangles})`);

  const failures: string[] = [];
  tunedRuns.forEach((r, i) => {
    if (r.spikes50Ms > 0) failures.push(`tuned run ${i + 1}: ${r.spikes50Ms} frames > ${BENCH_SPIKE_MS} ms (no-spike rule)`);
    if (r.drawCallsMax >= budgets.drawCalls) failures.push(`tuned run ${i + 1}: draw calls ${r.drawCallsMax} ≥ ${budgets.drawCalls}`);
    if (r.materialsMax >= budgets.materials) failures.push(`tuned run ${i + 1}: materials ${r.materialsMax} ≥ ${budgets.materials}`);
    if (r.trianglesMax >= budgets.triangles) failures.push(`tuned run ${i + 1}: triangles ${r.trianglesMax} ≥ ${budgets.triangles}`);
  });
  if (p95Spread >= 0.2) failures.push(`p95 spread ${(p95Spread * 100).toFixed(1)} % ≥ 20 % (AC-6 repeatability)`);

  log('');
  if (failures.length > 0) {
    log(`FAIL:`);
    for (const f of failures) log(`  - ${f}`);
  } else {
    log('PASS: no-spike rule + draw/material/triangle budgets + repeatability all hold.');
  }

  // Record the numbers for TASK-61 (committed with the run).
  const data = {
    date: new Date().toISOString(),
    scene: {
      ships: 16,
      chunks: 13,
      deposits: 30,
      labels: 20,
      frames: BENCH_DEFAULT_FRAMES,
      preset: 'high',
    },
    baseline,
    tunedRuns,
    p95: { spread: p95Spread, mean: p95Mean },
    delta: { p95: deltaP95, max: deltaMax },
    pass: failures.length === 0,
  };
  const file = join(here, '..', '..', '.ralph', 'bench', 'TASK-58.json');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2));
  log(`\nrecorded → ${file}`);

  if (failures.length > 0) process.exit(1);
}

main();
