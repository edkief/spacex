# TASK-61 handoff (2026-10-05, iteration 8 — ran out of time)

## Status
The verification RAN and is recorded: all four desktop benchmarks measured
on the reference-class dev machine (Intel N100 / 16 GB headless VM, git
`7b55e82`), the report is committed at `app/docs/performance.md`, and the
repeatable `npm run perf:report <desktop|phone>` runner is committed. ONE
desktop gate is a genuine FAIL — the transitions benchmark (TASK-30) misses
its 4 ms per-phase p99 budget at 15–26 ms, reproduced in three independent
runs (suite run, isolated bench re-run, isolated unit-test re-run). Per the
spec the fix goes back to the owner: **TASK-30.1 is re-opened
(`passes: false` in `.ralph/tasks.json`)**. TASK-61's `passes` stays false
until that is green and a fresh `perf:report desktop` shows transitions
PASS.

## Done
- `app/scripts/perf-report.mjs` + package.json script
  `perf:report` — runs bench:transitions, bench:render, bench:tick,
  load:smoke sequentially; writes per-benchmark `<key>.txt` +
  `summary.json` (device, git sha, exit codes) to
  `.ralph/perf/<device>-<timestamp>/`. Phone path: checks `adb devices` +
  CDP on 127.0.0.1:9222; with no phone it writes `BLOCKED.md` (exact
  commands) and exits 2 — that path is exercised and committed at
  `.ralph/perf/phone-2026-10-05T18-26-45-895Z/`. NOTE: the phone branch is
  UNTESTED end-to-end (no device); the `PERF_PROFILE=mobile` env it passes
  is not read by bench-render.ts yet (it hard-codes High + the baseline
  always runs High) — wire it up when a phone becomes available.
- `app/docs/performance.md` — full report: reference-hardware table
  (N100 named as closest-below-class, no silent substitution), benchmark ×
  metric × budget × measured × pass/fail table, SC verdicts (SC-1 PASS,
  SC-3 PASS, SC-4 desktop PASS / mobile UNVERIFIED, SC-5 FAIL), machine-
  state context, FAIL register, phone BLOCKED section with commands.
- Desktop suite run committed as artifacts:
  `.ralph/perf/desktop-2026-10-05T18-26-50-618Z/` — tick ALL GREEN
  (p50 1.26 / p95 3.20 / max 35.98 ms, 19.99 Hz), load:smoke GREEN
  (min 9.97 Hz, cap probe ok), render GREEN (0 frames > 50 ms, p95
  1.58–1.96 ms; suite-run AC-6 spread 21.1 % was a flake), transitions
  RED (worst-p99 medians 16.83–21.84 ms, budget 4 ms).
- Isolated transitions re-run: same 15–26 ms p99 deltas (medions
  18.30/19.69/18.92/22.37/18.49) → reproducible FAIL, not suite noise.
  Isolated render re-run: PASS (spread 16.9 %) → the flake cleared.
- `.ralph/bench/TASK-58.json` was overwritten by the render re-run with
  the fresh passing record (pass: true) — committed.
- `.ralph/tasks/TASK-61.json` step flags all true (steps executed);
  `.ralph/tasks.json`: TASK-61 `passes: false` (kept), TASK-30.1
  re-opened with a `reopened` note.
- Full unit suite run: 1634 passed / 1–2 failed / 1 skipped — the reds are
  `transitionCycle.test.ts` p99 (the CI twin of the failing bench — same
  4 ms gate, red in isolation too, so it is the pre-existing owner
  failure, NOT a regression from this task: this task touched no client or
  test code) and `combat-hud.test.tsx` hud-budget (flakes under load;
  green 18/18 in isolation).

## Working tree
- All of the above is committed (see `git log --oneline -3`, wip commit).
- Untracked, intentionally left: `.ralph/split/TASK-18/` (pre-existing
  from the TASK-18 close-out, not mine — do not delete).
- Builds: `npm run typecheck` not re-run this iteration (no TS changes);
  eslint/prettier not run on `perf-report.mjs`/`performance.md` — do it on
  pickup (fast).

## Next steps
1. After TASK-30.1 lands green: `cd app && npm run perf:report desktop`
   (~10 min). Expect transitions PASS (if the machine is quiet).
2. From the fresh `.ralph/perf/desktop-<timestamp>/` artifacts, edit
   `app/docs/performance.md` in place: the transitions row (measured +
   PASS), the SC-5 verdict, and the FAIL register (drop the TASK-30 row).
   Re-verify `transitionCycle.test.ts` is green in the full suite.
3. Flip `passes: true` for TASK-61 and TASK-30.1 in `.ralph/tasks.json`,
   remove this handoff, add the LOG.md entry (newest at top), commit.
4. Phone half (SC-4 mobile) stays BLOCKED-PENDING-DEVICE until a device is
   reachable — commands are in the report +
   `.ralph/perf/phone-.../BLOCKED.md`. When one is: wire
   `PERF_PROFILE=mobile` through `app/scripts/bench-render.ts` (baseline
   High, tuned Mobile per the spec's reduced scene), run
   `npm run perf:report phone`, fill the phone table, then SC-4 is
   verified.

## Dead ends
- Waiting for the VM to quiet down: a concurrent agent session (claude.exe
  + opencode/ralph daemons) shares the 4 N100 cores and the VM idles at
  42 % CPU scaling (throttled) — the transitions bench is wall-clock and
  cannot hold 4 ms here right now; re-running it bought nothing.
- Did NOT fix the transitions budget inside TASK-61 — the spec forbids it
  ("measurement + reporting, not fixing: the fix goes back to the owner").
- Did NOT fabricate a phone PASS — no adb, no CDP port, so it is BLOCKED.

## How to verify
- `cd app && npm run perf:report desktop` — compare the four exit codes to
  the table in `app/docs/performance.md`.
- `cat .ralph/perf/desktop-2026-10-05T18-26-50-618Z/summary.json` —
  recorded exit codes (transitions 1, render 1, tick 0, load-smoke 0).
- `npx vitest run src/client/test/transitionCycle.test.ts` — currently
  RED (owner TASK-30.1); must be green before TASK-61 closes.
- `git show --stat HEAD` — wip commit: perf-report.mjs, performance.md,
  perf artifacts, TASK-58.json refresh, tasks.json re-open, handoff.
