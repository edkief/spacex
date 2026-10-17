# Project Build Log

`Current Status`
=================
**Last Updated:** 2026-10-17 18:15

**Tasks Completed:** 21 of 71
**Current Task:** TASK-23 Complete

### 2026-10-17 — Iteration 23
- **TASK-23** Ship damage model: hull, shields, dock repair → **DONE**
  - **Shared damage math** — `app/src/shared/physics/damage.ts` (~210 lines + ~430-line test file). Pure `applyDamage({target, classId, amount, source}) → {shieldHit, hullHit, destroyed, newShields, newHull}`. Shields absorb first; overflow chips hull; hull below zero marks destroyed. Non-positive / NaN / Infinity damage is a no-op (except `destroyed: true` on pre-dead entities — the double-destroy guard). `repairCost(current, classId)` implements `ceil((1 - hull/maxHull)*10) + ceil((1 - shields/maxShields)*5)` for the dock UI / route. `DamageSource = {kind:'player'|'ai', id}` so HUDs and analytics can attribute hits.
  - **Wire schema** — `app/src/shared/protocol/schemas.ts`. `CombatEventSchema` is now a `z.discriminatedUnion("kind", […])` carrying four variants: `hit` (TASK-42), `kill` (TASK-42), `damaged` (TASK-23: `{target, source, amount, shieldHit, hullHit, tick}`), `destroyed` (TASK-23: `{target, source, tick}`). New `ProtocolCombatEvent` type export.
  - **Sim combat pipeline** — `app/src/server/shard/combat.ts`. `applyCombatDamage(shard, {targetId, amount, source, tick, nowMs?})` is the single entry point weapons (TASK-43) and environmental hazards (TASK-48) call when a hit lands. Mutates the entity's HP in place; on destruction spawns a wreck entity at the destroyed ship's final position + orientation; broadcasts the `damaged` and (if applicable) `destroyed` combat_event to every connection. `cleanupExpiredWrecks(shard, nowMs)` removes wrecks whose `wreckExpiresAt` has passed. `broadcastCombatEvent` is the public one-off broadcast helper.
  - **Wreck entity** — `app/src/server/shard/entity.ts`. New `makeWreckEntity({id, classId, pos, quat, wreckExpiresAt})` factory + `makeWreckId(sourceEntityId)` (`wreck:<id>`). `SimEntity.wreckExpiresAt?: number` field added in `types.ts`. `WRECK_TTL_S = 600` exported constant.
  - **Sim loop integration** — `app/src/server/shard/sim.ts`. (1) Player entities with `hull <= 0` are skipped by `integrateEntity` (acceptance: "destroyed ships ignore inputs" + "doesn't stop integrating" — verified in `combat.test.ts`). (2) `cleanupExpiredWrecks(shard, Date.now())` runs once per tick after the integration step. (3) The wreck entity stays in the registry for broadcast so other clients can render the impostor (TASK-49 owns the impostor visual).
  - **Atomic repair transaction** — `app/src/server/db/{repo,repo.sqlite.world,repo.pg.world}.ts`. New `repo.repairShip({playerId, shipId, cost, maxHull, maxShields}): Promise<ShipRow>` opens its own `BEGIN ... COMMIT`:
      1. Loads the ship and verifies `ownerId === playerId` (else `NotFoundError`).
      2. Verifies `state === 'docked'` (else `NotDockedError`).
      3. Withdraws `cost` credits via the compare-and-swap credit helper (else `InsufficientCreditsError`).
      4. Updates `hull = maxHull`, `shields = maxShields`.
      5. Returns the post-repair row.
    Cost of 0 (fully repaired ship) skips the withdraw step so the `assertPositiveInt` invariant in `withdrawCredits` doesn't reject the 0.
  - **Repair route** — `app/src/server/routes/repair.ts` (~150 lines + ~340-line test file). `POST /api/ships/repair` (auth via bearer token). Body accepts an optional `{ shipId }` (defaults to the player's profile shipId). Response: `{ship, class, cost, newBalance}`. Error codes mirror the buy endpoint family: `unauthenticated` (401), `not-docked` (409), `insufficient-credits` (422), `ship-not-found` (404). Registered in `app/src/server/server.ts` alongside the ships route.
  - **Acceptance criteria checklist:**
      - `src/shared/physics/damage.ts` exports `applyDamage` with shield-first + boundary cases → ✅ `damage.test.ts` covers exact-boundary (amount == S, amount == S+1, amount == S+H, overkill, NaN, Infinity, shield > max).
      - `combat_event` wire event for damage + destroyed → ✅ `combat.ts` broadcasts via `shard.send(connId, {type:"combat_event", payload})`; verified in `combat.test.ts` that two connections receive identical events.
      - Destroyed ship stops integrating + ignores inputs + spawns wreck entity with ttl 600 s → ✅ `combat.test.ts` ("a destroyed ship does not integrate on subsequent ticks" + "a second applyCombatDamage on a destroyed target is a no-op" + "removes wrecks older than WRECK_TTL_MS").
      - `POST /api/ships/repair` auth + docked + cost = ceil((1 - hull/maxHull)*10) + ceil((1 - shields/maxShields)*5) + atomic withdraw + restore → ✅ `repair.test.ts` covers each class + edge cases + transaction rollback.
      - Unit tests for shield-first ordering + boundary + double-destroy guard + destroyed ships ignore inputs + repair cost table + repair transaction rollback → ✅ all in `damage.test.ts` (31 cases), `combat.test.ts` (17 cases), `repair.test.ts` (11 cases).
      - `npm run test` green → ✅ 850/850 (31 new from damage, 17 new from combat, 11 new from repair = +59 vs prior 791).
  - **E2E:** existing playwright scaffold spec passes (`tests/e2e/scaffold.spec.ts`); no UI changes for TASK-23 — task is server-only. Screenshot saved to `.ralph/screenshots/TASK-23-1.png` (scaffold shell — actual damage HUD is TASK-50).

### 2026-10-17 — Iteration 22
- **TASK-14** Client prediction + server reconciliation → **DONE**
  - New module `app/src/client/net/prediction.ts` (~660 lines + 600-line test file) implements the client-side prediction + reconciliation + remote interpolation that lets local input feel lag-free under ~150 ms simulated RTT.

### 2026-10-17 — Iteration 22
- **TASK-14** Client prediction + server reconciliation → **DONE**
  - New module `app/src/client/net/prediction.ts` (~660 lines + 600-line test file) implements the client-side prediction + reconciliation + remote interpolation that lets local input feel lag-free under ~150 ms simulated RTT.
  - **`ClientShipPredictor`** — pure class with a `now` parameter so tests can drive it with a virtual clock.
    - `step({now, thrust, turn, pitch, yaw, dt})` stamps a monotonic `seq`, queues the input for delivery to the server, and integrates the local state by calling the same `integrateShip` the server uses (`@shared/physics/flight`). Zero perceptible lag.
    - `reconcile({now, serverState, lastAppliedSeq})` compares the server state to the predicted state:
      - Within `MAX_BLEND_POS_U = 5 u` and `MAX_BLEND_ANGLE_RAD = 0.2 rad` → **blend** (gentle skew toward server, then drain unacked inputs).
      - Outside tolerance → **rewind**: copy server state, replay the queued unacked inputs to catch up.
      - Queue age > `MAX_QUEUED_SECONDS = 10 s` → **force-snap** with a `FORCE_SNAP_BLEND_MS = 100` ms blend overlay (no visible teleport).
    - `forceSnap({now, serverState})` for hard resyncs (TASK-17).
    - `pendingInputs()` for the WS layer to flush. `stats()` for the debug HUD (TASK-57) — max correction, blend/rewind/force-snap counts.
  - **`RemoteEntityBuffer`** — per-remote ring buffer (`REMOTE_BUFFER_CAPACITY = 16` entries, ~1.6 s at 10 Hz).
    - `push(tMs, state)` records one snapshot; the buffer auto-sorts by `tMs` and trims oldest.
    - `sample(now)` renders at `now - INTERP_DELAY_MS = 200 ms` by `vecLerp` + `quatSlerp` between bracketing snapshots.
    - Underrun (target precedes oldest snapshot) returns the oldest snapshot with `stale: true` — no teleporting.
    - Forward render time clamps to newest with `stale: true` if `now - newest > REMOTE_STALE_MS = 1000`.
  - **`applyEntityUpdateToBuffer`** — pure helper for the WS layer: walks an `entity_update` frame, skips `ownEntityId`, and pushes each remote into its `RemoteEntityBuffer`. Returns a new `Map`.
  - **`simEntityFromWire`** — wire `EntityState` → `SimEntityLite` (trimmed view used by the predictor and renderer; defaults `quat` to identity since the wire shape omits rotation).
  - **`localInputToShipInput`** — same mapping the server uses (`turn → yaw`, `pitch → pitch`, `yaw → roll`, `up = 0`). Centralised so test cases agree with the live wire.
  - **Tuning constants** exported as named exports so the renderer (TASK-26+) and tests can import them verbatim: `INTERP_DELAY_MS`, `MAX_BLEND_POS_U`, `MAX_BLEND_ANGLE_RAD`, `MAX_QUEUED_INPUTS`, `MAX_QUEUED_SECONDS`, `FORCE_SNAP_BLEND_MS`, `REMOTE_STALE_MS`, `REMOTE_BUFFER_CAPACITY`.
  - **Acceptance criteria checklist:**
    - `src/client/net/prediction.ts` on each local input → ✅ `step()` stamps `seq`, queues, calls `integrateShip` with the render frame `dt`.
    - Snapshot arrival: compare + blend/rewind on distance + angle thresholds → ✅ `reconcile()` with `MAX_BLEND_POS_U = 5`, `MAX_BLEND_ANGLE_RAD = 0.2`.
    - Remote entities: 200 ms interpolation buffer + lerp/slerp + stale > 1 s → ✅ `RemoteEntityBuffer` with `INTERP_DELAY_MS`, `vecLerp`, `quatSlerp`, `REMOTE_STALE_MS`.
    - 150 ms RTT, constant thrust, max correction < 5 u after 2 s → ✅ dedicated "150 ms RTT + constant thrust" test case with 3 s simulated run (asserts every correction event after the first 2 s is < 5 u).
    - Jittery 10 Hz ± 20 ms produces no visible jumps → ✅ dedicated "snapshot jitter at 10 Hz ± 20 ms" test (max per-frame delta < 3 u).
    - `npm run test` green → ✅ 791/791 (28 new from TASK-14 + 2 new from TASK-13 lastAppliedSeq update).
    - Playwright smoke → ✅ `tests/e2e/prediction.spec.ts` (2 cases): bundle imports cleanly, console clean, local ship integrates forward 5 s, remote buffer lerps jittery snapshots, blend/rewind outcomes match the unit suite.
  - **Server-side plumbing (TASK-14 step 2):**
    - `app/src/shared/protocol/schemas.ts` — `EntityUpdateSchema` now requires `lastAppliedSeq: Record<playerId, seq>`. Backward-compatible note: the field was previously absent; pre-TASK-14 builds won't validate against the new schema (acceptable since the field is required and we're pre-release).
    - `app/src/shared/protocol/schemas.test.ts` — happy + invalid fixtures updated.
    - `app/src/server/shard/types.ts` — `SnapshotBroadcaster` signature gains a third arg `lastAppliedSeq: Readonly<Record<string, number>>`.
    - `app/src/server/shard/sim.ts` — `SimLoop` tracks a cumulative `lastAppliedSeq` map per player (high-water mark, never shrinks). Updated on every `runOneStep` when an integration happens. Passed to broadcast every snapshot tick.
    - `app/src/server/shard/index.ts` — `sendEntityUpdate` includes `lastAppliedSeq` in the outgoing payload.
    - `app/src/server/shard/sim.test.ts` — 2 new cases: (a) three player inputs flushed → next snapshot carries `lastAppliedSeq["p-1"] === 3`; (b) AI-only frames carry an empty `lastAppliedSeq` map. Test recorder signature updated for the new broadcast arg.
  - **Shared helper (used by the predictor's `RemoteEntityBuffer`):**
    - `app/src/shared/physics/vec.ts` — added `quatSlerp(a, b, t)`. Short-arc path (flips `b` when their dot product is negative), `acos` pole fallback to normalized lerp for nearly-parallel quaternions, `t` clamped to `[0, 1]`.
    - `app/src/shared/physics/vec.test.ts` — 5 new cases: clamp outside `[0, 1]`, exact endpoints, half-rotation accuracy, short-arc selection, near-parallel fallback.
  - **E2E (`tests/e2e/prediction.spec.ts`, 2 cases):**
    - `prediction module imports and basic flows work` — boots the app, hits `/api/health`, runs an in-page integration smoke (5 s constant thrust at 60 Hz produces `pos > 50 u`), captures the per-task screenshot, fails loudly on console errors.
    - `prediction module unit smoke (Node)` — exercises `ClientShipPredictor` end-to-end (5 s integration → far rewind → close blend → remote buffer lerp) directly in the test runner so the smoke doesn't depend on the TS source being bundled.
  - **Run results:** `npx vitest run` → 791/791 passing (28 new from TASK-14, 2 new from TASK-13 shard update). `npx tsc --noEmit` clean. `npx eslint .` + `prettier --check .` clean. `npx playwright test` → 4/4 passing. Screenshot saved to `.ralph/screenshots/TASK-14-1.png` (scaffold shell — actual three.js rendering is gated on TASK-26+).

### 2026-10-17 — Iteration 21
- **TASK-13** Server sim: 20 Hz tick with 10 Hz snapshots → **DONE**
  - New module `app/src/server/shard/` (~900 lines + 220-line test file) implements the authoritative sim loop for one star system. The router will compose one shard per active system (TASK-11); for TASK-13 the sim runs against a test-only single shard.
  - **Public surface (`shard/index.ts`):**
    - `createShard({systemId, context, send, broadcast, onTickObserver?, persist?, autoStart?})` — builds the container, wires the back-references, starts the loop. Transport-agnostic: `send` and `broadcast` callbacks are injected by the future router.
    - `addConnection(shard, conn)` / `removeConnection(shard, connId)` — register/drop WS connections; entities survive `removeConnection` (reconnect in TASK-17).
    - `spawnShip(shard, args)` — mints a `player` entity, idempotent on id, optional `bindConnId` to atomically attach it to a connection.
    - `spawnAiShip(shard, args)` — mints an `ai` entity with full class-default HP, stub-driven by TASK-46.
    - `pushPlayerInput(shard, connId, input)` — single-line WS handler glue: validates the seq, replaces the slot, increments `staleDrops` on stale. Returns `{accepted, reason?}` so the dispatcher can ack.
    - `buildSnapshotEntities` / `broadcastSizeFor` / `sendEntityUpdate` — wire-shape helpers used by both prod and tests.
    - `simulateNTicks(shard, n)` — test-only manual driver for fast assertions.
  - **Sim loop (`shard/sim.ts`, ~330 lines):**
    - Fixed 1/20 s tick = 50 ms, `TICK_S = 1 / 20`, `MAX_CATCHUP_STEPS = 5` (anti spiral-of-death).
    - **Accumulator-based drift correction.** Wall clock drives an accumulator; while `accumulator ≥ TICK_S` and `stepsRun < 5`, integrate one tick and decrement. Excess is dropped so a stalled main loop never drags debt. First tick snapshots the wall clock without integrating (one-shot priming) so externally-counted tests observe exactly TICK_S elapsed on each subsequent call.
    - **setTimeout(0) chain** (not setInterval) for the auto-loop; yields the loop to handlers, **unref** so it never holds the process open.
    - Every 2nd tick (`SNAPSHOT_EVERY_N_TICKS = 2` → 10 Hz) the loop calls `buildSnapshot()`, invokes `shard.broadcast(tick, entities)`, and warns on payloads > 32 KB (the spec's tuning-budget flag for TASK-60).
    - **Single writer invariant.** All entity mutation happens inside `runOneStep()`. Message handlers only `enqueueInput(...)`. The shard's `connections` map carries the per-conn input slot + `lastSeq` + `staleDrops`.
    - **Player integration.** Maps the wire axes to `ShipInput` (`thrust → thrust`, `turn → yaw`, `pitch → pitch`, `yaw → roll`) and calls the shared `integrateShip(state, input, dt, regime, shipClass, planet)` from `@shared/physics/flight.js`. Reuses the deterministic flight model — no duplicate formulas.
    - **Planet context.** `resolvePlanetContext(entity, ctx)` returns a `PlanetAtmosphere` per ship for atmosphere/surface regimes; the 3×3 chunk neighbourhood cache lives at the seam for TASK-26 to plug in. v1 calls `heightAtFor(planetId)` directly per ship per tick.
    - **Per-tick histogram.** Ring buffer (default 1024 samples) with O(n) p50/p95/p99; exposed via `shard.stats()`.
  - **Input queue (`shard/input-queue.ts`):** Strict seq protection + latest-input-wins.
    - First input for a connection must have `seq === 1` (cold-start guard); subsequent inputs require `seq > lastSeq`. Stale frames increment `staleDrops` and are silently dropped at debug level via the shard's `EventEmitter('input-debug')`.
    - Drained once per tick by `runOneStep`. Only one input is integrated per player per tick (the latest one).
  - **Histograms (`shard/histogram.ts`):** 60-line ring-buffer with `push` / `snapshot` / `pick(quantile)`. Rejects negative/non-finite samples.
  - **Entity helpers (`shard/entity.ts`):** `makeEntityId(shipId)` → `entity:shipId`, idempotent; `makePlayerEntity({…})` / `makeAiEntity({…})`; `entityToWire(e)` centralises the `EntityStateSchema` (`@shared/protocol`) serialization so the broadcast loop and tests share one shape.
  - **Types (`shard/types.ts`):** full contract — `Shard`, `ShardConnection`, `PlayerInput`, `SimEntity`, `SpawnedShip`, `ShardSystemContext`, `SimTickObserver`, `SimTickStats`, `ConnSender`, `SnapshotBroadcaster`, `DirtyMarker`.
  - **Tests (`shard/sim.test.ts`, 16 cases, all passing — 756 total project-wide):**
    - **Accumulator math over 1000 ticks → exactly 1000 logical ticks, no drift.** Fake `hooks.clock`; asserts every `tick()` returns `stepsRun === 1` across the run.
    - **Catch-up ceiling.** Stall the wall clock by 50 ticks; next `tick()` runs exactly 5 steps and resets the accumulator (no spiral-of-death).
    - **10 Hz cadence.** 20 ticks → snapshots at tick 2, 4, …, 20 and never at 1, 3, … (explicit array equality).
    - **Latest-input-wins.** Two accepted inputs → next tick integrates only the LATEST (verified via post-tick velocity delta: `vel.z` increases after `thrust=0.9` replaces `thrust=0.1`).
    - **Stale-seq dropped.** `seq=1` accepted, then `seq=1` again dropped, then `seq=0` dropped; connection's `lastSeq` and `staleDrops` updated correctly; pending slot holds the latest-accepted input only.
    - **Cold-start seq guard.** First input with `seq=2` is dropped as stale (preventing reconnect spoofing).
    - **Broadcast payload shape.** `entity_update` carries `id / kind / pos / vel / regime / hull / shields / targetId / classId / callsign / livery`; first broadcast at tick 2 with the configured hull/shields/classId.
    - **32 KB warning gate.** 400 ships → broadcast > 32 KB verified by raw `JSON.stringify(entities).byteLength`.
    - **Entity kind mapping.** `player → ship`, `ai → ai-ship` in the wire snapshot.
    - **Remove connection keeps entity** (reconnect can re-bind).
    - **Histogram math.** Uniform distribution over [0, 999] ms asserts p50 ≈ 500, p95 ≈ 950, p99 ≈ 990. NaN/Infinity/negative samples rejected; `rejectedCount` increments.
    - **Benchmark (16 ships, 60 s simulated)** — runs 1200 ticks over 8 player ships (with fresh inputs on rotation) + 8 AI ships; asserts `tickCount === 1200`, `entityCount === 16`, broadcast count = 600 (every 2nd tick), and `histogram.p95 < 30 ms`. Console-logged numbers: `p50`, `p95`, `p99`, `max`.
    - **Protocol constants sanity** — `SNAPSHOT_EVERY_N_TICKS = 2`, `SERVER_TICK_HZ = 20`, `PROTOCOL_VERSION = 1`.
  - **Acceptance criteria checklist:**
    - `src/server/shard/sim.ts` runs fixed 1/20 s tick with accumulator + 5-step catch-up ceiling → ✅ `runOneStep`, `tick()`, `MAX_CATCHUP_STEPS`.
    - Each tick drains the per-conn slot, calls `integrateShip` (TASK-22) → ✅ `runOneStep`.
    - Every 2nd tick broadcast `entity_update` with hull/shields/target → ✅ `SNAPSHOT_EVERY_N_TICKS`, `entityToWire`.
    - Per-tick histogram + p95 < 30 ms budget → ✅ `TickHistogram`, benchmark case.
    - Stale seq drop with debug logging → ✅ `enqueueInput`, `staleDrops`, `input-debug` event.
    - Tests cover accumulator math / latest-wins / stale-seq / cadence / benchmark → ✅ 16 cases.
    - `npm run test` green → ✅ 756/756.
  - 756 vitest cases pass (`npm run test` clean), 16 new from TASK-13. `npm run typecheck`, `npm run lint`, `npm run lint:fix` all clean.

### 2026-10-17 — Iteration 20
- **TASK-21** Persistent ship livery customization → **DONE**
  - Endpoint: new `POST /api/ships/livery` in `app/src/server/routes/ships.ts` (auth required). Body shape: `{ colors: { primary, secondary, accent } }`. Each color validated by the same `LiverySchema` zod shape used by the WS protocol so REST + WS agree on what valid paint looks like. Strict envelope (no extra keys). Must be docked (422 `must-be-docked` if mid-flight, mirroring the buy endpoint's dock requirement). Returns `{ ship, class }` — the updated ship row + catalog stats — same wire shape as `GET /api/ships`.
  - Validation paths: `400 invalid-payload` (empty body, missing `colors`, unknown top-level keys); `400 invalid-livery` (bad hex string — six-digit regex `^#[0-9a-fA-F]{6}$` enforced for all three slots, missing slot, partial payload).
  - Persistence: `saveShipState({ livery })` re-validates with `ShipLiverySchema`; the JSON column round-trips cleanly.
  - Broadcast: extended `app/src/server/shards/event-bus.ts` with a new `LiveryChanged` event (`{ playerId, shipId, livery, systemId }`). The route publishes on success via `getShardsBus().publishLiveryChanged(...)` (nextTick-async, listener-isolated, never fails the response). The future TASK-11 shard will subscribe and emit `entity_update` with the new livery so remote clients re-paint without a full snapshot.
  - Client paint model: new `app/src/client/ships/ShipMeshBuilder.ts` (~270 lines) defines the paint-zone model (hull / accent / trim) and `ShipPaintRegistry`:
    - `buildShipMesh(shipId, classId)` creates 3 paint materials, one per zone, initialised with `defaultLiveryFor(classId)`.
    - `applyLivery(shipId, livery)` swaps colors **in place** — no mesh rebuild, no allocation in the hot path. Idempotent (zones whose color didn't change are skipped).
    - `disposeShip` / `disposeAll` are idempotent; materials freed through the adapter.
  - Pure-logic seam: `MaterialAdapter` interface decouples the paint logic from three.js. The registry is unit-tested under Node using the in-memory adapter (no GPU). The renderer supplies a real three.js adapter via `createThreeMaterialAdapter(MeshStandardMaterial)` in `app/src/client/ships/threeAdapter.ts` — the adapter mutates `Color` instances in place to stay within the frame budget.
  - `defaultLiveryFor(classId)` reads the canonical default from `@shared/ships`; future per-class schemes can branch on `classId` without changing consumers.
  - Tests: 35 new cases (740 total → up from 705):
    - `app/src/client/ships/ShipMeshBuilder.test.ts` (24 cases): paint-zone enumeration, default livery per class, livery-to-zones mapping, idempotent build, in-place `applyLivery` (zero reallocations, `setCalls` counter), skip-when-unchanged, throw on unknown shipId, partial updates touch only changed zones, `disposeShip`/`disposeAll` idempotency, multi-ship paint isolation, in-memory adapter counter behavior.
    - `app/src/server/routes/ships.test.ts` (11 new cases in a new `POST /api/ships/livery` describe): happy path persists + returns updated ship, 401 missing/tampered token, 400 empty body, 400 missing color slot, 400 unknown top-level key, 400 six different malformed hex strings rejected, upper- and lower-case hex both accepted (no CSS names), 422 `must-be-docked` mid-flight, `livery-changed` event observed on the shards bus, fake-shard wire-shape (`entity_update` envelope payload), DB round-trip (server-restart simulation), repeated paints overwrite.
  - New e2e: `app/tests/e2e/livery.spec.ts` — claim → set livery → re-read ship → assert colors stuck → also exercises the invalid-hex 400 path. Captures a UI screenshot to `.ralph/screenshots/TASK-21-1.png`.
  - Smoke verified end-to-end via `npm run dev` (Fastify on `:3001`):
    - `POST /api/callsigns LIVERY-SMOKE` → 200, token + starter ship.
    - `POST /api/ships/livery { colors: {primary:"#ff8800", secondary:"#222244", accent:"#ffff00"} }` → 200 with the new colors echoed in the response.
    - `GET /api/ships` with the same token → 200, `livery` matches the painted triple (persistence confirmed across the read-back).
    - `POST /api/ships/livery { colors: {primary:"blue", ...} }` → 400 `invalid-livery` with the zod regex message.
    - `POST /api/ships/livery` without a token → 401 `unauthenticated`.
  - 740 vitest cases pass (`npm test` clean), 35 new from TASK-21. `npm run typecheck`, `npm run lint`, `npm run lint:fix`, both Playwright specs (scaffold + livery) all clean.

### 2026-10-17 — Iteration 19
- **TASK-20** Ship acquisition: starter ship + dock purchase → **DONE**
  - Extended `app/src/shared/ships.ts` with a `ShipClassIdSchema` (zod enum of `SHIP_CLASS_IDS`) so the buy endpoint can validate inbound class ids against the same source-of-truth catalog the rest of the codebase already imports.
  - Extended `app/src/server/db/repo.ts`:
    - New typed errors `NotDockedError` (player is mid-flight) and `AlreadyOwnedShipError` (owning the same class) — exported alongside the existing `InsufficientCreditsError` / `NotFoundError` so the route can branch on `instanceof`.
    - New `SqliteRepositoryTransaction extends ShipReplacementHandle` so the in-transaction `replaceOwnedShip` helper is part of the same handle the credit helpers live on.
    - New `purchaseShip(input)` method on the `Repository` interface, documented against the four required error mappings (InsufficientCreditsError → 422, NotDockedError / AlreadyOwnedShipError → 409, NotFoundError → 404). Initial `hull`, `shields`, `livery`, `price` are passed in by the route so the catalog (in `@shared/ships`) stays the single source of truth.
  - SQLite implementation:
    - New `sqliteReplaceShip` helper in `app/src/server/db/repo.sqlite.world.credits.ts` does the actual `DELETE FROM ships WHERE owner_id = ?` (cascade-deletes cargo) + `INSERT INTO ships (...) VALUES (...)` + row re-read, all inside the caller's transaction. The new ship inherits the home-system origin position, zero velocity, and the supplied livery.
    - `bindSqliteWorld.purchaseShip` opens a single `db.transaction(...)` for validate → withdraw (compare-and-swap via `sqliteWithdrawSync`) → replace, and re-throws the typed errors so the route can map them. Wrapped in a `new Promise(..., reject)` so synchronous throws become promise rejections.
    - The `runInTransaction` handle now exposes `replaceOwnedShip` as a convenience for tests.
  - Postgres implementation (`repo.pg.world.ts`): a `pgSchema`-typed transactional counterpart using the same `BEGIN ... COMMIT` semantics, with the compare-and-swap credit UPDATE re-checked after a zero-row write so the route can distinguish "not enough credits" from "unknown player". (Live PG parity is deferred to CI per TASK-1.)
  - New `app/src/server/shards/event-bus.ts` (~110 lines): a typed `ShardsBus` singleton built on Node's `EventEmitter`. Exports `ShardEvents.ShipSwapped`, `getShardsBus()` (lazily-constructed singleton), and `resetShardsBus()` (for tests). Publisher wraps emit in `process.nextTick` so listener throws cannot break the buy endpoint; listener errors route through the standard `error` channel.
  - New `app/src/server/routes/ships.ts`:
    - `GET /api/ships` (auth): returns `{ ship, class }` — `listShipsByOwner(playerId)` joined with the catalog entry from `@shared/ships.js`. The `class` payload exposes every stat the dock UI / ship HUD needs in one round-trip.
    - `POST /api/ships/buy { classId }` (auth): validates the bearer, parses the body with `ShipClassIdSchema.safeParse`, looks up the catalog price + stats, calls `repo.purchaseShip(...)`, maps the four typed errors to the spec'd HTTP codes, then publishes `ship-swapped` on the shards bus AFTER the transaction commits. Wired into `buildApp()` alongside the existing callsign + players routes.
  - Tests (25 new cases, 705 total → up from 680):
    - `app/src/server/db/repo.purchase.test.ts` (9 cases): happy paths (scout→interceptor with cargo scrub; scout→freighter); error paths (NotDockedError / InsufficientCreditsError / AlreadyOwnedShipError / NotFoundError); atomicity (rejected buy leaves balance + ship row untouched, including a dedicated case for the credit-failure rollback path).
    - `app/src/server/routes/ships.test.ts` (16 cases): starter-on-claim docked at home system with full stats; buy for each class with sufficient credits; 400 unknown-class; 409 not-docked (mid-flight); 409 already-owned; 422 insufficient-credits; 401 missing/tampered token; event-bus fires on every successful buy; a fake shard can subscribe on `ShipSwapped` and produce a wire-shape `entity_update` envelope; atomicity (mid-transaction throw rolls back the credit withdraw).
  - 705 vitest cases pass (`npm test` clean), 25 new from TASK-20. `npm run typecheck`, `npm run lint`, `npm run lint:fix` all clean. TASK-20 is `functional` (no UI surface for v1) → no Playwright smoke needed.
  - Smoke verified end-to-end via `npm run dev` (Fastify on `:3001`, Vite proxy on `:3000`):
    - `POST /api/callsigns DELTA-ONE` → 200 with the bearer token.
    - `GET /api/ships` with the token → 200, `{ ship: {…, classId: "scout", hull: 100, shields: 100, state: "docked"}, class: {…, price: 0} }`.
    - `POST /api/ships/buy { classId: "interceptor" }` (500 credits < 2500) → 422 `insufficient-credits`.
    - `POST /api/ships/buy { classId: "destroyer" }` → 400 `unknown-class`.

### 2026-10-17 — Iteration 18
- **TASK-22** Shared flight model: space, atmosphere, VTOL (deterministic) → **DONE**
  - New `app/src/shared/physics/vec.ts` (~270 lines, zero deps):
    - `Vec3` and `Quat` plain-object types with frozen `ZERO / X_AXIS / Y_AXIS / Z_AXIS / IDENTITY` constants.
    - Vec3 ops: `vecAdd / vecSub / vecScale / vecDot / vecCross / vecLength / vecLengthSq / vecNormalize / vecLerp / vecEquals / vecMin / vecMax / vecClamp`. All pure, no mutation.
    - Quat ops: `quatFromAxisAngle / quatFromEuler / quatMul / quatNormalize / quatRotateVector / quatToMat3 / quatLength / quatLengthSq`. The optimised `quatRotateVector` uses the `v + 2 q_w (q_v × v) + 2 (q_v × (q_v × v))` form (one quaternion-vector multiply equivalent).
    - Convention: yaw (world +Y) → pitch (body +X) → roll (body +Z), intrinsic; `quatFromEuler` returns the normalised result so compound rotations don't drift.
  - New `app/src/shared/physics/atmosphere.ts` (~150 lines, zero deps):
    - `PlanetAtmosphere` interface (id, radius, atmosphereHeight, atmosphereDensity, hasAtmosphere, heightAt callback, optional pads).
    - `boundaryFactor(altitude, planet)` returns the continuous 0..1 ramp over `BOUNDARY_RAMP_WIDTH_M = 1000 m` (1 km band) per spec; 0 above the band, 1 at the surface, linear in between. Same function reused by TASK-28.
    - `dragCoefficient(altitude, planet, mass, area = 1)` returns `planet.atmosphereDensity * (mass / area) * boundaryFactor(altitude)` per spec AC.

[427 more lines. Use offset to continue.]
