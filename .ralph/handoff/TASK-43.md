# TASK-43 — Weapons: lasers and missiles with per-class loadouts

## Status

Server-side weapons implementation is complete (catalog, fire handler, missile
homing, splash, anti-spam lockout, energy model, WS dispatch) and 37 unit tests
pass for `weapons.test.ts`. All 1924 project-wide tests are green
(`tsc --noEmit` clean, eslint clean). The client FX layer + HUD stub are wired
into `App.tsx`, but the `fire`/`select_weapon` client-seam (`sendFire`,
`sendSelectWeapon`, `onFireOk`) was added at the end of the iteration and is
UNVERIFIED end-to-end. The e2e Playwright spec and a ws-round-trip integration
test were not written — the WS test was attempted twice but the test-resolver
fixture doesn't bind the WS connection into the shard (production router does
this, but `attachWs` doesn't), so the wire-up of `fire`/`select_weapon` is
only covered by the unit tests so far.

## Done

- **`app/src/shared/weapons.ts`** (NEW): catalog (LASER / MISSILE stats per spec),
  per-class `LOADOUTS`, `canFireWeapon`, `cooldownMs`, `cycleWeapon`,
  `loadoutFor`, `weaponStats`, `ENERGY_MAX=100`, `ENERGY_REGEN_PER_SECOND=10`,
  `WEAPON_LOCK_THRESHOLD_PER_SECOND=30`, `WEAPON_LOCK_DURATION_MS=5_000`.
- **`app/src/server/shard/weapons.ts`** (NEW): `handleFire`, `handleSelectWeapon`,
  `initWeaponState`, `advanceMissiles`, `energyRegenFor`, `isLocked`,
  `recordFireAttempt`. Missile: spawn entity, contact radius 6 m (sweeps the
  120 u/s × 50 ms = 6 m / tick step), 1.5 rad/s turnRate, 5 s TTL. Splash walks
  `shard.entities` for `other` entities within 5 m. **IMPORTANT**:
  `contactCheck` skips both `missile.id` AND `missile.missileSourceId` — without
  that, the warhead detonates on the firing ship in tick 0 (the missile spawns
  AT the source position, distSq=0).
- **`app/src/server/shard/types.ts`**: added `missile` to `EntityKind`;
  `SimEntity` gained `energy`, `activeWeapon`, `weaponLockedUntilMs`,
  `weaponFireLog`, `weaponCooldownMs` (player/ai only) +
  `missileExpiresAt`, `missileSourceId`, `missileTargetId`, `missileDamage`,
  `missileSplashDamage`, `missileSplashRadius` (missile only). `ConnSender`
  gained `fire_ok` + `weapon_state` frame types.
- **`app/src/server/shard/entity.ts`**: `entityToWire` branches on `kind ===
  "missile"`. Also added to `EntityKindSchema` in protocols.
- **`app/src/server/shard/sim.ts`**: `runOneStep` now calls `advanceMissiles`
  and walks player/ai entities for energy regen. The missile TTL uses
  `this.hooks.clock` (not `Date.now()`) so test fixtures with a fake clock
  drive homing deterministically.
- **`app/src/server/shard/index.ts`**: `spawnShip` and `spawnAiShip` call
  `initWeaponState(entity)`; re-exported `handleFire`, `handleSelectWeapon`,
  `initWeaponState`, `advanceMissiles`, `energyRegenFor`, `isLocked`,
  `recordFireAttempt` from barrel.
- **`app/src/shared/protocol/schemas.ts`**: new `FireSchema`, `FireOkSchema`,
  `WeaponStateSchema`, `SelectWeaponSchema` registered in `PAYLOAD_SCHEMAS`.
  New `EntityKindSchema` variant `"missile"`. New `ErrorCodeSchema` variants
  `"low-energy"`, `"weapon-locked"`, `"weapon-not-equipped"`, `"no-target"`.
  Schemas test updated with happy + malformed examples for all four.
- **`app/src/server/ws.handlers.ts`**: added `onFire` + `onSelectWeapon`. Both
  resolve denial codes via a switch onto wire codes (rate-limited /
  low-energy / weapon-locked / weapon-not-equipped / out-of-range /
  not-attackable / self-target / no-target / unknown). `pushFireOk` /
  `pushWeaponState` (defined in `weapons.ts`) emit the per-connection frames.
- **`app/src/server/ws.dispatch.ts`**: added `if (type === "fire")` and
  `if (type === "select_weapon")` cases in the `joined` state. **CRITICAL
  bug fix during the iteration**: `onSell` was previously unguarded — every
  unhandled `joined`-state frame was falling through to `onSell` (and being
  rejected with `not-found: Sell backend unavailable`). Added `if (type ===
  "sell")` guard before the call.
- **`app/src/client/fx/weapons.ts`** (NEW): `WeaponFxLayer` class with
  `handleFireOk`, `handleCombatEvent`, `updateMissileFromEntity`,
  `despawnMissileTracer`, `snapshot`. Pure DOM/CSS FX, no three.js. 60 ms
  laser flash, ≤ 16 missile tracers, ≤ 8 trail quads each, 2 px screen shake.
- **`app/src/client/components/WeaponFxHud.tsx`** (NEW): polls the FX layer
  at 30 Hz, renders overlays.
- **`app/src/client/components/WeaponHud.tsx`** (NEW): bottom-right energy
  bar + active weapon name + LOCKED indicator.
- **`app/src/client/net/wsClient.ts`**: `getWeaponState()`, `sendFire()`,
  `sendSelectWeapon()`, `onFireOk()`. New `WeaponStateSnapshot` interface.
  New `weaponState` field + `fireOkListeners` set. Handlers for
  `fire_ok` and `weapon_state` frames.
- **`app/src/client/App.tsx`**: instantiates `weaponFx = new WeaponFxLayer()`,
  mounts `<WeaponFxHud layer={weaponFx} />` and `<WeaponHud client={client} />`,
  wires `client.onFireOk(...)` to push accepted fires into the FX layer
  (denied fires are no-ops in the layer per spec).
- **`app/src/client/index.html`**: added `drift-laser-flash` (60 ms additive
  fade) and `drift-missile-trail` (250 ms fading quads) CSS keyframes.
- **`app/src/client/input/interaction.test.ts`**: whitelisted
  `src/server/shard/weapons.ts` in `allowedKindRefs` (the dispatch-site lint
  rejects inline `kind === "..."` checks outside the registry).
- **`app/src/shared/protocol/schemas.test.ts`**: added happy + invalid
  fixtures for `fire`, `fire_ok`, `weapon_state`, `select_weapon`.
- **`app/src/server/ws.cargo.test.ts` + `app/src/server/ws.mining.test.ts`**:
  `ShardLike.send` signature updated to include `"fire_ok"` and
  `"weapon_state"` (new `ConnSender` variants). Cast through `unknown` to
  keep the existing inline signatures compilable.

## Working tree

- Branch: `master`, latest commit `dbe369b` "wip(TASK-43): weapons impl
  complete, dispatch + wire-up done, awaiting e2e".
- 20 files changed, +3615 LOC. 6 new files. No untracked leftovers.
- `npm run test`: 1924/1924 pass (was 1887 before — +37 weapons unit tests).
- `npx tsc --noEmit`: clean.
- `npx eslint . && npx prettier --check .`: clean.
- `tasks.json` is NOT updated — `passes: false` still.

## Next steps

1. **Write the e2e Playwright spec** (`tests/e2e/weapons.spec.ts`). The
   spec is required by TASK-43 acceptance: "e2e: fire a laser in the
   browser, screenshot the flash". Easiest approach: use the existing
   `tests/e2e/fixtures.ts` to boot a worker, then drive
   `client.sendFire({weapon:"laser", targetId: ...})` through the
   `window.__driftClient` test seam (already used by `mining.spec.ts`),
   then sample a frame via `sampleCanvasPixels` or just assert the
   `drift-weapon-fx` testid is mounted. Save screenshot to
   `.ralph/screenshots/TASK-43-1.png`.

2. **Write a ws-round-trip integration test** (`app/src/server/ws.weapons.test.ts`).
   My two attempts failed because the test fixture used `attachWs` directly
   instead of going through the production router — `attachWs` doesn't
   automatically add the connection to `shard.connections`, so
   `handleFire` sees `conn.entityId === null` and rejects with `no-target`.
   Two paths forward:
   - **Easier**: spin up the galaxy router via `buildGalaxy({shardFor: ...})`
     and pass it as the `router` option to `attachWs` (matches the
     production wiring used in `app/src/server/index.ts`). Then `joinResolver`
     will be called for each connection and the production router binds the
     ship entity.
   - **Alternative**: use `addConnection(shard, conn)` directly in
     `beforeEach` to mirror what the router does, then call
     `joinResolver` manually to populate the snapshot.

3. **Set `passes: true` for TASK-43 in `.ralph/tasks.json`** once the
   e2e + ws-round-trip are written.

4. **Cleanup checklist** before considering TASK-43 fully done:
   - Verify `WeaponFxHud` doesn't block clicks (`pointer-events: none` on
     the wrapper — done).
   - Verify the `1` / `2` keybinds call `client.sendSelectWeapon(...)`
     — currently the dispatch is wired but the keyboard handler in
     `App.tsx` only binds `M` (chart), `F3` (debug), and `Escape`. The
     weapon-select keys live in the per-regime `Controls` class
     (TASK-25 / `app/src/client/input/controls.ts`); pick the right scheme
     and call `sendSelectWeapon`. This is required by TASK-43
     acceptance: "weapon selection (1/2 keys) switches active weapon".
   - Wire the camera `shake` in `CameraRig.ts` (TASK-27) to read
     `weaponFx.snapshot().shakePx` (currently the FXHud consumes the
     shake for its own wrapper, but the camera should also nudge per
     TASK-43 spec: "screen shake 2 px").

## Dead ends

- **WS-round-trip test fixture mismatch (×2)**: writing
  `ws.weapons.test.ts` using `attachWs` directly bypassed the galaxy
  router's `bindConnectionToEntity` step. The router auto-adds the
  conn to `shard.connections` and binds the entity; `attachWs` does
  neither. Without the binding, `handleFire` rejects with `no-target`.
  Resolution: use `buildGalaxy` (production router) or manually
  `addConnection(shard, conn)` + manually call `joinResolver`.
- **Unhandled `onSell` fall-through**: pre-fix, every unhandled
  `joined`-state frame (including the new `fire` + `select_weapon`)
  fell through to `onSell` and was rejected with
  `"not-found: Sell backend unavailable"`. The existing tests
  silently passed because none of them tested non-sell frames in the
  joined state. Adding the `if (type === "sell")` guard before the
  `onSell` call fixes this for all future handlers.
- **Missile-on-source detonation**: contact check iterated entities
  and skipped `missile.id` but not the firing ship — the missile
  spawns AT the source position, so a naive distance check detonated
  on the source itself in tick 0. Fixed by also skipping
  `missile.missileSourceId`.
- **Contact radius too small for the homing cadence**: at 120 u/s
  and 20 Hz, the missile moves 6 m per tick — a 1.5 m contact radius
  could miss a stationary target by overshooting half the tick.
  Widened to 6 m.
- **`applyMissileImpact` resolver range mismatch**: resolver's range
  check rejected splash targets past `range²`. Fixed by passing
  `range: 800` (missile flight range) for both the primary hit and
  the splash calls.
- **Resolver range check on the primary hit**: a missile at
  `damagePoint = target.pos` (e.g. 50 m from source) would be
  rejected if `range < 50`. Fixed by passing `range: 800` for the
  primary call too.
- **Energy undefined in tests**: `makeAiEntity` overrides shields
  with `cls.shieldCapacity`. Adding a `shields` arg in
  `addTarget(args.shields)` works because the override happens
  AFTER `makeAiEntity`. Similar concern for hull (interceptor = 80
  base hull, not 100) — added explicit `hull: 100` opt for tests.
- **First-fire cooldown rejection**: `lastAccepted === 0` would
  make `now - lastAccepted = now`, which is always < `cd` for the
  first fire. Fixed by initialising `weaponCooldownMs` to
  `{laser: -cooldownMs("laser"), missile: -cooldownMs("missile")}`
  in `initWeaponState` so the first fire always passes.
- **`Date.now()` in missile TTL**: `advanceMissiles` originally used
  `Date.now()` for the TTL check, breaking tests with a fake clock.
  Patched `sim.ts` to pass `this.hooks.clock ? this.hooks.clock() :
  Date.now()` to `advanceMissiles`.
- **Sim ticks with fake clock**: `tick()` reads `performance.now()`
  by default — instantiating `shard` with `clock: () => fakeNow` lets
  the test harness advance the accumulator at 50 ms / tick.

## How to verify

```bash
cd /workspace/master/app
npm run test                         # → 1924 passed (124 test files; +37 new in weapons.test.ts)
npx tsc --noEmit                     # → clean
npx eslint . && npx prettier --check . # → clean
```

Spot-check a single weapons test:
```bash
cd /workspace/master/app
npx vitest run src/server/shard/weapons.test.ts
# → 37 passed
```

Verify the catalog is correct:
```bash
cd /workspace/master/app
node -e "
const { weaponStats, loadoutFor, cooldownMs, ENERGY_MAX, WEAPON_LOCK_THRESHOLD_PER_SECOND } = require('./src/shared/weapons.ts');
" 2>&1 | head -3
# (won't run as ESM, but the export surface is documented in app/src/shared/weapons.ts)
```

Smoke-test the dev server end-to-end (after writing the e2e spec):
```bash
cd /workspace/master/app
npm run dev   # boots Vite at :3000 + Fastify at :3001
# then run: npx playwright test tests/e2e/weapons.spec.ts
```