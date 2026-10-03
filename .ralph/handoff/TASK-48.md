# Handoff: TASK-48 — Surface hazards with damage and respawn

## Status

Server side of TASK-48 is CODED (shared derivation + exposure math committed and unit-green; shard
integration for exposure/drones written and type-checks) but the new shard integration tests have
NEVER BEEN RUN, and all client work (step 3) plus e2e (step 4) is untouched. Spec:
`.ralph/tasks/TASK-48.json`. Deadline pressure: this iteration ran out of time.

## Done

### Committed (45d0204) — verified green
- `app/src/shared/world/hazards.ts` — the shared module:
  - `hazardsFor(galaxySeed, system)` (cached, `__resetHazardCache()` test hook): ≤
    `HAZARD_MAX_PER_PLANET` (8) cells per landable non-ocean/gas planet, seeded radius 100-400 m,
    `intensity` tier {1.0, 1.5, 2.0} (VISUAL only — drain rates are fixed per kind, documented),
    `droneCount` 2-4 only for kind 'drones', cell-aligned positions around `planetAnchor(index)`,
    rejection: whole disc ≥ `HAZARD_SAFE_ZONE_M` (300 m) from pads (stronger than the spec's center
    rule) + `HAZARD_MIN_SPACING_M` (250 m) between centers. Same pattern as `deposits.ts`.
  - `tickExposure(state, inside: 'storm'|'radzone'|null, dtSec, nowMs)` — PURE: drain 2/s storm,
    5/s rad, regen 5/s outside, cap 50, knock-down at 0 → `recoveringUntilMs = now + RECOVER_MS`
    (5 s), `knocked: true` once per episode. KNOWN/DELIBERATE: a player still INSIDE a hazard at
    the 5 s deadline re-knocks immediately (pool is 0 inside → drains again). Documented in module.
  - `hazardAt(hazards, pos, planetId)` (xz distance ≤ radius, planet-scoped).
- `app/src/shared/world/hazards.test.ts` — 19/19 green (placement, safe zone, spacing, determinism,
  exposure math at 1 Hz, knock-down timing exact, re-knock, hazardAt).

### Uncommitted (working tree — `git status`) — tsc GREEN, shard tests NOT RUN
- `app/src/shared/protocol/schemas.ts`: `ENTITY_KINDS += 'drone'`; `damageSourceSchema` + drone
  variant; NEW server→client frame `hazard` = `{exposure 0..50, inside?: 'storm'|'radzone',
  recoveringUntil?: epoch-ms}` (per-connection like 'mining', never rides entity_update).
- `app/src/shared/physics/damage.ts`: `DamageSource` + `{kind:'drone', id}`.
- `app/src/server/shard/types.ts`: `SimEntity.kind += 'drone'`.
- `app/src/server/shard/shard.ts` (the bulk):
  - Fields: `hazardsByPlanet`, `hazardStates` (playerId → ExposureState, NON-persistent),
    `readonly drones` (entity id → {hazardId, cell, orbitRadius/Angle/Dir, hullPoints,
    nextFireAtMs, respawnAtMs, spawnPos}) — made public so the new test reads it.
  - Constructor: derives `hazardsFor`, spawns one entity per seeded drone
    (`drone:<hazardId>:<i>`, kind 'drone', classId 'drone', `docked: false` — TS requires the
    field, hull normalized 1 = 20 pts) with orbit seeded from `tickRng(systemId, 0)` (that helper
    returns `() => number`, NOT the Rng class — `spawnDroneEntity(hazard, index, rng: () => number)`).
  - `tick()`: `stepHazardExposure()` BEFORE the character loop (drain/regen/knock-down, emits
    'hazard-knockdown'); recovering characters get `ZERO_CHARACTER_INPUT` in the character loop
    (cannot move); `stepDrones()` AFTER the character loop; `sendHazardFrames()` at 10 Hz cadence
    (on-foot connections only, schema-validated, silent skip on parse fail).
  - `stepDrones()`: respawn at `DRONE_RESPAWN_MS` (180 s, tick is the timer — rogue pattern, same
    wire id); target = nearest on-foot CHARACTER within `DRONE_AGGRO_RADIUS_M` (80 m) — ships are
    NEVER targeted; chase at `DRONE_CHASE_SPEED` (5 m/s); fire when ≤ 30 m and `now ≥
    nextFireAtMs` via `applyDamage({hull: EXPOSURE_MAX, shields: exposure}, 3, {kind:'drone',id})`
    (pool plays the shield slot); `broadcastCombatEvent` 'hit' weapon 'drone-cannon'; skips re-hit
    while the target is recovering; no target → patrol orbit (`DRONE_ORBIT_SPEED` 0.3 rad/s, hover
    `DRONE_HOVER_M` 2 m above cell ground).
  - `handleInteract`: recovering players are denied (error 'recovering', outcome 'wrong-regime').
  - Test hooks: `damageDroneForTesting(id, amount)` (pipeline + 'destroyed' event + 180 s respawn
    arm), `setExposureForTesting(playerId, v)`, `getHazardStateForTesting(playerId)`.
  - persist.ts needs NO change: it only persists `kind === 'ship' && playerId` (drones skipped).
- `app/src/server/shard/shard.hazards.test.ts` (NEW, never run): fully fake clock — shard option
  `now: () => clock`, `step()` advances clock 50 ms + asserts `shard.sim.step(clock - 50) === 1`,
  `advance(untilMs)` burst-steps ≤5 ticks/burst. `findSystem()` scans seeded galaxies for a planet
  with ALL THREE hazard kinds and builds a 1-planet system (character's planetId is NOT re-resolved
  after teleport, so the hazards MUST be on the disembark planet — do not "fix" this). Three
  describe blocks: rad drain→knock-down→movement freeze→regen; drone aggro/2 s cadence (per-drone
  ≥1950 ms on the fake clock)/source 'drone'/exact pool drain; ship immunity; kill+180 s respawn.

## Working tree

- Committed: 45d0204 (shared hazards module + 19 unit tests, green).
- NOT committed: `app/src/server/shard/shard.ts`, `app/src/server/shard/types.ts`,
  `app/src/shared/physics/damage.ts`, `app/src/shared/protocol/schemas.ts`,
  `app/src/server/shard/shard.hazards.test.ts` (new).
- Builds: `cd app && npx tsc --noEmit` was GREEN at handoff time.
- Also dirty (pre-existing, NOT this task's): many `.ralph/screenshots/*.png` modifications and an
  untracked `.ralph/split/TASK-46/` — leave them alone; commit only the files above.
- `.ralph/tasks/TASK-48.json` step flags: all `false` (step 1 is essentially done server-side but
  leave flags until the integration test is green).

## Next steps

1. `cd app && npx vitest run src/server/shard/shard.hazards.test.ts` — FIRST. Expect to debug:
   the `advance()` burst math, the dock-approach loop (mirrors `shard.character.walk.test.ts`),
   cadence tolerance, and knock-down tick counts. Full-suite `npm run test` + `npx tsc --noEmit`
   when green.
2. Commit the server slice (Conventional Commit, e.g. `feat(hazards): shard exposure + drone sim
   (TASK-48 steps 1-2)`), then mark step 1+2 `pass: true` in `.ralph/tasks/TASK-48.json`.
3. Step 3 (client — all new):
   - `src/client/state/hazards.ts` store (pattern: `state/cargo.ts` — setHazardFrame / reset /
     emit-on-change subscribe; reset on snapshot/system change).
   - `src/client/ui/hazard-hud.tsx`: exposure bar + radiation icon, pulses red near 0,
     'SHIELD BURN'/'RECOVERING' prompt; give it `id="hazard-hud"`. Mount in `main.tsx`; wire
     `if (msg.type === 'hazard')` in the message dispatch (next to the 'cargo'/'ui-open' handlers,
     ~line 224-260 of main.tsx).
   - `src/client/world/WorldManager.ts`: hazard discs in the system-creation path (pads are the
     pattern — `padRingsFor`/`padRingVisible` 500 m culling, ~line 153/401/442): storm = 8
     rotating quads (rotate in the per-frame update), rad = green disc; drones = small rotating
     octahedrons driven by the 10 Hz snapshot's `kind: 'drone'` entities (ore-rocks.ts is the
     static-entity pattern). Client gets `hazardsFor(seed, system)` — the seed is available the
     same way `padsForSystem` is called.
   - `src/client/hazard-debug.ts` dev hook `window.__HAZARD__` (pattern: `char-debug.ts`) for the
     e2e to assert exposure.
4. Dev route for the e2e: `GET /api/dev/hazard-target` in `src/server/routes/dev.ts` (pattern:
   `pad-target` at line 64; scan systems with `hazardsFor(deps.galaxySeed, system)` and return the
   first storm cell: {systemId, planetId, hazardId, pos, radius}). `POST /api/dev/teleport-char`
   ALREADY EXISTS (dev.ts ~line 108) — the e2e teleports the on-foot character into the cell.
5. E2E `app/tests/e2e/hazards.spec.ts`: copy the `walk.spec.ts` skeleton verbatim (inline
   RawWsClient, claim → `dockAtPad` → browser → press E to disembark), then
   `POST /api/dev/teleport-char` into the storm cell, wait for `#hazard-hud` visible, assert
   exposure < 50 via `window.__HAZARD__` after a few seconds, screenshot to
   `.ralph/screenshots/TASK-48-1.png`, `assertClean()`. Note: storm knock-down from full pool takes
   25 s — do NOT wait for it in the e2e; the meter + drain is the AC.
6. `eslint --fix` + `prettier --write` on every touched file; `npm run test`; e2e; screenshots.
7. Close-out: step 3+4 flags, `passes: true` in `.ralph/tasks.json` (TASK-48, line ~512),
   `.ralph/logs/LOG.md` entry (newest at top, bump 'Tasks Completed'), `.ralph/STRUCTURE.md` if it
   tracks these files, commit, promise.

## Dead ends

- Exact knock-down timing at 10 Hz (dt = 0.1) is off by one tick from float accumulation
  (5×0.1 ≠ 0.5 exactly) — the unit tests therefore run the timing cases at 1 Hz (whole-second
  drains, exact integers) per the spec's "damage ticks in the sim (1 Hz)". Don't "fix" the tests
  back to 0.1 s and assert exact ms.
- `tickRng` (shard/ai.ts) returns `() => number`, not `@shared/random`'s `Rng` class —
  `spawnDroneEntity` was written against the function form; don't import Rng there.
- `SimEntity` REQUIRES `docked` (TS error hit when spawning the first drone entity).
- Character `planetId` is not re-resolved after `teleportCharacterForTesting` — hazard lookups use
  the disembark planet; that's why the test builds a 1-planet system instead of teleporting
  cross-planet.
- Re-knock at the 5 s deadline while still inside is INTENTIONAL (documented in hazards.ts);
  asserts "knocked fires exactly once" must be scoped to one episode (the unit tests are).

## How to verify

- `cd app && npx vitest run src/shared/world/hazards.test.ts` (green, committed baseline).
- `cd app && npx vitest run src/server/shard/shard.hazards.test.ts` (the gate for steps 1-2).
- `cd app && npx tsc --noEmit` and `npm run test` (full suite; the pre-existing suite was green
  before this session's changes landed).
- E2E: `npm run dev:test`-style harness per `playwright.e2e.config.ts` / other specs in
  `app/tests/e2e/` (walk.spec.ts is the template for the dock→disembark flow).
