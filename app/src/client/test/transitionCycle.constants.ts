/**
 * Public constants for the transition-cycle benchmark (TASK-30).
 *
 * Split out of `transitionCycle.ts` so the driver file stays
 * under the AGENTS.md 300-line cap. Every number here is part
 * of the spec's contract; tests + the bench script import them
 * directly so a future tune lands in one place.
 */

/**
 * The spec's hard budget: every transition phase adds at most 4 ms
 * to the baseline frame time. Used by both the per-frame assertion
 * in `runCycle` and the bench's headline number.
 */
export const TRANSITION_BUDGET_MS = 4;

/**
 * The no-pull ceiling (spec acceptance: "no frame > 100 ms"). A
 * single frame > 100 ms is almost always a GC spike or a chunk
 * stall; the benchmark flags it so the culprit phase is named.
 */
export const NO_PULL_THRESHOLD_MS = 100;

/**
 * Maximum variance across repeated runs the bench accepts (spec:
 * "variance < 20 % — flakiness check in the test itself"). The
 * variance is computed over the per-run worst-delta array.
 */
export const REPEATABILITY_VARIANCE_PCT = 20;

/**
 * Baseline-sample duration (simulated frames). Spec: "Run the scene
 * idle for 3 s to establish baseline p50/p95". At 60 Hz that's 180
 * frames; we sample 200 to leave a small margin.
 */
export const BASELINE_FRAMES = 200;

/**
 * Number of frames each phase runs for. Tuned to be longer than
 * the worst phase (the 600 ms handoff at 60 Hz = 36 frames) so
 * the per-phase worst-delta statistic is stable.
 */
export const PHASE_FRAMES_DEFAULT = 60;

/**
 * Repetitions per measured frame. A single frame costs ~20-40 µs,
 * so one wall-clock sample measures the environment (timer
 * interrupts, scheduler pre-emption, V8 minor GC) as much as the
 * work. Running the frame's work this many times and taking the
 * **minimum** (see `transitionCycle.sampling.ts`) removes the
 * one-sided noise — without it the per-run worst delta — and
 * therefore its variance across runs — was dominated by the host,
 * not by the transition cost (TASK-61 measured 27 % variance
 * against this task's < 20 % budget).
 *
 * 5 repetitions put the best-of-5 minimum close to the true cost
 * at ~5x the per-cycle wall clock; the bench's full cycle runs in
 * ~5 s, the CI fast cycle in well under a second.
 */
export const SAMPLES_PER_FRAME_DEFAULT = 9;

/** Repetitions used by the CI fast-cycle test (`npm run test`),
 *  where the wall-clock budget is 60 s for the whole suite. */
export const SAMPLES_PER_FRAME_FAST = 3;

/**
 * Per-frame wall-clock delta used by the simulated render loop.
 * 1/60 s ≈ 16.67 ms. We pass `dt` to `integrateShip` /
 * `integrateCharacter` so the cycle exercises the real physics
 * integration at 60 Hz.
 */
export const SIM_DT_S = 1 / 60;
