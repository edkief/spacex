# Project Build Log

`Current Status`
=================
**Last Updated:** 2026-10-17 17:28

**Tasks Completed:** 18 of 71
**Current Task:** TASK-21 Complete

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
