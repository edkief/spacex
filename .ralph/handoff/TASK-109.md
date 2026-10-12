# TASK-109 handoff — server-side stop autopilot

## Status
The shared `stopInput` module and the full shard `stopActive` integration are written, unit-tested, and green: `tsc --noEmit` clean, full suite 1983 passed / 1 skipped (203 files) as of 12:42 UTC. Remaining before done: the shard-level sim test (spec step 5), lint/format, LOG.md entry, `passes: true`, final commit.

## Done
- **`app/src/shared/physics/stop-autopilot.ts`** (NEW) — pure, deterministic `stopInput(state, cls, dt, { regime, heightAt? }) → ShipInput`. Phase logic in that order:
  - (d) stopped (`|vel| ≤ STOP_SPEED_EPS = 0.5` AND space-or-grounded) → `ZERO_INPUT` (byte-identical idle frame);
  - (c) descent (non-space, `hSpeed < DESCENT_SPEED = 5`, altitude > 0.05): PD lift `up = clamp01((GRAVITY + 2·(DESCENT_RATE − vel.y)) / VTOL_LIFT)` with `DESCENT_RATE = −10` (targets a ~10 u/s sink) + aim-and-retro on the horizontal drift only;
  - (b) deceleration: `decelerate()` — turn phase (nose angle ≥ `ALIGN_THRESHOLD_RAD = 0.15`) emits ZERO thrust + normalized yaw/pitch/roll rate demands from `aimDemands` (world axis `forward×target` mapped to local frame; antiparallel fallback axis +Y/+X); aligned → retro `thrust = −scaledRetro(speed, cls.acceleration, dt)` where `scaledRetro = min(1, speed/(accel·dt))`. Space targets the full velocity vector; atmosphere/surface target the HORIZONTAL velocity only.
- **`app/src/shared/physics/stop-autopilot.test.ts`** (NEW) — 8 tests, all passing: space 120 u/s scout stops < 15 s; all three classes stop 120 u/s in < 20 s; atmosphere 30 u/s @ 200 m lands GROUNDED with |vel| < 0.5 in < 30 s; descent sink bounded; at-rest → zero input (grounded + space cases); determinism (deep-equal); no state mutation.
- **`app/src/server/shard/types.ts`** — `stopActive?: boolean` on `SimEntity` with doc comment.
- **`app/src/server/shard/shard.ts`** — import at line 18; in the ships tick phase:
  - engage/cancel on the RAW frame (lines ~1896–1916): `stopTag = action.split('+').includes('stop')`, `hasDemand = thrust|turn|pitch|yaw ≠ 0`; `stopActive && hasDemand` → cancel (log); `!stopActive && stopTag && !hasDemand && !docked` → engage (idempotent; docked is a logged no-op and must not undock);
  - `shipInput = entity.stopActive ? stopInput(entity.ship, shipStats(entity.classId), this.dt, { regime, heightAt: ctx.options.heightAt }) : inputToShipInput(entity.heldInput ?? ZERO_INPUT)` (lines ~1929–1935) — the player frame is consumed for the rule then discarded while active;
  - completion (lines ~1953–1961): after `integrateShip`, if `|vel| < STOP_SPEED_EPS` AND (space OR grounded via `ctx.options.heightAt`) → clear flag, log, `this.events.emit('stop-complete', { id, playerId })`;
  - `stopActive = false` mirrored at all 7 `heldInput`-clear sites: 695 (disconnect), 1615 (destroy), 1741 (respawn), 2739 (teleportForTesting), 2838 (disembark), 2912 (re-enter), 4217 (swap/revive).
- **`app/src/shared/protocol/inputs.ts`** — doc comments on `inputToShipInput` and `shipInputToPayload` noting the `'stop'` action tag is a shard-level command deliberately ignored by the mapping (no functional change).

## Working tree
NOT committed. My files (commit exactly these + the handoff):
- M `app/src/server/shard/shard.ts`
- M `app/src/server/shard/types.ts`
- M `app/src/shared/protocol/inputs.ts`
- ?? `app/src/shared/physics/stop-autopilot.ts`
- ?? `app/src/shared/physics/stop-autopilot.test.ts`
- ?? `.ralph/handoff/TASK-109.md` (this file)

Do NOT commit the other dirty files (screenshots, `.ralph/tasks/TASK-*.json`, `.agents/`, `.pi/`, `ralph.config.json`, `.gitignore`, etc.) — they belong to the harness/previous sessions. `.ralph/tasks.json` is tracked and untouched (TASK-109 `passes` still false).
Builds: `npx tsc --noEmit` clean; `npx vitest run` full suite green (203 files, 1983 passed, 1 skipped). Lint/prettier NOT yet run.

## Next steps
1. **Write `app/src/server/shard/shard.stop.test.ts`** (spec step 5, the only big missing piece). Harness: copy `shard.hover.test.ts` / `shard.regime.test.ts` (stub repo/bus/log, `new SystemShard(...)`, `shard.addEntity(...)`, `shard.registerConnection(...)`, then per tick `shard.enqueueInput(connId, frame)` + `shard.sim.step()`). Cases:
   - (a) space, vel ~100 u/s → enqueue one pure stop frame `{ action: 'stop', seq, ...zeros }` → entity `stopActive === true`; within < 20 s a `'stop-complete'` event fires and `|vel| < 0.5` (listen on `shard.events`);
   - (b) atmosphere 30 u/s @ 200 m → within < 30 s regime becomes `'surface'`, grounded, `|vel| < 0.5`;
   - (c) cancel: engage, then a frame with `thrust: 1` → `stopActive` clears and the ship follows player demand again;
   - (d) docked ship + pure stop frame → stays docked, `stopActive` never set;
   - (e) `stopActive` cleared by `teleportForTesting` / disembark (stale-flag guard).
   - InputPayload field names: check `app/src/shared/protocol/inputs.ts` (the engage/cancel rule reads `input.thrust`, `input.turn`, `input.pitch`, `input.yaw`, `input.action`, `input.seq`).
2. Lint/format: `cd /workspace/master/app && npx eslint --fix <my 6 files> && npx prettier --write <my 6 files>` (shard.ts, types.ts, shard.stop.test.ts, stop-autopilot.ts, stop-autopilot.test.ts, inputs.ts), then `npx tsc --noEmit` + full `npx vitest run`.
3. Bookkeeping: set TASK-109 `"passes": true` in `.ralph/tasks.json`; append a LOG.md entry (match the format of recent entries in `.ralph/LOG.md`).
4. Commit my 6–7 files: `feat(TASK-109): server-side stop autopilot (shared stopInput + stopActive shard integration)`.
5. Output `<promise>TASK-109:DONE</promise>`.

## Dead ends
All were controller stability bugs in the shared module (the shard integration never misbehaved):
1. **Retro thrust during the turn phase** → limit cycle: with the nose >10° off the velocity, a retro thrust pushes SIDEWAYS and rotates the velocity direction at `thrust·accel/speed` rad/s (e.g. 40/30 ≈ 1.33) — faster than the class turnRate (0.8), so the nose stays exactly 90° behind and the ship circles at constant speed forever (probe showed ~33.5 u/s circling on the ground). Fix: turn phase emits zero thrust; retro only once angle < 0.15 rad.
2. **Full retro near zero** → overshoot: full thrust removes `accel·dt` of speed per tick, which near the stop flips the velocity 180°, re-aims, and oscillates around `STOP_SPEED_EPS` (probe: 0.9–1.1 u/s forever). Fix: `scaledRetro = min(1, speed/(accel·dt))`.
3. **Full-3D velocity target in atmosphere** → flap: the nose aims at the gravity-bent (downward) velocity, so −forward pushes UP against the fall; ship flapped 160–210 m altitude, 2–9 u/s, never descended. Fix: atmosphere/surface target the HORIZONTAL velocity only in the decel phase; the descent phase owns the vertical axis.
4. **Descent gate on total speed** → same flap at the gate boundary (a falling ship's vertical component pushed it back over 5 u/s). Fix: gate on `hSpeed` only.
5. **`DESCENT_RATE = −2` (the spec sketch)** → too slow: the last ~170 m at 2 u/s takes ~90 s, breaking the < 30 s AC. Fix: `DESCENT_RATE = −10` (the spec names the stop TIMING, not the sink rate, as the acceptance criterion; lift is still bounded by VTOL_LIFT so it stays a controlled descent).
6. **Antiparallel aim**: `forward × target = 0` with the nose exactly 180° off → zero rotation axis → zero demands → the ship never turns. Fix: fallback perpendicular axis (world +Y, or +X when the nose is vertical) in `aimDemands`.

## How to verify
- `cd /workspace/master/app && npx tsc --noEmit` — expect no output (clean).
- `npx vitest run src/shared/physics/stop-autopilot.test.ts` — 8/8 pass.
- `npx vitest run` — full suite green (was 203 files / 1983 passed / 1 skipped at handoff; expect +1 file / more tests after step 1).
- After step 1: `npx vitest run src/server/shard/shard.stop.test.ts`.
- Lint: `npx eslint src/server/shard/shard.ts src/server/shard/types.ts src/shared/physics/stop-autopilot.ts src/shared/physics/stop-autopilot.test.ts src/shared/protocol/inputs.ts` and `npx prettier --check` on the same set.
- Bookkeeping: grep `"TASK-109"` in `.ralph/tasks.json` for `"passes": true`; new entry in `.ralph/LOG.md`; one `feat(TASK-109)` commit containing exactly the working-tree file list above.
