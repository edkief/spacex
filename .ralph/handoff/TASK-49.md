# TASK-49 handoff — ship destruction → dock respawn → wreck impostor

## Status

Server-side is implemented and unit-tested: killing a player ship now creates a killer-attributed wreck AND immediately respawns the same ship id in place as a fresh starter scout at the nearest dock (cargo LOST, credits + on-foot inventory KEPT), and docked ships are a weapon-invulnerable safe zone. 12 pre-existing tests in 5 files fail because they assumed a destroyed player ship stays frozen; client FX (step 3) and e2e (step 4) have not started.

## Done

- `app/src/server/shard/combat.ts`: `ResolveHitCode` gained `'docked'`; `resolveHit` early-returns `{ ok: false, code: 'docked' }` for a docked target — the single gate covering every fire path (laser/missile/AI funnel through resolveHit → applyHit). NOTE: the low-level `applyHit` deliberately has NO docked gate; a direct `applyHit` on a docked ship still deals damage (this is why the double-destroy test now behaves differently).
- `app/src/server/shard/shard.ts`:
  - `destroyEntity` (~line 1579): after creating the `wreck:<id>` entity (with `killerId`), calls `this.respawnPlayer(entity.playerId)` for player ships.
  - `respawnPlayer` (~line 1622): in-place reset of the SAME entity (wire-stable id) — classId→'scout', hull/shields→1 (normalized), scout default livery, `docked: true`, `pos` = nearest pad (or `homeDockPosition(seed, systemId)` fallback when the system has no landable pad), regime surface/space, cargo cleared (LOST), `inventory` and credits untouched, destroyed state scrubbed, energy full, idle from connection state. Returns `{ pad, shipId }`.
  - `nearestDockPad`: nearest pad by true 3D distance over `this.planetPads`.
  - `persistRespawn`: fire-and-forget `withTransaction` → `tx.respawnShip`; failures log a warn and never wedge the tick.
  - Docked gates added to: `lockableShip`, the AI laser-target candidate loop, the fire-path target + raycast, `validMissileTarget`, and the AI `players` target list — all now skip docked ships.
  - `CreateSystemShardOptions` repo Pick now includes `'respawnShip'`; `SHIP_CLASSES` import added.
- `app/src/server/db/repo.ts`: `Repository.respawnShip` interface + impl — one UPDATE replacing the row: classId 'scout', scout caps, starter livery, full hull/shields, docked, caller-supplied position/rotation/regime/onPad, `cargo '{}'` (LOST), `destroyedAt null`.
- `app/src/server/shard/shard.destruction-respawn.test.ts` (NEW, 6/6 pass): full loop (A kills B → B respawned docked scout at `padsForSystem(SEED, SYSTEM)[0]`, cargo LOST / inventory KEPT, wreck with killerId + ttl, destroyed + kill events), persist (stub `withTransaction`/`respawnShip`), docked ship takes no damage via `handleFire`, docked ship cannot be locked via `handleTargetLock`, wreck 600 s ttl expiry, third observer sees the wreck with killerId on the 10 Hz snapshot. Uses a FAKE `now` closure + `shard.sim.step(fakeNow)` per 50 ms, single overkill `applyHit(id, 1000, source, 'missile')`.

## Working tree

Committed baseline: `53b22f5` (TASK-48.4). Everything TASK-49 is UNCOMMITTED on top:
- modified: `app/src/server/db/repo.ts`, `app/src/server/shard/combat.ts`, `app/src/server/shard/shard.ts`
- new: `app/src/server/shard/shard.destruction-respawn.test.ts`
- new: this handoff (`.ralph/handoff/TASK-49.md`)
- IGNORE: `.ralph/screenshots/*.png` show as modified — pre-existing noise from earlier e2e runs, not this work; do not commit or revert them.

Builds: `npx tsc --noEmit` clean (checked at handoff). New test file green. Full unit suite currently: **12 failed / 1328 passed / 1 skipped** — every failure is a test written before this task that assumed a destroyed player ship stays `destroyed=true` and frozen.

## Next steps

1. Update the 12 stale tests to expect immediate in-place respawn (entity `destroyed=false`, `docked=true`, `classId='scout'`, at the pad/home-dock; the wreck is the thing that lingers at the death spot):
   - `src/server/shard/shard.damage.test.ts` (6): 'a killing hit destroys the ship' (line ~148 `expect(entity.destroyed).toBe(true)` — now falsy), 'the wreck and the frozen ship both ride the 10 Hz snapshot' (~206 — `ship-p1` is now the docked scout, wreck unchanged), 'double-destroy guard' (~226 — a second `applyHit` on the respawned ship now RETURNS a damage object and deals damage; by design, applyHit has no docked gate), 'a destroyed ship stops integrating and ignores inputs' (~260 — `enqueueInput` now returns true and the first input = take-off), 'the wreck expires after its 600 s ttl' (~284 — destroyed flag now falsy; rename the test — respawn already happened), 'bus swap (repair) revives' (~325 — respawn already ran; rework to destroy an `ai-ship` instead, since respawn is player-only, or rewrite assertions).
   - `src/server/shard/shard.combat.test.ts` (2 failures), `src/server/shard/shard.combat.ws.test.ts` (1): same assumption.
   - `src/server/shard/shard.weapons.ws.test.ts` (2): laser test "shields of <id> still 1, want 0.84" times out; missile test "projectileId undefined" — the victim's respawn/dock changed the timeline; re-check each scenario's expected victim state.
   - `src/server/shard/shard.pvp.ws.test.ts` (1): "timeout: A lock on B" at line ~228 — B respawns docked and lockableShip now rejects docked targets; the lock must happen before the kill, or assert the new behavior.
   - Respawn position for the `shard-damage-seed` systems: nearest of `padsForSystem(SEED, system)` (3D distance) or the `homeDockPosition(SEED, systemId)` fallback — probe which the seeded system has before writing position assertions.
   - Re-run per file: `npx vitest run src/server/shard/shard.damage.test.ts` etc.
2. Full unit suite: `cd /workspace/master/app && npx vitest run --exclude 'tests/e2e/**' --exclude 'tests/abuse/**'` (target ≈1341 green).
3. `npx tsc --noEmit` + lint/prettier clean.
4. Step 3 (NOT STARTED): client FX — explosion on death, brief slow-mo, 'SHIP LOST' overlay (the ~2 s presentation moment; the server respawn is immediate and the client just re-renders the same ship id as a scout), killer marker (skull) on the wreck — `wreck.killerId` already rides the wire. Client code under `app/src/client`.
5. Step 4 (NOT STARTED): e2e scripted kill + screenshots to `.ralph/screenshots/TASK-49-*.png`.
6. Close-out: set step pass flags + `passes: true` for TASK-49 in `.ralph/tasks.json`, add `.ralph/LOG.md` entry, update STRUCTURE.md, commit (Conventional Commit), then output `<promise>TASK-49:DONE</promise>`.

## Dead ends

- Ad-hoc probe: writing a scratch script to `/tmp/opencode` and running `npx tsx` on it failed (bash heredoc `Permission denied`, then tsx `Cannot find module`). If you need to probe seeded-system pads/dock positions, do it inside a scratch vitest test under `app/src/` instead.
- Do NOT add the docked gate to `applyHit` to "fix" the double-destroy test — that's the intentional design (gate in `resolveHit` only); fix the test instead.

## How to verify

- `cd /workspace/master/app`
- `npx vitest run src/server/shard/shard.destruction-respawn.test.ts` → 6/6 pass
- `npx vitest run src/server/shard/shard.damage.test.ts src/server/shard/shard.combat.test.ts src/server/shard/shard.combat.ws.test.ts src/server/shard/shard.weapons.ws.test.ts src/server/shard/shard.pvp.ws.test.ts` → the 12 failures to clear
- `npx vitest run --exclude 'tests/e2e/**' --exclude 'tests/abuse/**'` → full suite
- `npx tsc --noEmit` → clean
- eslint/prettier per package scripts (not re-run at handoff).
