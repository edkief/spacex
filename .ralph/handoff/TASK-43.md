# Handoff: TASK-43 — Weapons: laser (instant) and missiles (homing)

## Status

Full implementation (shared weapon defs, server fire pipeline + missile sim, client FX + HUD) is
WRITTEN, type-checks clean, lints clean, and does NOT regress existing tests — but there are ZERO
new tests, no e2e, no screenshots, and no bookkeeping. The next session's job is: write the
tests (step 4), e2e + screenshot, full suite, bookkeeping, commit.

## Done

All in this uncommitted work (build verified: `npx tsc --noEmit` clean, eslint clean on touched
files, `shard.combat.test.ts` + `shard.damage.test.ts` + `protocol.test.ts` all green, 33 tests):

1. `app/src/shared/weapons.ts` — extended the TASK-42 WeaponSpec (new OPTIONAL fields
   `kind/fireRate/energy/splashDamage/splashRadius/speed/turnRate/ttl` — optional because the
   TASK-42 tests build minimal `{id,damage,range}` specs). Added: `LASER` (8 dmg, 400 m, 3/s,
   2 energy), `MISSILE` (25 dmg, splash 12/5 m, 800 m, 0.5/s, 10 energy, speed 120, turn 1.5,
   ttl 5 s), `WEAPON_BY_ID`, `isWeaponId`, `loadoutFor(classId)` (scout [laser], interceptor
   [laser,missile], freighter [laser]), `hasWeapon`, energy model (`ENERGY_MAX=100`,
   `ENERGY_REGEN_PER_S=10`, `regenEnergy`, `canFire`, `spendEnergy`), and pure missile flight
   (`turnToward` — Rodrigues rotation with magnitude pinned — and `stepMissile`).
2. `app/src/shared/protocol/schemas.ts` — ENTITY_KINDS + 'projectile'; entityStateSchema +
   optional `energy` (0..100); COMBAT_EVENT_KINDS + 'laser-fired'/'missile-fired'/'missile-impact';
   new messageSchemas entries: `fire {weapon:'laser'|'missile', targetId?}` and the three new
   combat_event union branches (laser-fired {source, weapon, from, to}, missile-fired
   {source, weapon, projectile, from}, missile-impact {weapon, projectile, point}).
3. `app/src/server/shard/types.ts` — SimEntity.kind + 'projectile'; new SimEntity fields
   `energy?`, `fireCooldownUntil?` (weapon id → sim tick), `projectile?` {targetId, sourceId,
   weaponId, spawnTick}; ConnState fields `fireQueue?`, `weaponLockedUntilMs?`,
   `fireSpamCount?`, `fireSpamWindowStartMs?`.
4. `app/src/server/shard/shard.ts` — the core:
   - `handleFire(playerId, {weapon, targetId?}, source?)` — stale-conn guard → lock check
     ({code:'weapon-locked'}) → spam counter (30 fires/s → 5 s lock, log) → loadout → cooldown →
     energy ({code:'low-energy'}); ACCEPTED fires commit energy + cooldown (`FIRE_QUEUE_MAX=4`,
     cooldown = ceil(1/(rate·dt)) ticks) and enqueue for the tick.
   - tick(): energy regen for player ships (`regenEnergy(entity.energy ?? ENERGY_MAX, dt)`),
     `processFireIntents(tick)` then `updateProjectiles()`; the ttl sweep now SKIPS
     `kind==='projectile'` (updateProjectiles owns projectile ttl — double-decrement bug avoided).
   - `fireLaser` — client target re-validated (range 400 + `losClear`), else raycasts first ship
     within `LASER_HIT_RADIUS_M=5` perpendicular, then terrain occlusion (20 subsamples); damage
     via existing `handleWeaponContact`/resolveHit; ALWAYS broadcasts 'laser-fired' on accepted fire.
   - `fireMissile` — requires a valid target (else silent drop); `PROJECTILE_CAP=16` (oldest
     expires, logged); spawns `proj:<seq>` entity (classId 'missile', ttl 5 s in ticks,
     `projectile` meta, planetId for terrain); broadcasts 'missile-fired'.
   - `updateProjectiles` — homing via `stepMissile` (dead/lost target → fly straight), ttl
     expiry = miss (no hit, logged), contact at splash radius → `detonateMissile`, terrain impact
     → `detonateMissile` with no direct target.
   - `detonateMissile` — 25 to target via `applyHit`, 12 splash to every other alive ship/ai-ship
     within 5 m (friendly fire incl. self), 'missile-impact' event, remove.
   - `entityToState` — ships carry `energy` (when set); projectiles render hull/shields 0.
   - `unregisterConnection` — clears the conn's fireQueue + lock + spam state.
5. `app/src/server/shards.ts` — `routeGameMessage` + 'fire' → `shard.handleFire`.
6. Client: `app/src/client/world/combat-fx.ts` (NEW — `CombatFx`: 60 ms additive laser line +
   muzzle spark, 120 ms impact flash, 2 px screen shake decaying 100 ms, tracer pool ≤16 with
   cone mesh + ≤8-point trail, driven from snapshot batches; dev stretch via
   `document.body.dataset.fxSlow='1'` → 500 ms flashes for screenshots);
   `app/src/client/fx.ts` (NEW — `playCombatFx` event→effect map);
   `app/src/client/fx-debug.ts` (NEW — `window.__FX__` {events, laserFlashes, impacts} DEV-only,
   `recordCombatEvent`); `app/src/client/ui/weapon-hud.tsx` (NEW — #weapon-hud: 1/2 weapon buttons,
   name, energy bar 0..100, LOW ENERGY / WEAPON LOCKED prompts);
   `WorldManager.ts` — `get fx()`, tracers fed in `feedRemoteEntities`, shake nudge around
   `renderer.render` in the frame loop; `main.tsx` — `weapon`/`selfShip`/`lowEnergy`/`locked`
   state + refs (`weaponRef`, `selfShipRef`, `selfPosRef`, `remoteShipsRef`, `promptTimers`),
   two NEW `useGameSession` callbacks (`onCombatEvent` → recordCombatEvent + playCombatFx,
   `onWsError` → denial prompts), 1/2 key handler, LMB mousedown on #game-canvas → `send('fire',
   {weapon, targetId: nearest other ship ≤800 m})`, `remoteShipsRef` built in both entity
   callbacks, `<WeaponHud/>` mounted after `<WeightBar/>`.

## Working tree

- Committed: only `ad21a71 chore(ralph): TASK-42 close-out` (previous task's bookkeeping; the
  flaky `surface.test.ts` was re-verified green in isolation).
- Uncommitted: EVERYTHING in "Done" above (12 files touched/created under app/src + nothing else).
- Builds: `npx tsc --noEmit` clean; eslint clean on all touched files; prettier NOT yet run.
- No new tests exist yet (that is the main remaining work).

## Next steps

1. `cd app && npx prettier --write` on the touched files (or `npm run lint`).
2. Unit tests (spec AC "Unit tests: …"):
   - `src/shared/weapons.test.ts` — loadoutFor per class, energy regen/canFire/spendEnergy, and
     `stepMissile` homing: straight target → converges (dist < 5 m) in < 5 s at dt 0.05;
     evading target (circular motion with turn rate > 1.5 rad/s) → never converges → expiry.
     Verify `turnToward` numerically first — it was rewritten mid-session (Rodrigues form).
   - `src/server/shard/shard.weapons.test.ts` — follow `shard.mining.test.ts` conventions EXACTLY:
     fake `now` closure + `shard.sim.step(fakeNow)` per 50 ms (see the `advance()` helper there),
     `makeEntity`-style SimEntity stubs (note: ships need `classId: 'scout'`/'interceptor' for
     loadouts; energy is `?? ENERGY_MAX` so unstated = full). Cover: laser hit (B's shields −8,
     'laser-fired' event), fire-rate (2nd fire within cooldown → silent drop, energy intact),
     energy gate (drain to <2 → {code:'low-energy'}, no event), regen 10/s, out-of-range target
     denied, LOS ridge denial (reuse shard.combat.test.ts `findRidge`), missile straight-target
     hit <5 s (25 dmg + 'missile-impact'), evading → expire no hit, splash (third ship within 5 m
     takes 12), 16-cap oldest-first, weapon lock (30 fires in 1 s fake-time → {code:'weapon-locked'},
     denied for 5 s), not-in-loadout (scout 'missile' dropped).
   - Integration: extend the `shard.combat.ws.test.ts` pattern (real ws clients) — A fires at B,
     B's shields drop, C observes the 'laser-fired' + 'hit' combat_events.
3. e2e `tests/e2e/weapons.spec.ts` (model on `multiplayer.spec.ts` / `raw-ws.ts`): claim in the
   browser, `page.evaluate(() => { document.body.dataset.fxSlow = '1' })`, wait for self ship
   entity (HUD #weapon-hud appears), `page.mouse.click` on #game-canvas, assert
   `window.__FX__.laserFlashes >= 1` (and/or a second raw-WS client sees 'laser-fired'),
   `page.screenshot` → `.ralph/screenshots/TASK-43-1.png`. Remember `npm run dev` (app dir)
   must be running; kill it after.
4. Full suite `npm run test` (≈3.5 min) + `npx tsc --noEmit`. If `surface.test.ts` times out,
   re-run it alone — it flakes under full-suite load (verified green standalone this session).
5. Bookkeeping: step flags in `.ralph/tasks/TASK-43.json`, `passes: true` in `.ralph/tasks.json`,
   LOG.md entry (top) + Tasks Completed 56 → 57, STRUCTURE.md (new files: client/fx.ts,
   client/fx-debug.ts, client/world/combat-fx.ts, client/ui/weapon-hud.tsx; weapons.ts line
   update), delete this handoff, commit (Conventional Commit, e.g.
   `feat(weapons): TASK-43 — lasers + homing missiles, server-authoritative fire, FX + HUD`),
   output the promise.

## Dead ends

- Putting the combat_event/error dispatch directly in `useGameSession`'s onMessage referencing
  App scope — the hook is a separate function and captured `worldRef`/`setLowEnergy` (TS2304).
  Fixed by adding two optional hook params (`onCombatEvent`, `onWsError`) like the existing
  `onMining` pattern. NOTE: `useGameSession`'s effect deps are
  `[session, store, chatStore, clientRef, systemParam]` — the callbacks are captured ONCE, so
  they must only use refs + stable setters (the new code does).
- Double-decrementing projectile ttl: the generic ttl sweep at the top of tick() would have halved
  missile lifetimes; the sweep now skips `kind==='projectile'`.
- Re-checking the fire cooldown inside `resolveFireIntent` would have dropped every accepted fire
  (cooldown is set to `tick + cooldownTicks` at acceptance) — removed; only the loadout is
  re-checked (ship-swap race).
- A first draft of `turnToward` had a garbled magnitude-pinning expression — rewritten as a clean
  Rodrigues rotate + normalize + scale. Unverified by a test yet (see Next steps).
- e2e screenshot of a 60 ms flash is unreliable in headless SwiftShader — hence the
  `document.body.dataset.fxSlow='1'` dev stretch (500 ms) instead of retry loops.

## How to verify

- `cd app && npx tsc --noEmit` (clean now).
- `cd app && npx vitest run src/server/shard/shard.combat.test.ts src/shared/protocol.test.ts`
  (green now — the shared-schemas changes don't regress the wire contract).
- After Next steps 2–4: `cd app && npm run test` full suite green + `npx playwright test
  tests/e2e/weapons.spec.ts` green + screenshot exists at `.ralph/screenshots/TASK-43-1.png`.
- Manual smoke (optional, `npm run dev` in `app/`): claim, join, 1/2 keys switch the HUD weapon,
  LMB fires a laser line flash (energy bar ticks down 2, regens 10/s), a second player's ship
  takes 8 shield damage per hit; interceptor (buy at dock) can fire missiles (tracer + trail,
  splash on impact, 2 px shake).
