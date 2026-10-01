# TASK-25 handoff

## Status
All 5 TASK-25 test files pass (39/39), tsc + eslint clean; the ONLY remaining work is
2 fixture breaks in `src/server/shard/shard.test.ts` (atmosphere ships spawn ~10 km from
the planet anchor, so the new per-tick regime resolution parks them in 'space' with no
gravity) plus the final bookkeeping. The regime machine itself is done and verified.

## Done
This iteration root-caused and fixed ALL 9 previously failing tests:
- `src/server/shard/shard.regime.test.ts` (the `['space']` integration failure):
  1. Initial quat was `quatFromEuler(0, -PI/2, 0)` — that is PITCH -90° (facing +Y up),
     NOT yaw -90° (facing -X toward the planet). `quatFromEuler(yaw, pitch, roll)`
     (src/shared/physics/vec.ts:101). The ship flew straight up and never entered the
     atmosphere. Fixed to `quatFromEuler(-Math.PI / 2, 0, 0)`.
  2. After that fix the ship still flew through the planet: the scripted "brake"
     (thrust -1 + vtol) CANNOT work — the TASK-22 atmosphere regime has NO main
     thruster (integrateShip applies thrust only when regime === 'space',
     src/shared/physics/flight.ts:265) and VTOL_LIFT === GRAVITY exactly (hover only,
     no climb). Rewrote `runScriptedFlight`'s phase machine:
     `cruise` (thrust 1 in space) → `retro` (thrust -1 in space until v ≤ 4, still
     inbound) → `coast` (no input; enters atmosphere at ~4 u/s, falls with no VTOL;
     ground clamp zeroes vel.y → low + slow → 'surface') → `settle` (two surface
     ticks, then scripted impulse `entity.ship.vel = { x: 0, y: 4000, z: 0 }` — see
     Dead ends for why 4000) → `ascent` (coast until 'space'). Exact 5-regime sequence
     holds clean AND under ±1 u position noise. Removed temp debug logging (dbg/
     lastPhase blocks) and the now-unused `ATMO_R` constant.
- `src/shared/regime.test.ts` (4 boundary-assertion bugs, machine was right):
  atmosphere-holding probes at alt 0 speed 0 correctly resolve 'surface' → probes now
  use fast-flyby speeds (10 / limit+5); the x=866,y=500 probe was actually d≈999.98 <
  1000 (bad test math) → x=867 (d≈1000.84); tie test: d=1000 equals the enter radius
  and entry is strict `<` → both planets got radius 1500 so the tie point is strictly
  inside.
- `src/client/input/controls.ts`: yaw pairs emitted +1 for 'a' → flipped to
  `yaw: ['d', 'a']` in both flight schemes (pair[0] = positive demand; +yaw = right
  turn, consistent with vec.test.ts "yaw +90° rotates forward (+Z) to +X"); interface
  comment updated.
- `src/client/input/controls.test.ts`: surface `move` assertion demanded a phantom
  `interact` key on the move object → now expects exactly the four movement keys.
- `src/client/state/regime.test.ts`: first frame confirming the initial 'space' regime
  is not a change (tracker fires once per active CHANGE) → expects `['atmosphere']`;
  removed unused `REGIME_DIVERGENCE_MS` import.
- prettier reformatted `src/server/shard/shard.ts` (signature wrapping ONLY) + a few
  test files. eslint + tsc clean.

## Working tree
- UNCOMMITTED: 7 modified files — `app/src/shared/regime.test.ts`,
  `app/src/shared/galaxy/planets.test.ts`, `app/src/client/input/controls.ts`,
  `app/src/client/input/controls.test.ts`, `app/src/client/state/regime.test.ts`,
  `app/src/server/shard/shard.regime.test.ts`, `app/src/server/shard/shard.ts`
  (prettier only). Prior commits: `4af7d22` (wip), `2436597` (full implementation).
- No dev server was started.
- Targeted suite PASSES: `npx vitest run src/shared/regime.test.ts
  src/shared/galaxy/planets.test.ts src/client/input/controls.test.ts
  src/client/state/regime.test.ts src/server/shard/shard.regime.test.ts` → 39/39
  (ran twice, deterministic).
- `npx tsc --noEmit` clean; `npx eslint` clean on all touched files.
- FULL `npm run test`: 650 passed, 2 FAILED — both in
  `src/server/shard/shard.test.ts` > "SystemShard regime context (TASK-13 step 2,
  atmosphere)":
  1. "integrates atmosphere ships against chunk-cached terrain (O(1) heightAt)"
     (line ~392): `expect(entity.ship.pos.y).toBeLessThan(startY)` — ship spawns at
     (40, ground+150, 40) but the planet anchor (planetAnchor(0) in
     src/shared/galaxy/planets.ts) is (10000, 0); the new `resolveRegime` in the
     shard tick (src/server/shard/shard.ts:641) resolves d≈10000 ≥ exit radius →
     regime flips to 'space' → space physics (no gravity) → ship coasts at startY.
  2. "VTOL lift (action: vtol) settles a ship on the pad" (line ~432):
     `expected 25 to be less than 0.5` — the pad is in chunk (0,0), ~10 km from the
     anchor → same space-resolution problem: no gravity/VTOL/clamp, ship drifts at
     constant vel.y=-5, `onPad` never set (findPad requires atmosphere/surface).
  Both breaks are caused by the TASK-25 tick change meeting old fixtures, not by a
  regime-machine bug.

## Next steps
1. Fix the 2 fixtures in `app/src/server/shard/shard.test.ts` so the ships start
   INSIDE the atmosphere (d < 1000 u of anchor (10000, 0)):
   - Test 1: spawn at anchor-relative (10040, startY, 40) — d at spawn ≈ 155 < 1000
     and the fall keeps d shrinking. Probe TerrainContext at (10040, 40) exactly as
     before for startY/ground.
   - Test 2: pads come from the cached chunk neighborhood; chunk =
     CHUNK_SIZE × CELL_SIZE_M = 64×5 = 320 m, so anchor 10000 m is chunk (31, 0).
     Call `terrain.update(10000, 0)` (or a nearby point), pick the pad from
     `terrain.pads()` closest to (10000, 0), and spawn at
     (pad.x, ground+10, pad.z) — inside the atmosphere. Keep the existing two-phase
     input script and the `regime === 'docked'` snapshot assertion (works once the
     ship is in the atmosphere).
2. Re-run FULL `npm run test` — everything else passed in this iteration (flight.test.
   ts golden fixtures and schemas.test.ts strict fixtures are green).
3. OPTIONAL (spec step 3 "client" wiring, from the previous handoff): in
   `app/src/client/main.tsx` create RegimeTracker + ControlsRemapper,
   `tracker.setPlanets(systemRegimePlanets(systemForId(seed, systemId).planets))`
   when systemId is known, feed entity_update payloads whose entity callsign ===
   session.callsign into `tracker.applyServer(entity.flightRegime, ...)`, and
   `tracker` onRegimeChange → `remapper.setRegime`. Not required by the acceptance
   criteria (step 3 names only the controls.ts module, which exists + is tested);
   skip if time-pressed.
4. Bookkeeping: `.ralph/tasks.json` — TASK-25 `passes: true` + all 4 steps `pass:
   true`; `.ralph/logs/LOG.md` entry (newest on top); `.ralph/STRUCTURE.md` add:
   `src/shared/regime.ts`, `src/shared/galaxy/planets.ts`, `src/client/input/
   controls.ts`, `src/client/state/regime.ts` (no test files). No UI/render surface →
   e2e skippable per rules (unit covers functionality).
5. Delete `.ralph/handoff/TASK-25.md` in the final commit. Final commit:
   `feat(TASK-25): regime manager — seamless space/atmosphere/surface transitions`.

## Dead ends
- The `['space']` integration failure was NOT the regime machine and NOT tick math —
  it was quaternion argument order in the test (see Done).
- Do NOT script the atmosphere climb via thrust inputs: integrateShip's atmosphere
  branch has no thrust term; VTOL_LIFT === GRAVITY (hover only). Any climb must be a
  scripted state change (velocity impulse) until a future VTOL task adds lift.
- A small kick (200–400 u/s) does NOT exit the atmosphere: quadratic drag (k=0.0447
  for scout) with the altitude ramp caps the max ballistic climb at ~330–400 u for
  v0 up to ~4000 (drag-dominated: v(h) ≈ v0·e^(−2.235e-5·h²); worst-case exit needs
  ~470 u above flat terrain at the entry boundary). 4000 u/s clears every landing
  spot. 4000 u/s → 200 u/tick → 100 substeps/tick — cheap.
- Do NOT "fix" the 2 shard.test.ts failures by widening the enter radius or skipping
  resolveRegime — that breaks the actual regime manager contract.
- (Previous iteration) Do NOT make `regimeFor` velocity-dependent via a new REQUIRED
  param — the 4th `speed` param is optional (default 0) by contract.

## How to verify
- `cd app && npx vitest run src/shared/regime.test.ts src/shared/galaxy/planets.test.ts
  src/client/input/controls.test.ts src/client/state/regime.test.ts
  src/server/shard/shard.regime.test.ts` → 39/39 (deterministic).
- `cd app && npx tsc --noEmit` and `npx eslint` on touched files → clean.
- `cd app && npm run test` → all 73 files / 653 tests green before marking TASK-25
  done (currently 2 failures, see Working tree).
