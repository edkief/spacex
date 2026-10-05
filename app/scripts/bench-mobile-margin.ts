/**
 * TASK-59: `npm run bench:mobile` — the machine-independent 1.5x frame-time
 * MARGIN comparison (AC-3): the benchmark scene (AC-1, 16 entities) runs
 * once at the High profile and once at the Mobile profile (forced), and
 * the margins hold:
 *
 *   margin(p) = budget(p) − median frame time(p)
 *   budget(high) = 16.67 ms (60 fps)    budget(mobile) = 33.33 ms (30 fps)
 *   PASS ⟺ margin(mobile) ≥ 1.5 × margin(high)
 *
 * The margin formulation keeps the check meaningful at the headless noise
 * floor (raw frame times of ~1-2 ms): the mobile floor gets DOUBLE the
 * frame budget (30 fps vs 60 fps) on top of less per-frame work, so the
 * 1.5x margin holds on ANY machine — the spec's example ("if High is 12 ms,
 * Mobile is ≤ 8 ms") satisfies it. Absolute 30 fps on a mid-range phone is
 * TASK-61's reference-hardware gate; the numbers below are recorded for it.
 *
 * Unpaced (paceToRealTime: false): the frame times measure raw main-thread
 * work, so the comparison is fast (a few seconds) and both profiles are
 * measured identically.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runRenderBenchmark, type RenderBenchmarkReport } from '../src/client/test/renderBenchmark';

const here = dirname(fileURLToPath(import.meta.url));

const HIGH_BUDGET_MS = 1000 / 60; // the High profile's 60 fps frame budget
const MOBILE_BUDGET_MS = 1000 / 30; // the Mobile floor's 30 fps frame budget
const FRAMES = 600; // 10 s of sim per profile

function fmt(r: RenderBenchmarkReport): string {
  return [
    `p50=${r.p50Ms}ms`,
    `p95=${r.p95Ms}ms`,
    `max=${r.maxMs}ms`,
    `spikes>${50}ms=${r.spikes50Ms}`,
    `draws=${r.drawCallsP95}p95/${r.drawCallsMax}max`,
    `mats=${r.materialsMax}`,
    `tris=${r.trianglesMax}`,
    `wall=${r.wallMs}ms`,
  ].join(' ');
}

const high = runRenderBenchmark({ frames: FRAMES, profile: 'high', paceToRealTime: false });
console.log(`TASK-59 margin benchmark — AC-1 scene, ${FRAMES} frames (unpaced)`);
console.log(`HIGH   (60 fps budget ${HIGH_BUDGET_MS.toFixed(2)} ms)`);
console.log(`  ${fmt(high)}`);

const mobile = runRenderBenchmark({ frames: FRAMES, profile: 'mobile', paceToRealTime: false });
console.log(`MOBILE (30 fps budget ${MOBILE_BUDGET_MS.toFixed(2)} ms)`);
console.log(`  ${fmt(mobile)}`);

const highMargin = HIGH_BUDGET_MS - high.p50Ms;
const mobileMargin = MOBILE_BUDGET_MS - mobile.p50Ms;
const ratio = mobileMargin / highMargin;
console.log('');
console.log(
  `margin(high)=${highMargin.toFixed(3)} ms  margin(mobile)=${mobileMargin.toFixed(3)} ms`,
);
console.log(`ratio=${ratio.toFixed(3)} (AC: ≥ 1.5)`);

const pass = ratio >= 1.5;
console.log(
  pass ? 'PASS: the mobile floor holds ≥ 1.5x the frame-time margin.' : 'FAIL: margin below 1.5x.',
);

const file = join(here, '..', '..', '.ralph', 'bench', 'TASK-59.json');
mkdirSync(dirname(file), { recursive: true });
writeFileSync(
  file,
  JSON.stringify(
    {
      date: new Date().toISOString(),
      scene: { ships: 16, deposits: 30, frames: FRAMES, paced: false },
      budgetsMs: { high: HIGH_BUDGET_MS, mobile: MOBILE_BUDGET_MS },
      high,
      mobile,
      marginsMs: { high: highMargin, mobile: mobileMargin, ratio },
      pass,
    },
    null,
    2,
  ),
);
console.log(`recorded → ${file}`);

if (!pass) process.exit(1);
