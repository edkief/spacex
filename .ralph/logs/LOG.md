# Project Build Log

`Current Status`
=================
**Last Updated:** 2026-10-17 17:20

**Tasks Completed:** 17 of 71
**Current Task:** TASK-20 Complete

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
