# Project Build Log 

`Current Status`
=================
**Last Updated:** 2026-09-29
**Tasks Completed:** 10
**Current Task:** TASK-9 Complete

----------------------------------------------

## Session Log

### 2026-09-29 — TASK-9: WS protocol — typed versioned message schema + handshake
Defined the full client↔server WebSocket protocol and its server-side lifecycle (PRD §TASK-9):
- `app/src/shared/protocol/schemas.ts` — one zod schema per message type in the `messageSchemas` registry (all 23 types: hello, auth, join_system, enter_system, state_snapshot, entity_update, chat, input, warp, interact, mine, sell, buy_ship, set_livery, exit_ship, enter_ship, repair, error, ping, pong, presence, target_update, combat_event). Shared shapes: `EntityState` (one shape for all snapshot traffic: id/kind/pos/vel/regime/hull/shields/targetId/classId/callsign?/livery?), `StateSnapshot` (systemId, entities, nodes, chat ≤100, players), `Vec3`, `Livery`, `ChatMessage`, `PresenceEntry`. All numbers `finite()`-checked.
- `app/src/shared/protocol.ts` — `PROTOCOL_VERSION = 1`, `Envelope {v, type, payload}`, JSON `encodeMessage`/`decodeMessage` (never throws), `parseMessage(type, payload)` returning typed payload or `{code:'invalid-message'|'unknown-type', message}` with the first failing path; `PROTOCOL_ERRORS` (the seven structured codes), `PING_INTERVAL_MS=15s`, `DROP_AFTER_MS=45s`, `UNKNOWN_TYPE_DROP_LIMIT=10`.
- `app/src/server/ws.ts` — `attachWebSocket(fastify, {path, gateway, authenticate?, onGameMessage?, keepalive?})`: per-connection state machine hello → auth → join_system (out-of-order → structured error), per-connection async handler queue so hello/auth/join never interleave, dispatch by type with system-scoped gating, unknown-type counter → terminate at 10, presence join/leave broadcast to in-system peers, 15 s ping / 45 s silence-drop keepalive (intervals injectable for tests). `SystemGateway` seam for shards; `createRegistryGateway(repo)` resolves ids against system_registry (unknown → system-not-found, empty snapshot until TASK-12 shards exist); `devAuthenticate` placeholder until TASK-10.
- `app/src/server/index.ts` — rewired to `attachWebSocket` with the registry gateway (replaces the old `welcome` stub); `db/repo.ts` gained `findSystem`.
- Tests: `protocol.test.ts` (8) envelope round-trip/version/decode rejections + parseMessage codes; `protocol/schemas.test.ts` (51) parametrized valid+malformed table covering every registered type exactly once + finite-number and chat-cap edge cases; `ws.test.ts` (12) in-process integration — real Fastify+ws boot on an ephemeral port, full hello→auth→join flow against a canned snapshot, version-mismatch (close 1002), out-of-order, system-not-found, system-full, auth rejection, malformed-payload survival, system-scoped gating, unknown-type 9-tolerate/10-drop, presence join/leave broadcast, keepalive drop-after-silence and pong-keeps-alive.
- Smoke: `npm run dev` boot, `/api/health` 200 via :3000 proxy, live ws handshake over the proxy returns structured `system-not-found` for an unregistered system. No UI changes → Playwright e2e skipped.
- Verified: `tsc --noEmit`, `npm run lint` clean, full `npm run test` → 15 files / 196 tests all pass.

### 2026-09-29 — TASK-63: Persistence service with save points and crash recovery
Built the save-point persistence layer on top of the TASK-62 repo (PRD §8 — mutable state only survives restarts):
- `app/src/server/persist.ts` — `createPersistService({ handle, repo, options })` + `getPersistService()` singleton and module-level `saveShip(ship)` / `saveCargo(shipId, items)` / `saveNodeStates(systemId, states)` / `loadSystemState(systemId)` wrappers. Dirty-set + ship-snapshot cache; milestone tracker per ship. Save points: `onDock(ship)`, `onDamage(ship)` (saves only on downward crossings of HULL_MILESTONES [75,50,25] since last persisted hull), `saveDirty()` on a 5 s interval timer (default 5000 ms, unref'd, injectable `intervalMs`), `onShardShutdown(systemId, nodeStates?)`. All multi-row writes are one transaction per save point: postgres via drizzle async tx; sqlite via manual BEGIN/COMMIT/ROLLBACK on the single better-sqlite3 connection (drizzle's sqlite tx only accepts *synchronous* callbacks while repo methods are async — documented in code). `repoForTransaction` option lets tests inject a spy factory.
- `app/src/server/db/repo.ts` — added `listShipsInSystem` (LIKE on position JSON, invariant: systemId is always the first key — documented), `listCargo(shipIds)`, `getPlayersByIds(ids)`; `loadSystemState` now returns ships + cargo + owner credits + node states.
- `app/src/server/db/client.ts` — `PRAGMA journal_mode=WAL` (task technical note: needed to keep the 5 ms write guard green).
- `app/src/server/persist-crash-child.ts` — test helper: child process that writes player/ship/cargo through the real service, prints READY, idles until SIGKILL (relative imports since tsx ignores tsconfig paths).
- Tests `persist.test.ts` (9): save points fire repository writes (spies + tx factory), dirty flag clears, interval save skips clean ships (no tx, {saved:0,ms:0}), damage-milestone sequence (baseline no-write, 75/50/25 crossings, repair no-write), batch rollback on bad cargo quantity, loadSystemState round-trip + system isolation; **crash test**: tsx child saves then gets real SIGKILL (signal asserted), parent reloads — position exact (≪100 m tol), cargo exact, credits exact; **benchmark (numbers recorded per step 4): 16 dirty ships, one interval save = 5.503 ms total, max single write 0.438 ms** (budgets: 20 ms / 5 ms).
- No UI changes → Playwright/e2e skipped (pure server logic).
- Verified: `tsc --noEmit`, `npm run lint` clean, full `npm run test` → 12 files / 124 tests all pass.

### 2026-09-29 — TASK-62: Drizzle data layer — dual-driver schema (SQLite/Postgres)
Built the persistent data layer (PRD §8: only mutable state, never geometry):
- `app/src/server/db/schema.ts` — one schema definition per dialect (sqlite-core + pg-core) for all six tables (players, ships, cargo_items, sessions, resource_node_state, system_registry) with exact PRD fields: uuid-text PKs, callsign unique, credits int default 500, JSON position/velocity/livery, ship state as text+CHECK (sqlite) / pgEnum (postgres), unique(ship_id, resource_type), nullable session system_id / node respawn_at. Timestamps are ISO strings on both drivers (pg `timestamptz mode:'string'`) so the repo is dialect-agnostic. Tables are individual consts (a single self-referencing object literal broke drizzle's type inference under TS 6 — recorded as the reason).
- `app/src/server/db/client.ts` — `createDb()`/`getDb()`: DB_DRIVER=sqlite → better-sqlite3 file at DB_PATH (mkdir -p, FK pragma, migrate on boot); postgres → pg Pool from DATABASE_URL (rejects the TODO placeholder).
- `app/src/server/db/migrate.ts` + `migrations/000000_init.sql` — sequential .sql migrator with a `_migrations` tracking table, one transaction per file, idempotent.
- `app/src/server/db/repo.ts` — single `createRepo(db, tables)` implementation over the shared query-builder surface: createPlayer, findPlayerByCallsign, getOrCreateStarterShip (idempotent), saveShipState (zod-validated JSON columns), saveCargo (ON CONFLICT upsert on the unique pair), addCredits/withdrawCredits (atomic conditional `credits >= amount` update → InsufficientCreditsError), upsertNodeState, listNodeStates (exact IN with seed-derived nodeIds, or node_id prefix for system-prefixed ids — documented), upsertSystem, full session CRUD + deleteExpiredSessions. All parameterized.
- `app/src/server/db/errors.ts` — CallsignTakenError / InsufficientCreditsError / NotFoundError (+ unique-violation sniffing).
- `env.ts` — added DATABASE_URL to the zod env schema. Deps: `pg` + `@types/pg`, `drizzle-kit` (dev).
- `app/drizzle.config.ts` — postgresql dialect for drizzle-kit DDL generation.
- Tests: `repo.test.ts` (24) — CRUD round-trip for every method against a tmp sqlite file, typed-error paths (duplicate callsign, insufficient credits, not-found), zod boundary rejections, migration apply-once/idempotent; `pg-parity.test.ts` (1) — spawns `drizzle-kit generate --dialect postgresql` into a temp dir, asserts exit 0 and all six tables in the DDL (no live PG needed). Generated DDL inspected: jsonb columns, ship_state enum, CHECK constraint, FKs, unique index all present.
- No UI changes → Playwright skipped. Dev-server boot re-verified (/api/health 200 via :3000 proxy).
- Verified: `npm run typecheck`, `npm run lint` (eslint + prettier clean), full `npm run test` → 11 files / 115 tests all pass.

### 2026-09-29 — TASK-6: Galaxy determinism verification (snapshot fixtures)
Locked the determinism contract (SC-2) with committed snapshot fixtures that must regenerate byte-stably for the dev seed:
- `app/scripts/gen-galaxy-snapshots.ts` (`npm run snapshot:update`) — regenerates the six `snapshot-*.json` fixtures in `app/src/shared/galaxy/__fixtures__/`: full star chart (dev seed, 200 stars), system of star #0, system of star #1, and chunks (0,0)/(1,0)/(0,1) of the first landable planet of star #0 (planet #0 "Torolm"). Each file wraps `{ seed, starId?, planetId?, value }` as pretty-printed **canonical JSON** (sorted keys → platform-stable); the script ends with a prettier pass so output passes `npm run lint`. Verified **idempotent** (consecutive runs → byte-identical files).
- `app/src/shared/galaxy/snapshots.test.ts` (9) — loads each fixture and deep-compares the regenerated value via `canonicalJson` (stable key order). `firstDiffPath()` walks both values and reports the first divergent path in the failure message to speed up generator-drift debugging. Mutation-detection block proves the suite catches: a flipped star spectral class (diff `0.class`), a flipped planet class (diff `planets.0.class`), and a changed heightmap sample (diff `heightmap.0`).
- `app/src/shared/canonical.test.ts` (5) — unit coverage for the canonical helper (recursive key sort, array-order preservation, insertion-order independence, number formatting, escapes/primitives).
- `app/src/shared/canonical.ts` — added an explicit `undefined → null` branch so a stray `undefined` can never emit invalid JSON.
- `__fixtures__/README.md` — states fixtures are regression guards and must ONLY be regenerated by the deliberate `npm run snapshot:update` command after an approved generator change, with a note to record the breaking seed behavior in the commit message.
- **Mutation verification (step 4, recorded):** temporarily set `PLANET_CLASS_WEIGHTS['rocky']` 32→320 in `config.ts`, ran the snapshot suite → 4 failures with diff paths (`planets.0.class`, `biome`), reverted the constant → suite green. Confirms the fixtures actually pin generator output, not just shape.
- No UI changes → Playwright/e2e skipped (pure logic, unit coverage complete).
- Verified: `tsc --noEmit`, `npm run lint` (eslint + prettier clean), full `npm run test` → 9 files / 90 tests all pass.

### 2026-09-29 — TASK-5: Surface chunk generator (terrain, nodes, landing pads)
Implemented pure, deterministic surface-chunk generation so any client can reconstruct any chunk identically:
- `app/src/shared/galaxy/noise.ts` — deterministic 2D value noise + 5-octave fBm on top of `hash2`; lattice lives in *world* cell space (`floor(world/LATTICE_CELLS)`), so neighboring chunks share boundary samples exactly; per-channel memo cache.
- `app/src/shared/galaxy/surface.ts` — `generateSurfaceChunk(seed, planet, chunkX, chunkZ): SurfaceChunk`. Planet-wide terrain field seeded only from (seed, planetId) (chunk sub-seed drives placement only — first version seeded noise per-chunk and showed a 107 m seam at borders, fixed by moving the field seed above the chunk); 64x64 integer-meter heightmap (Uint16-safe), amplitude scaled by planet radius (250 + radiusKm/8000*350 m); biome from center-cell height + second moisture noise channel (frozen reachable on ice-class worlds); pads first (forced 1 on landable chunk (0,0), else 25% seeded roll, snapped to flattest 3x3 patch within 4 cells, center fallback); then 1-4 nodes, types restricted to `planet.resourceTypes`, seeded rejection >= 20 m from pads, solid types re-rolled to liquid types on wetland chunks when liquids exist, baseQuantity 50..200; nodeId/padId = 16-hex hashes of the chunk sub-seed tuple. Non-landable planets: terrain + biome only.
- `types.ts` — `SurfaceChunk` reshaped to spec {chunkX, chunkZ, heightmap, biome, resourceNodes, landingPads}; added `Biome`, `ResourceNode`, `LandingPad`.
- Golden fixture `__fixtures__/surface-dev-seed-chunk00.json` (chunk (0,0), landable planet #0 of dev-seed star 0: 16 heightmap samples + nodes + pads + sha256 of the full canonical chunk) + `app/scripts/gen-surface-fixture.ts` to regenerate it.
- Tests `surface.test.ts` (13): golden snapshot (deep-equal + full checksum), two-call determinism, 100 random chunks x 3 planets stable with fresh Rng instances (canonical-JSON sha256 compared), sub-seed formula, border continuity (max edge delta < 0.15x amplitude for (0,0)/(1,0) and (0,0)/(0,1)), structural invariants (heightmap bounds, biome set, pad/node bounds + ids + nodeId formula + clearance + wetland rule, non-landable empty), stats (pad rate 0.1-0.4 around the 0.25 target, node counts span >= 3 of {1..4}, biomes plural + frozen on ice worlds).
- No UI changes → Playwright/e2e skipped (pure logic, unit coverage complete).
- Verified: `tsc --noEmit`, `eslint --fix` + `prettier --write` (lint + prettier --check clean), full `npm run test` → 7 files / 76 tests all pass.

### 2026-09-29 — TASK-4: System generator (planets, docks, deposits, AI roster)
Implemented pure, deterministic star-system generation on top of the TASK-3 star generator:
- `app/src/shared/galaxy/system.ts` — `generateSystem(seed, starId): SystemGen` + `generatePlanet(seed, starId, index): Planet`. Sub-seed = hash2(seedFromString(seed), seedFromString(starId)); per-planet sub-seed hash2(systemSub, j) so planets are order-independent and planet ids (16-hex) are stable keys for TASK-5. systemId = hex of the system sub-seed; name = star name + ' system'; star class/name drawn from the same sub-seed Rng (reused exported `pickSpectralClass`/`makeStarName` from stars.ts).
- Per-planet fixed draw order: class (weighted rocky 32/terran 18/ice 20/ocean 12/gas 18), radiusKm (gas 20k–60k, else 2k–8k), hasAtmosphere (per-class probability), landable (gas never; per-class probability), dockCount (1–3 landable / 0 else), resourceTypes (1–3 unique from iron/copper/silicon/rare-earths/water/gas-compounds), aiRoster (count 2–5, classes from scout/freighter/interceptor matching TASK-19 ids), name (prefix+root, deterministic re-draw on in-system collision).
- `types.ts` — Planet rebuilt to TASK-4 shape (class, radiusKm, hasAtmosphere, landable, dockCount, resourceTypes, aiRoster); added PlanetClass, ShipClassId, AiRoster, SystemGen. `config.ts` — planet class weights, per-class atmosphere/landable chances, RESOURCE_TYPES, SHIP_CLASS_IDS.
- Golden fixture `__fixtures__/system-dev-seed-star0.json`: star #0 of dev seed 'drift-dev-seed-001' (id 7dc36749a54c15d8), sha256=67f44440…fe418 of canonical JSON.
- Tests `system.test.ts` (16): golden snapshot (deep-equal + checksum), determinism across two calls, per-planet independence vs generatePlanet (fresh independent Rng per planet), two identically-seeded Rng instances draw identically, divergence on star/seed change, systemId formula check; 200-system statistical suite: 2–6 planets, unique 16-hex ids, unique names, radius bounds, gas never landable, dockCount bounds, resource/roster bounds — and 182/200 (91%) systems have ≥1 landable+atmosphere planet (>80% required); invariants repeated for 3 other seeds (incl. unicode + empty) × 30 systems.
- No UI changes → Playwright/e2e skipped (pure logic, unit coverage complete).
- Verified: `tsc --noEmit`, `eslint --fix` + `prettier --write`, full `npm run test` → 6 files / 63 tests all pass.

### 2026-09-29 — TASK-3: Star generator (seeded galaxy layout)
Implemented pure, deterministic galaxy star generation on top of the TASK-2 PRNG:
- `app/src/shared/galaxy/types.ts` — Star, SystemSummary, Planet, SurfaceChunk interfaces (forward-looking; later tasks extend).
- `app/src/shared/galaxy/config.ts` — GALAXY_STAR_COUNT=200, GALAXY_RADIUS=1000, GALAXY_THICKNESS=40, spectral weights (O:1 B:5 A:10 F:15 G:20 K:28 M:21), name word lists (45 prefixes / 44 roots / 43 suffixes, all unique), log-normal disk-radius helper.
- `app/src/shared/galaxy/stars.ts` — `generateStars(seed, count=200)`: per-star sub-seed `hash2(seedFromString(seed), i)` → Rng; thin-disk position (log-normal radius, uniform angle, clamped gaussian z), weighted spectral class, seeded 40+ word-combiner name with deterministic collision re-draw (guarantees uniqueness), systemCount 2..8, id = 16-hex sub-seed (stable key for TASK-4 / DB).
- `app/src/shared/canonical.ts` — `canonicalJson` (recursively key-sorted) for platform-stable checksums.
- Golden fixture `app/src/shared/galaxy/__fixtures__/stars-dev-seed.json`: seed 'drift-dev-seed-001', 200 stars, first 25 embedded, sha256=1b043184…6b0e90 of canonical JSON of all stars.
- Tests `stars.test.ts`: golden snapshot (deep-equal + length + checksum), default/custom count + prefix property, 5 seeds (incl. unicode + empty) × determinism / unique 16-hex ids / unique names / coordinate bounds / systemCount + class validity, distribution check (O+B < 25, K+M > 70 of 200). 24 new tests.
- No UI changes → Playwright/e2e skipped (pure logic, unit coverage complete).
- Verified: `tsc --noEmit`, `eslint --fix` + `prettier --write`, full `npm run test` → 5 files / 47 tests all pass.

### 2026-09-29 — TASK-2: Shared deterministic PRNG + hash library
Implemented `app/src/shared/random.ts` — pure, zero-import module (root of galaxy determinism):
- `seedFromString(s): bigint` — FNV-1a 64-bit over UTF-8 bytes (BigInt arithmetic). Verified against the known 'hello' vector (0xa430d84680aabd0b) and the '' offset basis.
- `Rng` (xoshiro128** over 4×U32, seeded via splitmix64 from a 128-bit seed): `nextU32()`, `nextF64()` (24-bit precision, documented tradeoff), `nextRange(min,max)`, `nextInt(n)`, `pick(arr)`, `nextGauss(mean,sd)` (Box-Muller, log(0)-guarded). Zero-state guard for all-zero seeds.
- `hash2(a,b): bigint` — order-sensitive 64-bit key combiner (splitmix finalizer) for per-entity sub-seeds.
- Tests: `random.test.ts` (node) — golden values for seed 'drift-dev-seed-001' (8× nextU32 + 5× nextF64 hardcoded), 3 known seedFromString strings, hash2 golden values, determinism/divergence, helper bounds + coverage, gauss moments, source-grep purity test (no Math.random/Date.now/crypto/performance.now/new Date, comments stripped), 100k-sample chi-square-lite uniformity (<20% bin deviation). `random.browser.test.ts` — `@vitest-environment happy-dom` parity suite asserting the identical golden constants.
- Added `happy-dom` devDependency for the parity environment. No UI changes → Playwright/e2e skipped (unit coverage complete).
- Verified: `npm run typecheck`, `eslint --fix` + `prettier --write`, full `npm run test` → 4 files / 23 tests all pass.

### 2026-09-29 — TASK-68: Scaffold TS monorepo (client/server/shared) with tooling
Stood up the `app/` scaffold (work was partially present uncommitted from a prior pass; verified, fixed, and completed it):
- Source trees `app/src/{shared,client,server}` with `@shared/*`, `@client/*`, `@server/*` aliases in tsconfig.json, vite.config.ts, and vitest.config.ts (strict, ESNext/bundler, ES2022).
- Server: `src/server/index.ts` (dotenv from PROJECT_ROOT/.env.local, Fastify + ws at WS_PATH, PORT from env), `server.ts` (buildServer for inject() tests), `env.ts` (zod-validated env with defaults: PORT, SESSION_SECRET, GALAXY_SEED, DB_DRIVER, DB_PATH, SYSTEM_INSTANCE_COUNT, WS_PATH). Client: `src/client/main.tsx` React shell with stable `#game-canvas` placeholder.
- Vite dev server proxies `/api` and `/ws` to the Node server (port 3001) so the browser stays same-origin.
- npm scripts: dev (concurrently vite + tsx server), build, test, test:e2e, typecheck, lint, start. Deps per spec (three, react, fastify, ws, drizzle-orm, better-sqlite3, zod, dotenv, tsx, concurrently, typescript-eslint, etc.).
- eslint flat config (typescript-eslint recommended) + .prettierrc (semi, singleQuote, printWidth 100). `.env.local` and `data/` confirmed git-ignored; added `test-results/` to root .gitignore.
- Tests: `src/shared/health.test.ts` (vitest), `src/server/health.test.ts` (Fastify inject → /api/health 200 {ok, galaxySeed}), Playwright `tests/scaffold.spec.ts` (canvas + health + no console errors).
- Verified: `npm run dev` boots both (vite :3000, server :3001), /api/health 200 via proxy, WS welcome on /ws; lint/typecheck/test/build all green; Playwright 1/1 passed.
- Screenshot: `.agent/screenshots/TASK-68-1.png`

### 2026-09-29 — TASK-1: Verify project prerequisites and access
Verified all prerequisites; task passes.
- `.env.local` present at PROJECT_ROOT with all 8 required names (PORT, SESSION_SECRET, GALAXY_SEED, DB_DRIVER, DB_PATH, DATABASE_URL, SYSTEM_INSTANCE_COUNT, WS_PATH); SESSION_SECRET holds a real 64-char random value (value not printed/stored anywhere but the git-ignored file); DATABASE_URL left as placeholder (SQLite driver in use).
- Storage: Node v24.20.0 + npm 11.19.0 available. `better-sqlite3` verified installable in a temp dir; create + insert + select round-trip succeeded. Valid SQLite file exists at `app/data/drift.db` (header "SQLite format 3").
- Gaps recorded with proceed decision:
  1. **No live Postgres in sandbox** — proceed; PG parity to be covered by Drizzle dual-driver unit tests (per PRD).
  2. **MCP servers in `.mcp.json` (playwright/context7/sequential-thinking) are not registered for this implementing agent** (no tools in the agent catalog; `.mcp.json` playwright executable path `/home/agent/.cache/...` is stale — actual browser lives at `/opt/ms-playwright/chromium-1243`). Proceed: direct Playwright via `@playwright/test` + chromium works (smoke run produced a screenshot with no console errors), so functional equivalence is covered.
  3. **Headless CI WebGL is functional-only**; perf verification deferred to reference hardware.
- Service docs reachable (HTTP 200 after redirects): threejs.org/docs, fastify.dev/docs, github.com/websockets/ws, orm.drizzle.team, github.com/WiseLibs/better-sqlite3.
- Test users: callsign-only auth; e2e will create disposable callsigns TEST-ALPHA / TEST-BRAVO at runtime. No passwords stored.
- Steering work completed: deps installed, Playwright system deps + chromium installed, dev server started (HTTP 200 at :3000), screenshot taken.
- Screenshot: `.agent/screenshots/TASK-1-1.png` (smoke: `app/smoke-task1.mjs`)
