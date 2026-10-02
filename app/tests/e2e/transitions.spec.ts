import { expect, test } from './fixtures';
import { collectErrors, uniqueCallsign } from './helpers';
import { ClaimPage } from './pages/claim';

/**
 * TASK-30 e2e (happy path): the dev-only `window.__TRANSITION__` hook on
 * the live page (TASK-70 harness). Claim → the hook exists (dev build) →
 * `runCycle()` runs the full scripted transition cycle ON THE PAGE's main
 * thread against the real pipeline components → the report comes back
 * green (0 budget warnings, no frame > 100 ms, pre-gen ring ready) and
 * `lastReport` points at it. Screenshot: TASK-30-1.png.
 *
 * The hook's types live in app/src/client/test/transitionCycle.ts, which
 * this runner must not import (tsconfig aliases are not resolved by
 * Playwright) — the surface is cast locally.
 */
interface PhaseRow {
  transition: string;
  worstDeltaP99Ms: number;
  budgetWarnings: number;
}

interface CycleReportRow {
  totalFrames: number;
  budgetWarnings: number;
  maxFrameMs: number;
  worstDeltaP99Ms: number;
  padNearRingReadyAtArrival: boolean;
  padNearRingFramesBeforeArrival: number;
  phases: PhaseRow[];
  control: { p50Ms: number; p95Ms: number; busyP50Ms: number; frames: number };
}

test('transition hook: window.__TRANSITION__.runCycle() is green in the page', async ({
  browser,
  e2eServer,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const { assertClean } = collectErrors(page);
  const claim = new ClaimPage(page, e2eServer.baseURL);

  await claim.claim(uniqueCallsign('trans'));
  await page.waitForLoadState('networkidle');

  // The hook is installed by main.tsx at load (dev build only).
  const installed = await page.evaluate(
    () => typeof (window as any).__TRANSITION__?.runCycle === 'function',
  );
  expect(installed).toBe(true);
  expect(await page.evaluate(() => (window as any).__TRANSITION__?.lastReport === null)).toBe(true);

  // Run the full cycle 3x on the page's main thread (blocking, a few
  // seconds each) and take the median run — the same measurement hygiene
  // as the bench script (the page's main thread is busier than headless
  // Node, so a single-frame GC spike must not sink the verdict).
  const reports: CycleReportRow[] = await page.evaluate(async () => {
    const api = (window as any).__TRANSITION__ as {
      runCycle: () => Promise<{
        totalFrames: number;
        budgetWarnings: number;
        maxFrameMs: number;
        worstDeltaP99Ms: number;
        padNearRingReadyAtArrival: boolean;
        padNearRingFramesBeforeArrival: number;
        phases: { transition: string; worstDeltaP99Ms: number; budgetWarnings: number }[];
        streamingControl: { p50Ms: number; p95Ms: number; busyP50Ms: number; frames: number };
      }>;
    };
    const rows = [] as {
      totalFrames: number;
      budgetWarnings: number;
      maxFrameMs: number;
      worstDeltaP99Ms: number;
      padNearRingReadyAtArrival: boolean;
      padNearRingFramesBeforeArrival: number;
      phases: { transition: string; worstDeltaP99Ms: number; budgetWarnings: number }[];
      control: { p50Ms: number; p95Ms: number; busyP50Ms: number; frames: number };
    }[];
    for (let i = 0; i < 3; i++) {
      const r = await api.runCycle();
      rows.push({
        totalFrames: r.totalFrames,
        budgetWarnings: r.budgetWarnings,
        maxFrameMs: r.maxFrameMs,
        worstDeltaP99Ms: r.worstDeltaP99Ms,
        padNearRingReadyAtArrival: r.padNearRingReadyAtArrival,
        padNearRingFramesBeforeArrival: r.padNearRingFramesBeforeArrival,
        phases: r.phases.map((p) => ({
          transition: p.transition,
          worstDeltaP99Ms: p.worstDeltaP99Ms,
          budgetWarnings: p.budgetWarnings,
        })),
        control: r.streamingControl,
      });
    }
    rows.sort((a, b) => a.worstDeltaP99Ms - b.worstDeltaP99Ms);
    return rows;
  });

  // Every run: the no-pull check and the pre-generation ring.
  expect(reports).toHaveLength(3);
  for (const r of reports) {
    expect(r.totalFrames).toBeGreaterThan(0);
    expect(r.maxFrameMs).toBeLessThan(100);
    expect(r.padNearRingReadyAtArrival).toBe(true);
    expect(r.padNearRingFramesBeforeArrival).toBeGreaterThan(0);
  }

  // Median run: fully green against the budget.
  const report = reports[1];
  expect(report.budgetWarnings).toBe(0);
  expect(report.worstDeltaP99Ms).toBeLessThan(4);
  expect(report.phases).toHaveLength(7);
  for (const phase of report.phases) {
    expect(phase.budgetWarnings).toBe(0);
    expect(phase.worstDeltaP99Ms).toBeLessThan(4);
  }
  expect(report.control.busyP50Ms).toBeGreaterThan(0);

  // lastReport is the run that just finished.
  expect(await page.evaluate(() => (window as any).__TRANSITION__!.lastReport !== null)).toBe(true);

  await page.screenshot({ path: '../.ralph/screenshots/TASK-30-1.png' });
  assertClean();
});
