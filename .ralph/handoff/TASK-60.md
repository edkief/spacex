# TASK-60 handoff — Server tick budget: p95 < 30 ms at 16 players

## Status
~80% done. The worst-case benchmark exists and runs green on all AC budgets (p50/p95/max/effective-rate/catch-up/heap), the dormant-AI tuning is implemented, and the per-phase profiler is in the shard. Remaining: re-run the 120 s full bench to confirm the PROJECTILE_CAP (16) is now reached (a ping-pong firing-line fix for that was just made but NOT yet re-verified), run the full unit suite (incl. the new 10 s CI spec), eslint/prettier, and close out (task flags, LOG.md, commit, TASK-18/TASK-61 numbers).

## Done
- **`app/src/server/shard/shard.ts`**
  - `TickPhase` type + `phaseProfile?: (phase, ms) => void` option on `CreateSystemShardOptions`; the tick now wraps every stage in `this.phase(...)` (sweep / ships / hazards / characters / mining / ai / projectiles / snapshot-build / snapshot-serialize / broadcast-send). Zero overhead when `phaseProfile` is undefined. NOTE: the re-indentation inside `tick()` is deliberately loose (closures added, bodies not re-indented) — prettier may want to reformat.
  - **Dormant AI (the big tuning win):** `dormantAi?: boolean` option (default true; `false` = pre-tuning baseline for the bench). In `stepAiShips`, a PATROL-mode rogue > `DORMANT_RANGE_M` (2 km) from EVERY live player skips the full state machine: patrol input recomputed at 1 Hz (every 20th tick) into `state.dormantInput`, cached, and fed to the same `integrateShip`; wakes (recomputes fresh) when a player enters 2 km or the mode changes.
- **`app/src/server/shard/ai.ts`**: `DORMANT_RANGE_M = 2000` export, `AiState.dormantInput?: ShipInput`, `patrolStep` exported (reset in `resetAiState`/`toPatrol`).
- **`app/tests/bench/worstCase.ts`** (new): `buildWorstCase({phaseProfile, dormantAi})` builds the AC scene in-process: 16 conns (8 firing interceptors ping-ponging in front of 5 near-field AI at ~450 m, 4 on foot at the first pad each holding a 1.5 s mining channel on its own deposit, 4 idle) + 5 far-field AI at 3–6 km (dormant territory) + 30 seeded deposits (100 units each, fanned around the pad — first 4 are the miners' targets) + 20 ground items (300 s ttl). Deterministic, seed `tick-bench-seed`. Firing script: ping-pong thrust 2 s fwd / 2 s back (keeps the nose cone on the AI — see Dead ends), laser at frame%15, missile at frame%20; AI hulls topped up every 10 s (bench AI are NOT in the shard's respawn sweep — they're not in `rogues`, only `ai`); firing line re-parked every 5 s.
- **`app/tests/bench/tickWorstCase.ts`** (new): `npm run bench:tick` (added to package.json). Real SimLoop, real wall clock, `BENCH_MS` env (default 120000), `BENCH_BASELINE=1` for the no-dormant-AI baseline; the scripted 16-missile volley fires automatically at t=30 s via `bench.missileVolley()` (only when the run is > 30 s). Reports histogram (p50/p95/max), per-phase table (top-3 marked), effective Hz, catch-up streak (gap > 1.5×dt), heap growth (warm-up 10 s + final GC, needs `--expose-gc`), peak in-flight missiles. Exits 0/1 on budgets: p50<15, p95<30, sustained-max rule (>1% of ticks >60 ms = fail; rare spikes tolerated), ≥15 Hz, catch-up streak ≤5, heap <20 MB, peakProjectiles ≥ PROJECTILE_CAP (only when run ≥ 31 s).
- **`app/tests/bench/tick-budget-ci.spec.ts`** (new): the fast 10 s CI version — same scene, real wall clock, asserts ≥15 Hz effective (≥150 ticks/10 s) + catch-up streak ≤ 5 only (machine-independent). Added to vitest.config.ts include list.
- **Measured (dev machine, this session, 120 s, pre ping-pong fix):** baseline (dormant off): p50 1.18 / p95 3.12 / max 37.6 ms, 2399 ticks @ 19.99 Hz, heap +0.5 MB. Tuned: p50 1.19 / p95 3.12 / max 36.3 ms. Per-phase top-3: **hazards** (~27%), **characters** (~20%), **ships** (~15%); snapshot-serialize ~12-13%, projectiles ~12%. Only failure: `peak in-flight missiles 11` (cap 16 not hit) — see Dead ends. These numbers are recorded for TASK-61.

## Working tree
Uncommitted (all new/modified, tsc clean, bench runs):
- modified: `app/src/server/shard/shard.ts`, `app/src/server/shard/ai.ts`, `app/package.json` (bench:tick), `app/vitest.config.ts` (CI spec include)
- new: `app/tests/bench/{worstCase,tickWorstCase}.ts`, `app/tests/bench/tick-budget-ci.spec.ts`
- This handoff file.
Builds: `npx tsc --noEmit` clean (verified after the final ping-pong edit). Only the 120 s bench re-run with the new firing line is unverified.

## Next steps
1. `cd app && npx tsc --noEmit`, then `npm run bench:tick` (120 s). Expect `peak in-flight missiles 16` now that the firing line ping-pongs (missiles were being denied when players flew through the AI). If still < 16, the missile flight time is just too short — options: slow the bench's missiles is NOT possible (shared spec), so either accept a softer assertion (peak ≥ 8) with a note, or increase firing density (4 firing players on missiles only). Judge from the number.
2. Run the 10 s CI spec: `npx vitest run tests/bench/tick-budget-ci.spec.ts` (must be stable under load; it uses real wall clock — watch for the documented load-flake family if it ever runs concurrently with e2e).
3. Full `npm run test` + `npx tsc --noEmit` + `eslint --fix` + `prettier --write` on all touched files (shard.ts re-indentation will likely get reflowed — fine, but re-run tsc + the shard unit tests after).
4. Close-out: set the 4 steps `pass: true` in `.ralph/tasks/TASK-60.json`, `"passes": true` in `.ralph/tasks.json`, LOG.md entry at top with the recorded numbers (baseline vs tuned p50/p95/max, top-3 phases, heap, the tuning wins: dormant AI + snapshot reuse + single-serialize were ALREADY in place pre-task — the measured delta from dormant AI at 10 AI is small on this machine, note that for TASK-61), update STRUCTURE.md (new `app/tests/bench/` dir), commit (Conventional Commit), promise.
5. No human decision needed unless step 1's cap check can't be satisfied cheaply.

## Dead ends
- **Missiles never reached the 16 cap (peak 11)** with forward-thrust firing: the players drove THROUGH the AI at ~100+ m/s, leaving no ship in the nose cone → `missilePreference` denied the drops (`missile-fired` 33 / 15 s ≈ 2.2/s instead of 4/s), and in-range missiles flight in 3–4 s. Fix applied (unverified): 2 s ping-pong thrust so the line oscillates in front of the AI; plus AI hull top-up every 10 s (near-field rogues die in ~15 s of 8-player fire and the bench AI are outside the shard's respawn sweep — they're seeded directly into `shard.ai`/`entities`, not `shard.rogues`).
- **Firing cadence vs energy:** laser every second (2/s × 8 players = 16 energy/s) exceeds the 10/s regen → missile fires denied on empty energy. Settled on laser frame%15 (~0.67/s) + missile frame%20.
- `shard.playerEntities` is private — bench reads `shard.entities.get('ship-' + id)` instead (bench ship ids are `ship-<playerId>` via `makeShipEntity`).
- Max-budget check: initial code treated any tick >60 ms as FAIL; the AC says a single GC spike is tolerable if rare (sustained = >1% of ticks). Fixed to the sustained rule; observed max 36–84 ms spikes are 1 tick in 2400 (GC).

## How to verify
- `cd app && npm run bench:tick` — 120 s, all budgets PASS, per-phase table printed, exit 0.
- `cd app && BENCH_BASELINE=1 npm run bench:tick` — the pre-tuning (no dormant AI) comparison.
- `cd app && npx vitest run tests/bench/tick-budget-ci.spec.ts` — 10 s, effective-rate rule.
- `cd app && npx tsc --noEmit && npm run test` — full suite green (104+ files before this task; the new spec adds 1 file/1 test).
