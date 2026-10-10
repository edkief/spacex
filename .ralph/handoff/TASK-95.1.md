# TASK-95.1 handoff — Touch loop e2e: warp flake + land leg + legs 6–10

## Status

Warp leg + space legs GREEN (force-click fix holding across runs). The land leg is
re-designed (probe → reseed, committed) and ROOT-CAUSED one level deeper than the
previous handoff: **the e2e ship carries its space-leg velocity into the glide — the
dev-teleport `vel` seed demonstrably does NOT take effect in the live e2e, even though
the exact same server-side sequence (docked ship → `teleportForTesting(pos, vel)` →
zero input) is CLEAN in an isolated SimLoop script** (see Reproduction below — the
isolated 130 m glide docks at 19.9 m with NO VTOL at ~16 s of sim). The remaining
gate is one instrumented run that dumps the server state 400 ms after the teleport
(logs committed in this iteration) to pin where the seed is lost, then legs 6–10.

## Done this iteration

- **`app/tests/e2e/touch-loop.spec.ts`** (committed): the land leg is now
  **probe → reseed** (replacing the fixed 75 m / 15 m retune, which was a bad
  extrapolation — see Diagnosis): glide 1 probes from 130 m and measures the stop
  point `g`; glides 2–3 re-seed at `S = 130 − g` (the trajectory-shift argument:
  starting farther flies the same trajectory shifted, so the stop shifts by ≈ g)
  with VTOL armed at TOUCHDOWN (`dist ≤ 25 m && vel.y === 0 && hSpeed < 30` — the
  unit-test rule, which the old `≤ 15 m / < 8 m alt` rule missed because the ship
  stops ~21 m out before it ever gets inside 15 m). `glideOnce()` logs a 1 Hz
  trajectory (x/alt/speed) + the vtol-at-touchdown wire frames + stop/timeout
  states; `landOnPad` re-measures and re-shifts per glide.
- **New diagnostics (committed)**: `pre-teleport` and `post-teleport` SERVER-state
  dumps inside `glideOnce` (the tap is authoritative — `entityToState` sends
  `e.ship` raw) to catch the space-leg velocity leak at the source.
- **Isolation script** (deleted after use, re-creatable): replicated the exact
  sequence server-side — ship DOCKED at the pad, `teleportForTesting` to
  (pad.x+130, pad.y+50, pad.z) with vel (−90,0,0), zero input — result: NO climb,
  touchdown at 49 m, slow drift, **pad-dock at 19.9 m, t ≈ 15.7 s**, no VTOL.
  Server physics + teleport + pad machine are all CLEAN.
- All prior work stands (warp force-clicks, `__TLIN__` tap, TouchControls in-ship
  VTOL fix, 80/80 touch unit tests, tsc green).

## Diagnosis (the land-leg mystery, updated)

- Run 8 (this iteration, the new probe code): the 130 m probe **climbed** right
  after the teleport (alt 50 → 75.8 m in 1 s — impossible with a seeded
  `vel.y = 0`), then descended as a dead-stick, **overshot the pad** (x = 6 m at
  49 m alt, x = −13 m at 29 m alt) and skimmed terrain to x = −132 m, still
  airborne at the 25 s budget. The +30 u/s of initial `vel.y` matches the
  space-leg exit velocity (thrust ~2.5 s in a nose with a +y component). So the
  glide started with the space-leg velocity, not the seeded (−90, 0, 0).
- The isolated script proves the server applies the seed: `teleportForTesting`
  sets `entity.ship.vel = {...vel}` (shard.ts:2687), the dev route passes `vel`
  (dev.ts:251), the input frames are all zeros (`__TLIN__`), `entityToState`
  broadcasts `e.ship` raw (shard.ts ~4246), and the per-tick integrator only
  writes from `integrateShip` (shard.ts:1896–1893, 1961–1962). Nothing else
  touches `entity.ship.vel` between ticks.
- Open question the post-teleport dump answers: is the server state already
  wrong 400 ms after the teleport (seed lost server-side — then audit the
  route/shard in the live process), or clean (then the anomaly is in the
  frame flow — e.g. the client's non-resynced predictor: the 262 m re-seed's
  "rendered ship never reached" timeout proves the CLIENT predictor does not
  snap to the server teleport, so check the client resync path too).
- The probe → reseed design is correct ONCE the initial state is clean: the
  isolated 130 m glide docks at 19.9 m with no VTOL; with the VTOL-at-touchdown
  switch the settle is faster and more robust.
- Confirmed dead ends (previous handoff) still stand: no facePad, no 60 m drop,
  no 300 m thrust start, fixed start distances (the "travel is constant"
  extrapolation is false — a closer start lands with MORE energy and skids past
  the disc; the corridor terrain is a valley, not flat).

## Working tree

- Committed this iteration: `app/tests/e2e/touch-loop.spec.ts` (probe → reseed +
  pre/post-teleport dumps). Everything else dirty in `git status` is PRE-EXISTING
  (screenshots, `.ralph/prd/PRD.md`, `.ralph/decisions.jsonl`, `.gitignore`,
  `ralph.config.json`, `app/.ralph/`, `app/.trace-tmp/`, untracked TASK-89..92
  specs) — NOT this task's, do not commit. `app/test-results/` = scratch, removable.

## Next steps

1. **One instrumented run** (~8 min, foreground):
   `cd app && npx playwright test touch-loop.spec.ts --config playwright.e2e.config.ts --reporter=line`
   (e2eServer fixture boots its own dev server — NEVER alongside `npm run dev`).
   Read the `pre-teleport` / `post-teleport` dumps:
   - post-teleport `vel.y ≈ +30` → the seed is lost server-side: audit the live
     route/shard path (the isolated script says the code is correct, so look for
     process-level differences: shard instance, entity, double teleport).
   - post-teleport `vel ≈ (−90, 0, 0)` → the climb happens later: the client
     predictor is the suspect (it demonstrably does NOT snap to teleports — the
     262 m re-seed poll timed out); check the client resync on big state jumps.
2. Fix the root cause (spec-side if the leak is a spec artifact — e.g. poll the
   SERVER tap instead of the rendered ship in `teleport()`; product-side only if
   it is a genuine client resync bug — record it, do not silently special-case).
3. Then legs 6–10 run for the FIRST time (exit → mine 1/40u → re-enter → sell
   505 cr) — expect first-touch issues; iterate SPEC-SIDE only (walk bursts,
   timeouts, prompt strings). If a leg reveals a real product bug: stop, record
   it, do not silently special-case around it.
4. Green bar: WHOLE spec in ONE run + `assertClean()` + screenshot
   `.ralph/screenshots/TASK-95-1.png` at the sold/dock state + CAPTURE the
   `[TASK-95] loop wall=…s` line (put it in the commit message).
5. Close: `npx tsc --noEmit` green; one wip commit of only the task's files:
   `wip(TASK-95): touch-loop e2e fully green (warp force-click; land leg =
   <fix>; legs 6-10; loop wall=…s)`; set this task's steps + TASK-95.1 `passes`
   in `.ralph/tasks.json`; LOG entry; delete this handoff in that commit.
   TASK-95.2 (docs + full gate + close-out) comes next.

## How to verify

- `cd app && npx tsc --noEmit` — green at handoff.
- `cd app && npx vitest run src/client/ui/touch/ src/client/input/touch.test.ts`
  — 80/80 green (unchanged this iteration).
- `cd app && npx playwright test touch-loop.spec.ts --config playwright.e2e.config.ts --reporter=line`
  — run 8: warp/space green, land red at the 262 m re-seed teleport poll
  (climb anomaly diagnosed; instrumented run pending).
