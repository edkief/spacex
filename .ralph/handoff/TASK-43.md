# Handoff: TASK-43 — Weapons: laser (instant) and missiles (homing)

## Status

Implementation + unit tests are written and committed; `src/shared/weapons.test.ts` (all 18 tests)
and `src/server/shard/shard.weapons.test.ts` (14 of 15 tests) pass, and this session FIXED TWO REAL
BUGS in the previous session's code (broken `turnToward` Rodrigues math, energy spent on denied
missile fires). Remaining: 1 failing LOS unit test (debugged — see Dead ends), the WS integration
test, the e2e + screenshot, full suite, and bookkeeping.

## Done

This session's work is in commit `2547175` (on top of `47d41bc`, which has the full implementation):

1. **`app/src/shared/weapons.test.ts` (NEW, 18 tests, ALL PASS)** — weapon def values,
   `loadoutFor`/`hasWeapon` per class (scout [laser], interceptor [laser,missile], freighter
   [laser]), energy model (regen 10/s clamp 100, `canFire` boundary at exactly the cost,
   `spendEnergy`), `turnToward` numerics (aligned / capped 30° / full angle / zero-distance /
   zero-velocity, magnitude pinned), `stepMissile` homing: straight 300 m target → contact
   (< 5 m) at ~2.5 s < 5 s ttl; target fleeing straight at 60 u/s → hit < ttl; evading target
   (circle, 3 rad/s > 1.5 cap, 240 u/s) → never within 5 m in 100 steps.
2. **`app/src/server/shard/shard.weapons.test.ts` (NEW, 15 tests, 14 PASS)** — follows
   `shard.mining.test.ts` conventions exactly: fake `now` closure + `advance(shard, ms)` running
   `shard.sim.step(fakeNow)` per 50 ms, `warmup(shard)` (one `advance(250)`) to burn the
   SimLoop's initial 5-tick catch-up burst so each later `advance(50)` = exactly 1 tick. Ships
   placed in OPEN SPACE near the origin (planet anchor is 10 km away at `planetAnchor(0)` =
   (10000, 0), outside the 1 km atmosphere, so the regime stays 'space' under the tick).
   Covers: laser hit (8 dmg → shields `1 - 8/50`, laser-fired + hit events, energy 98 at
   acceptance), fire-rate silent drop (no energy, no 2nd event; re-accepted after cooldown),
   energy gate (`low-energy` error, 0 spent, idle regen only), regen 10/s + clamp,
   out-of-range laser (beam runs to max range, `to: z=403`, no hit), no-target raycast (ship
   2 m off the nose ray is hit), loadout gate (scout firing missile = silent drop), missile
   straight-target hit (25 dmg, `missile-fired` + `missile-impact` + `hit`, projectile entity
   `kind:'projectile'` ttl 99 after one tick), evading target → expiry (no impact, no hit,
   projectile gone after 5.2 s — target teleported each 100 ms, like mining's range-loss test),
   splash (p3 at (2,0,298) takes 12, shooter 300 m away untouched, exactly one impact),
   16-cap (16 pre-seeded `proj:101..116` with `spawnTick 100+i`; 17th fire expires `proj:101`,
   fresh shot lands as `proj:1` — the shard's own seq starts at 1!), out-of-range/no-target
   missile = refused BEFORE acceptance (energy stays 100), 30-fires-in-1-s → `weapon-locked`
   (exactly 1 error at the 30th, locked fire at +1 s refused, unlocked and firing again at +5.1 s),
   destroyed ship ignores fire.
3. **BUG FIX — `app/src/shared/weapons.ts` `turnToward` was WRONG** (the previous handoff
   warned to verify it; it failed): (a) the Rodrigues term added `k̂·sinθ` (a vector of length
   sinθ) instead of `(k̂×v)·sinθ`; (b) the aligned branch returned `vecScale(vel, magnitude)` —
   MULTIPLYING by magnitude instead of re-normalizing — so a missile's velocity exploded to
   120×120 = 14400 u/s and NaN'd on overshoot (this broke missile flight in the sim). Rewritten:
   `v' = v·cosθ + (k̂×v)·sinθ` (the `k(k·v)(1−cosθ)` term vanishes: the axis `v×toward` is
   perpendicular to v), aligned/zero-distance branches now `vecScale(vel, magnitude / curLen)`.
   Verified numerically by the new tests (30° turn → exactly `42·sin30`/`42·cos30`).
4. **BUG FIX — `app/src/server/shard/shard.ts`: denied missile fires no longer spend energy.**
   New private helper `validMissileTarget(entity, targetId)` (alive ship/ai-ship, within
   `MISSILE.range` of the NOSE, `losClear`). `handleFire` now rejects a missile fire with no
   valid target BEFORE committing energy (silent drop, spec: "energy not spent on denied fires").
   `fireMissile` re-validates in the tick and, if the target was lost between acceptance and
   tick, REFUNDS `weapon.energy` (`Math.min(ENERGY_MAX, energy + cost)`).
5. **Ordering fix — `fireLaser` now broadcasts `laser-fired` BEFORE `handleWeaponContact`**
   (the beam leads the damage; the hit event follows in the same tick). Test expectations use
   the `[laser-fired, hit]` order.

## Working tree

- Clean (everything committed). History: `2547175` (this session's tests + fixes) on
  `47d41bc` (previous session's full implementation: shared weapons.ts, protocol schemas,
  shard fire pipeline + missile sim, client FX + HUD) on `601d66f` (TASK-42).
- Builds: `npx tsc --noEmit` exit 0 (verified this session). eslint/prettier NOT re-run this
  session on the new/edited files — run `npx prettier --check` / `npm run lint` on:
  `app/src/shared/weapons.ts`, `app/src/shared/weapons.test.ts`,
  `app/src/server/shard/shard.ts`, `app/src/server/shard/shard.weapons.test.ts`.
- Test state: `npx vitest run src/shared/weapons.test.ts src/server/shard/shard.weapons.test.ts`
  → 32 passed / 1 failed (the LOS test, below). The rest of the suite was last fully green in
  TASK-42's close-out; `turnToward` is shared but only exercised by the new tests.

## Next steps

1. **Fix the one failing test**: `shard.weapons.test.ts > LOS against the seeded analytic
   terrain > a ship behind the ridge is NOT hit…` — assertion `ship-p2 shields toBe(1)` receives
   `0.84` (the hit lands). Root cause: the tick's `resolveRegime` re-resolves the manually-added
   'surface' ships to **'space'** when their 3D distance to the planet anchor (10000, 0) exceeds
   the exit radius (1050 m) — space ships skip terrain/LOS entirely, so the shot always lands.
   `findRidge` in the test already scans a ±550 m window around `planetAnchor(0)` (verified a
   sweep-occluding ridge exists there: px 9450, pz −550 for seed `shard-weapons-los-seed`,
   drop 12, occlusion `h(sample) > hA + 8`). The ships (px±100, y ≈ hA+5 ≈ 250) are then ~900 m
   from the anchor — should stay in atmosphere. It STILL fails, so the next step is to debug
   empirically: write a throwaway tsx script (like `/tmp/los-debug3.ts` from last session —
   same file was committed? NO, it lived in /tmp and is gone — recreate it) that mirrors the
   test exactly (warmup 250 ms, place ships, log `entity.ship.regime` + `entity.planetId`
   AFTER warmup, replicate the 20 m sweep against `shard.terrainHeightAt`, fire, check).
   If the regime still flips to space: shrink the scan window (±350 or ±300) or verify the
   ship's y doesn't change under the integrator. If the regime holds but the hit still lands:
   check whether the explicit-target path's `losClear` (5-sample `lineOfSight`) passes and the
   sweep's `endT` boundary (`d < endT`) skips the occluding sample — the sweep starts at
   d = stepM = 20, so a sample at d < 20 (impossible: min d = 20) is fine, but a ridge
   occluder between d=180 and endT=197+ would be MISSED if endT = 197 and the last sample is
   d=180 — widen the occlusion check in `findRidge` to also require `h(px-97+190) > hA+8`-ish
   coverage, or place the ridge so an occluding sample lands < 190.
2. **Integration test** (AC: "ship A fires at B, B's shields drop, C sees the FX events"):
   new `app/src/server/shard/shard.weapons.ws.test.ts` modeled on
   `shard.combat.ws.test.ts` (real fastify + ws + `WsTestClient`/`joinSystem` from
   `@server/ws-test-client`; `teleportForTesting` both ships 60 km out → space regime;
   wait 400 ms for regime re-resolve). The only wiring difference: pass
   `onGameMessage: (conn, type, payload) => { if (type === 'fire' && conn.systemId === system.systemId) shard.handleFire(conn.playerId!, payload as { weapon: string; targetId?: string }, conn); }`
   to `attachWebSocket`. A sends `{ v: PROTOCOL_VERSION, type: 'fire', payload: { weapon: 'laser', targetId: b.shipId } }`;
   assert B's entity shields drop to `1 - 8/50` (shard state + eventually the 10 Hz
   `entity_update`), and C (observer, fires nothing) receives `laser-fired` then `hit`
   combat_events. Note: the ship spawned at join docks at a pad with energy undefined →
   treated as full (100); classId is 'scout' (loadout has laser).
3. **e2e `app/tests/e2e/weapons.spec.ts`** (model on `multiplayer.spec.ts` + `raw-ws.ts`):
   start `npm run dev` in `app` (background; kill after). Claim in the browser,
   `page.evaluate(() => { document.body.dataset.fxSlow = '1' })` (500 ms flashes for the
   screenshot), wait for `#weapon-hud` (appears with the self ship), `page.mouse.click` on
   `#game-canvas`, assert `window.__FX__.laserFlashes >= 1` (from `app/src/client/fx-debug.ts`,
   DEV-only) and/or a second raw-WS client sees `laser-fired`,
   `page.screenshot()` → `.ralph/screenshots/TASK-43-1.png`.
4. **Full suite + build**: `npm run test` (≈3.5 min), `npx tsc --noEmit`,
   `npx prettier --write` + eslint on touched files.
5. **Bookkeeping** (only after all of the above is green): set steps 1–4 `pass: true` in
   `.ralph/tasks/TASK-43.json`, `passes: true` for TASK-43 in `.ralph/tasks.json`, LOG.md entry
   at top (date, summary, screenshot path), update `.ralph/STRUCTURE.md` if dirs changed (new
   dirs this task: `app/src/client/world/combat-fx.ts`, `app/src/client/fx.ts`,
   `app/src/client/fx-debug.ts`, `app/src/client/ui/weapon-hud.tsx` — check STRUCTURE.md's
   granularity convention), DELETE `.ralph/handoff/TASK-43.md`, Conventional Commit.

## Dead ends

- **findRidge window [2000, 4200] (copied from shard.combat.test.ts): DOES NOT WORK for a test
  that runs sim ticks.** Ships 6–8 km from the planet anchor get re-resolved to 'space' by
  `resolveRegime` every tick; space skips terrain/LOS, so the laser always hits.
  `shard.combat.test.ts` only works because it never calls `shard.sim.step` (it invokes
  `resolveHit` directly).
- **±850 m window around the anchor: NOT ENOUGH.** Ridge found at (9150, −800) is 1.25 km from
  the anchor → beyond the 1050 m exit radius → ships still flipped to 'space' (verified with a
  debug script: `p1 … regime space planetId undefined`, yet the manual sweep showed
  `d=20 point y=154 terrain=188 -> OCCLUDED` — the shard's own sweep is skipped for space).
- **Energy assertions must account for tick regen**: the tick adds 0.5 u per 50 ms (10/s × dt)
  and MATERIALIZES `energy` (undefined → 100) on the very first tick — so "energy stays
  undefined" assertions are wrong after any `advance`; assert exact post-regen values
  (e.g. 98.5 one tick after a laser fire) or check immediately after `handleFire`.
- **Projectile-cap ids collide with the shard's own counter**: `projectileSeq` starts at 0, so
  the shard's first real missile is `proj:1` — pre-seeded test projectiles must use ids
  `proj:101+` (the cap sorts by `projectile.spawnTick`, not the id).
- **Pure `stepMissile` at a stationary target OVERSHOOTS**: the pure function flies straight
  through the target (the shard detonates on the first tick with gap ≤ 5). Fixed-step-count
  tests get a final gap of ~5700 m or NaN — the test must loop until gap < 5 and record the
  contact step.
- **`turnToward` "rewritten mid-session (Rodrigues form)" in the previous handoff was BROKEN** —
  do not trust any pre-`2547175` missile flight behavior; the fixed version is the committed one.
- `proj.ttl` after one tick is 99, not 100 — `updateProjectiles` decrements in the same tick
  that spawns it (`processFireIntents` runs before `updateProjectiles`).

## How to verify

- `cd app && npx vitest run src/shared/weapons.test.ts src/server/shard/shard.weapons.test.ts`
  → currently 32 pass / 1 fail (the LOS test).
- `npx tsc --noEmit` → exit 0 (verified this session).
- Full suite: `cd app && npm run test` (≈3.5 min).
- e2e: dev server (`npm run dev` in `app`, http://localhost:3000) + Playwright; see Next steps.
- The client-side FX/HUD (combat-fx.ts, fx.ts, fx-debug.ts, weapon-hud.tsx, WorldManager/main.tsx
  wiring) is UNCHANGED this session and was type-checked clean in `47d41bc`; only the e2e
  exercise of it remains.
