# Handoff: TASK-48 — Surface hazards with damage and respawn

## Status

Server hazard slice is committed and 3/4 shard integration tests are green. The remaining failure is
ONE drone-aggro test that fails because drones hover at the CELL-CENTER ground height while the
test teleports the player to the drone's ORBIT point where the local terrain is ~92 m higher, so
the 3D distance exceeds the 80 m aggro radius and the drone never fires. A fix was identified and
diagnosed this session but NOT committed (an attempted fix caused a slow-crawl "hang" and was
reverted). Client (step 3) + e2e (step 4) are untouched. Spec: `.ralph/tasks/TASK-48.json`.

## Done

### Committed & green
- `app/src/shared/world/hazards.ts` + `hazards.test.ts` (19 unit tests) — placement + pure exposure
  math. Baseline, committed at 45d0204.
- Server slice committed at 267103f (wip): `shard.ts` exposure/drones, `types.ts` `kind:'drone'`,
  `schemas.ts` drone + `hazard` frame, `damage.ts` drone source. tsc GREEN.

### This session — committed now (see Working tree)
- `app/src/server/shard/shard.hazards.test.ts` — fixed TWO real test bugs:
  1. `droneIds.length` was compared to `cell.droneCount`, but `shard.drones` holds drones for ALL
     drone cells on the planet (cell hz:1=4 + cell hz:3=3 = 7) while `cell` is only the first
     ('drones') hazard (4). Fixed: filter `[...shard.drones.keys()].filter(id =>
     id.startsWith(\`drone:${cell.hazardId}:\`))`. NOTE the field is `hazardId`, NOT `id`
     (`cell.id` is undefined → prefix `drone:undefined:` matched nothing).
  2. `drone.destroyed` is `undefined` (not `false`) before a drone is hit — changed
     `expect(drone.destroyed).toBe(false)` → `.toBeFalsy()`.
- After these fixes: `shard.hazards.test.ts` = 3 passed | 1 failed (the aggro test), runs in ~1.3 s.

## Working tree

- Committed baseline: 267103f (server hazard slice), 45d0204 (shared module).
- Committed this session: `app/src/server/shard/shard.hazards.test.ts` (the two test fixes) + this
  handoff file. Commit `wip(TASK-48): ...`.
- `app/src/server/shard/shard.ts` is at HEAD (267103f) — all of this session's shard edits were
  REVERTED (an attempted patrol fix + debug instrumentation). Do not assume the patrol fix is in.
- `npx tsc --noEmit` GREEN. `npx vitest run src/server/shard/shard.hazards.test.ts` = 3 pass / 1 fail.
- Pre-existing dirty (NOT this task's — leave alone): many `.ralph/screenshots/*.png` mods, untracked
  `.ralph/split/TASK-46/`.

## Next steps

1. FIX the drone hover so aggro works (the only remaining shard failure):
   - Symptom: test `aggros the on-foot player, fires every 2 s ...` fails
     `expected 0 to be greater than or equal to 2` on `expect(myHits.length).toBeGreaterThanOrEqual(2)`.
     The character is telepressed to `d0.ship.pos` (the drone's orbit point) and clamps to local
     ground y≈260; the drone hovers at `drone.cell.y + DRONE_HOVER_M` (cell-CENTER ground y≈166),
     so 3D distance ≈ 92 m > `DRONE_AGGRO_RADIUS_M` (80). No aggro, no hits.
   - Correct fix: in `shard.ts` `stepDrones()` patrol branch (~line 1969-1974), hover above the
     LOCAL ground: `y = planetHeightAt(this.galaxySeed, planet, x, z) + DRONE_HOVER_M` where
     `x/z` are the orbit point. `planetHeightAt` is in `@shared/world/deposits` (line 74) — the SAME
     pure height function `hazards.ts` and the test already use. You need the planet: either set
     `entity.planetId = hazard.planetId` in `spawnDroneEntity` (~line 2026) and resolve the planet,
     or store `planetId` on the drone record (`this.drones.set(...)`).
   - ⚠️ Do NOT use `this.resolveRegimeCtx(entity).options.heightAt(x,z)` for this — it shares the
     per-planet `TerrainContext` cache with the ship + character and re-primes (evicts + regenerates
     a 3×3 chunk neighborhood, each `generateSurfaceChunk` builds a 64×64 fbm heightmap) on every
     call from every entity at a different position. That made every tick O(hundreds of ms) → the
     ~4700-tick test appeared to hang (worker 99% CPU, crawled to tick ~140 then never finished).
     `planetHeightAt` is O(1) per call — no shared cache — and is the right tool.
   - (Alternative, less faithful: make drone aggro/fire use HORIZONTAL (x,z) distance instead of 3D.
     The local-ground hover fix above is preferred — it also stops drones being buried in hills.)
2. Run `cd app && npx vitest run src/server/shard/shard.hazards.test.ts` → expect 4/4 green.
   Then full `npm run test` + `npx tsc --noEmit`.
3. Commit server slice; mark TASK-48 steps 1+2 `pass: true` in `.ralph/tasks/TASK-48.json`.
4. Step 3 (client, all new) — see spec: `state/hazards.ts` store (pattern `state/cargo.ts`),
   `ui/hazard-hud.tsx` (`id="hazard-hud"`, mount in `main.tsx`, wire `msg.type==='hazard'` next to
   the 'cargo'/'ui-open' handlers ~line 224-260), `WorldManager.ts` hazard discs (pads are the
   pattern — `padRingsFor`/`padRingVisible` 500 m cull ~line 153/401/442; storm=8 rotating quads,
   rad=green disc, drones=small rotating octahedrons from the 10 Hz `kind:'drone'` entities; client
   gets `hazardsFor(seed, system)` the same way `padsForSystem` is called), `hazard-debug.ts`
   `window.__HAZARD__` dev hook (pattern `char-debug.ts`).
5. Dev route for e2e: `GET /api/dev/hazard-target` in `src/server/routes/dev.ts` (pattern
   `pad-target` line ~64; scan systems with `hazardsFor(deps.galaxySeed, system)`, return first
   storm cell {systemId, planetId, hazardId, pos, radius}). `POST /api/dev/teleport-char` ALREADY
   EXISTS (~line 108).
6. E2E `app/tests/e2e/hazards.spec.ts`: copy `walk.spec.ts` skeleton verbatim (inline RawWsClient,
   claim → `dockAtPad` → browser → press E to disembark), then `POST /api/dev/teleport-char` into
   the storm cell, wait `#hazard-hud` visible, assert exposure < 50 via `window.__HAZARD__` after a
   few seconds, screenshot `.ralph/screenshots/TASK-48-1.png`, `assertClean()`. Do NOT wait for
   storm knock-down (25 s from full pool) — the meter + drain is the AC.
7. `eslint --fix` + `prettier --write` on touched files; `npm run test`; e2e; screenshots.
8. Close-out: step 3+4 flags, `passes: true` in `.ralph/tasks.json` (TASK-48 ~line 512), LOG.md entry
   (newest at top, bump 'Tasks Completed'), STRUCTURE.md if it tracks these files, commit, promise.

## Dead ends

- Hovering drones at LOCAL ground via `resolveRegimeCtx(entity).options.heightAt(x,z)` — made the
  test crawl (looked like a hang). Shared per-planet TerrainContext thrashing. Use `planetHeightAt`
  instead. Do not re-attempt the resolveRegimeCtx approach.
- `cell.id` is undefined on a `Hazard` — the id field is `cell.hazardId`.
- Exact knock-down timing at 10 Hz (dt=0.1) is off by one tick (float: 5×0.1≠0.5) — the unit tests
  run timing cases at 1 Hz. Don't "fix" them back to 0.1 s with exact-ms asserts.
- `tickRng` (shard/ai.ts) returns `() => number`, not the `Rng` class — `spawnDroneEntity` is written
  against the function form.
- `SimEntity` REQUIRES `docked` (set `docked: false` when spawning drone entities).
- Character `planetId` is NOT re-resolved after `teleportCharacterForTesting` — hazard lookups use
  the disembark planet, which is why the test builds a 1-planet system.
- Re-knock at the 5 s deadline while still inside a hazard is INTENTIONAL (documented in hazards.ts);
  "knocked fires once" asserts must be scoped to one episode.
- vitest swallows `console.error` in the test reporter — to log from shard code during a run, write
  to a file (e.g. `appendFileSync('/tmp/x.log', ...)`).

## How to verify

- `cd app && npx vitest run src/server/shard/shard.hazards.test.ts` → currently 3 pass / 1 fail
  (aggro). After the hover fix → 4/4.
- `cd app && npx vitest run src/shared/world/hazards.test.ts` → 19/19 green (baseline).
- `cd app && npx tsc --noEmit` and `npm run test` (full suite).
- E2E harness per `playwright.e2e.config.ts` / `tests/e2e/walk.spec.ts` (dock→disembark template).
