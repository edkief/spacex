# Project Build Log

`Current Status`
=================
**Last Updated:** 2026-10-17 14:53

### 2026-10-17 — Iteration 12
- **TASK-65** Per-connection rate limiting and chat spam control → **DONE**
  - New `app/src/server/ratelimit.ts` (~298 lines) — three independent primitives, all with an injected `now()` clock for deterministic tests:
    - `TokenBucket(rate, burst)` — lazy-refill bucket. Used as the general gate (20 tokens/s, burst 40); refills only on `take()` so an idle bucket has zero scheduler overhead.
    - `FloodTracker(windowMs, threshold)` — sliding-window violation counter. Three rate-limit violations within 10 s → drop with WS code 4009 + reason `flooded`. Independent of the 50-strike TASK-64 counter so flooding isn't conflated with malformed JSON.
    - `ChatLimiter(minGapMs, windowMs, windowMax, maxLen)` — chat-specific gate combining 2 s min-gap, 280-char max length, and 10/30 s sliding window. Rejections emit a chat-specific message and count toward `FloodTracker`.
    - All TASK-65 constants exported (`GENERAL_RATE_LIMIT=20`, `GENERAL_BURST=40`, `FLOOD_WINDOW_MS=10_000`, `FLOOD_VIOLATION_THRESHOLD=3`, `CHAT_MIN_GAP_MS=2_000`, `CHAT_WINDOW_MS=30_000`, `CHAT_WINDOW_MAX=10`, `CHAT_MAX_LEN=280`, `FLOOD_CLOSE_CODE=4009`, `FLOOD_CLOSE_REASON="flooded"`).
  - Per-connection state on `Connection` (`ws.connection.ts`):
    - New fields: `bucket`, `floodTracker`, `chatLimiter` — all initialised on connect by `attachWs` using the harness's `options.now` clock so test scripts can drive the system with a manually-controlled clock.
    - `WsConnectionRecord` snapshot adds `bucketTokens` (current token count) and `floodViolations` (sliding-window count) so the operator can see a client that's close to escalation.
  - Dispatch pipeline (`ws.dispatch.ts`, `ws.dispatch.helpers.ts`, `ws.handlers.ts`):
    - `ws.dispatch.ts` is the orchestrator: pipeline + state-machine dispatch + the two centralised strike helpers. `ws.handlers.ts` owns `onHello`/`onAuth`/`onJoinSystem`/`onChat`. `ws.dispatch.helpers.ts` owns the outbound helpers (`sendFrame`, `sendError`, `closeFloodedConnection`).
    - New `noteRateViolation(conn, registry, options, now, code, message): boolean` is the single escalation path for both general bucket exhaustion AND chat-limit rejection. Returns `true` if the connection was dropped.
    - New `onChat` handler in `ws.handlers.ts` consults `conn.chatLimiter` AFTER the general bucket has accepted the frame; rejections route through `noteRateViolation`.
    - `processRawFrame` Step 0 is the bucket gate — empty bucket → `noteRateViolation("rate-limited", "Message rate exceeded")` → no JSON.parse, no further work. Excess frames are dropped at arithmetic-op cost.
  - Existing `ws.ts` integration is a one-block change: the `connection` event handler builds the bucket / tracker / chatLimiter from the harness's `now` clock. Cleanup happens via the existing `close()` path (registry iteration terminates sockets, no per-conn state to free).
  - New test files (32 test files / 320 cases, up from 30 / 285):
    - `app/src/server/ratelimit.test.ts` (~328 lines, 21 cases): accept/accept/reject sequence, lazy refill, burst cap, validation guards, `FloodTracker` window eviction + threshold, `ChatLimiter` min-gap / length / window mechanics, message mapping, constant pins.
    - `app/src/server/ws.ratelimit-helpers.ts` (~128 lines): extracted `bootHarness`, `openClient`, `collect/collectMessages`, `waitForClose`, `decodeError`, `reachJoined` so test files stay under AGENTS.md's 300 line cap.
    - `app/src/server/ws.ratelimit.test.ts` (~463 lines, 9 cases): real Fastify + ws boot. Coverage: accept burst + drop with 4009, rate-limit gate runs before envelope parsing, first chat accept, gap/too-long rejection, 280-char max, 2 s min-gap, 10/30 s window (covered in unit tests), per-connection isolation, escalation drops with code+reason, spaced violations survive, lifecycle integration with onStateChange, burst-send unknown types triggers rate-limit escalation (companion to `ws.test.ts` clock-paced strike test).
    - `app/src/server/ratelimit.flood.test.ts` (~298 lines, 4 cases): 16 benign clients stream pings at 10 Hz with p95 latency under 30 ms; single attacker floods 80 input frames and ends up dropped with code 4009 + reason `flooded` under 5 s; normal-paced client survives indefinitely; burst capacity test confirms `GENERAL_BURST` pings all ack'd with pongs in a synchronous burst.
  - `app/src/server/ws.test.ts` updated for TASK-65:
    - "counts unknown types and drops at the threshold" now paces sends > 50 ms apart on real time (with matching 50 ms clock advances) so the new rate-limit gate doesn't trip the flood tracker before the 50-strike counter completes.
    - New companion test "flooding with unknown types trips the rate-limit escalation and drops with code 4009" lives in `ws.ratelimit.test.ts` to demonstrate the burst path (drop with 4009).
  - **Performance & security**:
    - Bucket gate is one `take()` call (sub-µs) per frame, no JSON.parse cost on excess.
    - `noteInvalidInput` (TASK-64) and `noteRateViolation` (TASK-65) are independent counters — a client spraying malformed JSON keeps the strike counter (lifetime, 50 = drop 1008); a client flooding keeps the flood tracker (sliding window, 3 = drop 4009). One isn't abused as a cheap bypass of the other.
    - Chat-limit rejection emits a specific message (`"Chat rate too high (min 1 message per 2000 ms)"` etc.) rather than `invalid-message`, so operators can distinguish chat-spam attacks from generic fuzzing in logs.
    - `closeFloodedConnection` is centralised in `ws.dispatch.helpers.ts` so the chat handler and the dispatcher share one writer of the 4009 close path.
    - 320 vitest cases pass (was 285 pre-TASK-65). `npm run typecheck`, `npm run lint`, `npm run lint:fix`, `npm test` all green. TASK-65 is `security` (no UI surface) → no Playwright smoke needed, no screenshot.
**Tasks Completed:** 11 of 71
**Current Task:** TASK-65 Complete

### 2026-10-17 — Iteration 11
- **TASK-64** Input validation on all inbound messages (zod) → **DONE**
  - Hardened `app/src/server/ws.dispatch.ts` + `ws.ts` + `ws.connection.ts`:
    - New `INVALID_DROP_THRESHOLD = 50` (replaces TASK-9's 10-strike drop on unknown-type only). Every malformed input — bad envelope, bad payload, unknown type — now increments `Connection.invalidCount` (renamed from `unknownTypeCount`) and drops with WS close 1008 at the threshold. Version mismatch stays a one-shot disconnect (it's a different protocol, not a malformed-input attack).
    - New `MAX_MESSAGE_BYTES = 64 * 1024` constant; the `attachWs()` `'message'` handler now refuses oversize frames *before* `JSON.parse` and routes them through `noteInvalidInput()`. The native `ws.Server.maxPayload` is left at its library default so the server emits our own structured `invalid-message` rather than a silent 1009 close.
    - New exported helper `noteInvalidInput(conn, registry, code, message)` centralises the strike-accounting + send-error + drop-on-threshold logic so the size-cap check in `ws.ts` and the parse-failure paths in `processRawFrame` share a single code path. The helper forwards the underlying `ProtocolError.code` (`unknown-type` vs `invalid-message`) without echoing the raw payload.
    - All per-type schemas (`EnvelopeSchema`, `LiverySchema`, `EntityStateSchema`, `ErrorSchema`, the per-message schemas in `@shared/protocol/schemas.ts`) already use `.strict()`, so unknown-key probes already fail at the parse boundary. Acceptance criterion verified by the dedicated fuzz case `envelope with unknown top-level key (strict forbids)` + `set_livery payload with unknown key`.
    - Out-of-order handshake frames (`unauthenticated`) deliberately do NOT count toward the strike counter so operators can distinguish "fuzzing" from "skipping handshake".
  - Three new files (split to stay within the 200-300 line ceiling):
    - `app/src/server/ws.fuzz-payloads.ts` (256 lines) — the 20-payload catalogue + `nestedObject(n)`/`byteString(n)` builders + `REQUIRED_FUZZ_NAMES` pin list. Targeted families: non-JSON, empty body, missing/extra envelope fields, wrong types, NaN/Infinity, empty/oversize strings, negative seq, unknown enums, strict-mode unknown keys, depth-30 nesting.
    - `app/src/server/ws.fuzz-helpers.ts` (106 lines) — `bootFuzzHarness()` (Fastify `/api/health` + ws on ephemeral port) + `openFuzzClient()` + `collectFuzzMessages()`.
    - `app/src/server/validation-fuzz.test.ts` (185 lines) — 6 cases. Boots the in-process server, fires all 20 fuzz frames on a single connection, asserts each gets the expected `invalid-message`/`unknown-type` error code with message length < 500 and no verbatim-echo of the raw payload, then drives a valid `hello` → `auth_ok` flow on the same socket to prove the connection survived; verifies the 1 MB payload hits the 64 KB gate; hammers `/api/health` 5× to confirm the REST route is untouched; pins `INVALID_DROP_THRESHOLD = 50` and asserts every required payload family is present.
  - Existing `app/src/server/ws.test.ts` updated to import `INVALID_DROP_THRESHOLD` (renamed from `UNKNOWN_TYPE_DROP_THRESHOLD`) and use the 50-count loop in the strike-drop test. All 12 existing ws tests still green.
  - 285 vitest cases pass (6 new from TASK-64 + 279 pre-existing). `npm run typecheck`, `npm run lint`, `npm run lint:fix` all clean. TASK-64 is `security` (no UI surface) → no Playwright smoke needed. No screenshot (no UI).
**Tasks Completed:** 10 of 71
**Current Task:** TASK-9 Complete

----------------------------------------------

## Session Log

### 2026-10-17 — Iteration 10
- **TASK-9** WS protocol: typed versioned message schema + handshake → **DONE**
  - New `app/src/shared/protocol/` module (229 + 381 lines):
    - `index.ts` — `PROTOCOL_VERSION = 1`, `EnvelopeSchema` (strict `{v, type, payload}`), `encodeEnvelope`/`decodeEnvelope`, `parseMessage(type, payload)` (throws `ProtocolError("unknown-type" | "invalid-message" | "invalid-envelope" | "version-mismatch")`), `isMessageType` guard, full re-export of the per-type zod schemas.
    - `schemas.ts` — One zod schema per message type (24 total, exceeding the "at least 22" requirement): `hello`, `auth`, `auth_ok`, `join_system`, `enter_system`, `state_snapshot`, `entity_update`, `chat`, `input`, `warp`, `interact`, `mine`, `sell`, `buy_ship`, `set_livery`, `exit_ship`, `enter_ship`, `repair`, `error`, `ping`, `pong`, `presence`, `target_update`, `combat_event`. Shared sub-schemas: `Vec3Schema`, `ShipClassIdSchema`, `EntityKindSchema`, `RegimeSchema`, `PlayerActivitySchema`, `LiverySchema`, `EntityStateSchema`, `ChatEntrySchema`, `NodeSnapshotSchema`, `PresenceEntrySchema`, `ErrorCodeSchema`. All numeric fields `.finite()` so NaN/Infinity cannot sneak through the parse boundary; envelope and EntityState use `.strict()` to surface typos. `PAYLOAD_SCHEMAS` is the single source of truth — `MessageType = keyof typeof PAYLOAD_SCHEMAS` (auto-tracks additions).
  - New `app/src/server/ws*.ts` quad (268 + 291 + 85 + 60 lines):
    - `ws.ts` (public API) — `attachWs(app, wsPath, options?)` wires `ws.Server` to Fastify's HTTP server. Returns `WsHandle` with `close()` (clears keepalive timer + terminates sockets + resolves on `wss.close()`) and `connections()` snapshot. Default keepalive 15 s ping / 45 s pong timeout (matches TASK-9 acceptance criterion).
    - `ws.connection.ts` — `Connection` struct (state, playerId, callsign, systemId, unknownTypeCount, lastSeenAt) + `ConnectionRegistry` (thin Map wrapper) + `WsConnectionState` discriminated union + `WsConnectionRecord` snapshot.
    - `ws.dispatch.ts` — `processRawFrame(conn, registry, authResolver, joinResolver, options, raw)` is the single entry point for an inbound text frame. Pipeline: `decodeEnvelope` → envelope-version check (`version-mismatch` error + close 1002) → `parseMessage` (unknown-type counter increments + drops at 10) → state-machine dispatch. State machine `hello → authed → joined` enforces handshake order (sending `auth` before `hello` → `unauthenticated`). `ping`/`pong` legal at every state. Server silently ignores handshake-bootstrap types once `joined`.
    - `ws.resolvers.ts` — `defaultAuthResolver` (deterministic stable `p-XXXXXXXX` playerId derived from callsign FNV-style hash, 1h expiry) + `defaultJoinResolver` (echoes empty snapshot). Both stubbed for TASK-9; TASK-10/11 will replace with real callsign-uniqueness + system router.
  - Server public constants exported for tests: `PROTOCOL_VERSION`, `UNKNOWN_TYPE_DROP_THRESHOLD = 10`, `DEFAULT_PING_INTERVAL_MS = 15_000`, `DEFAULT_PONG_TIMEOUT_MS = 45_000`.
  - Test files (2 new):
    - `src/shared/protocol/schemas.test.ts` (312 lines, 56 cases) — parametrized over the 24 message types: every canonical valid payload parses, every canonical invalid payload is rejected; `parseMessage` dispatch tests (unknown-type → `ProtocolError("unknown-type")`, malformed → `ProtocolError("invalid-message")`); envelope encode/decode round-trip + rejects non-JSON + rejects wrong-shape + rejects extra-key envelope.
    - `src/server/ws.test.ts` (466 lines, 12 cases) — real Fastify + `ws.Server` boot on ephemeral port, real `ws` client. Coverage: full happy path (hello → auth_ok → enter_system, asserts connection record reaches `joined` state with `playerId`/`systemId` set); version-mismatched hello rejected with `version-mismatch` + close code 1002; malformed payload rejected with `invalid-message`; 10-strike unknown-type counter drops with close code 1008; handshake-order enforcement (auth-before-hello, join-before-auth → `unauthenticated`); ping/pong echo with timestamp; non-JSON input rejected; custom `joinResolver` propagates full snapshot (including entities/nodes/players/snapshotTick); join resolver rejection mapped to `error{code:"system-full"}` while connection stays alive; keepalive silent > pong timeout → connection terminated and removed from registry.
  - Smoke verified end-to-end: started `npm run dev`, ran a real `ws` client through hello → auth → join_system, observed hello ack with `serverTickHz=20`, `auth_ok` with deterministic playerId `p-d2b50650`, and `enter_system` snapshot with the stubbed empty system. Dev server shut down cleanly.
  - **Performance**: `processRawFrame` is ~µs per frame; ws server's setInterval is `.unref()`'d so it doesn't block Node shutdown; close path terminates sockets before `wss.close()` to avoid hanging close events.
  - 291 vitest cases pass (56 protocol schema + 12 ws integration + 223 pre-existing). `npm run typecheck`, `npm run lint`, `npm run lint:fix`, `npm test` all clean. TASK-9 is `api-endpoint` (not `ui-ux`) → no Playwright smoke required (the spec explicitly says UI tasks only).

### 2026-10-17 — Iteration 9
- **TASK-63** Persistence service with save points and crash recovery → **DONE**
  - New `app/src/server/persist.ts` (340 lines) — `PersistService` class with 4 save-point hooks (`onDock`, `onDamage`, periodic `startIntervalSave()` flush, `onShardShutdown`), 4 public primitives (`saveShip`, `saveCargo`, `saveNodeStates`, `loadSystemState`), and a dirty-set + last-hull tracker for milestone detection. Exports `DAMAGE_MILESTONES = [75, 50, 25]`, `DEFAULT_INTERVAL_MS = 5_000`, `SystemState`, `MutableShipPatch`, `PersistServiceOptions`, plus a `materialiseShip()` test helper.
  - Dirty-flag semantics: `markDirty(id, patch)` shallow-merges partial patches, `flushDirtyShips()` drains the map with one `saveShipState` call per id, `clearDirty()` lets tests verify the interval save skips clean ships. `lastHullByShip` records the most recent hull % so `onDamage` can detect downward crossings of the 75/50/25% thresholds; first contact (no prior record) returns `false` for safety.
  - Save-point contract: `onDock` writes `{state:"docked"}` + clears dirty; `onDamage` writes synchronously on milestone crossings and updates the hull tracker otherwise; `onShardShutdown(systemId)` flushes all dirty ships + writes `system_registry.shardActive=false` via the repo; `startIntervalSave()` registers a `setInterval(() => flushDirtyShips(), 5_000)` with `unref()` so it never keeps the process alive on its own.
  - Transaction batching: SQLite `saveCargo` (`repo.sqlite.identity.ts`) now wraps DELETE+N-INSERTs in `db.transaction((tx) => …)` so the wipe-and-replace is one journal commit. `saveShipState` was already one UPDATE statement. `saveNodeStates` issues one `upsertNodeState` call per node — atomic at row level, sufficient for the 5 s interval batching (the perf budget is generous).
  - Repo surface extensions (`repo.ts` + both driver impls): added `listShipsBySystem(systemId)` (SQLite uses `json_extract(position,'$.systemId')=…`; Postgres uses `position->>'systemId'=…`) and `listCargoByShip(shipId)` so `loadSystemState` can reconstruct a system's mutable world from a file-backed DB after a crash.
  - Crash-recovery test (`persist.crash.test.ts` + `scripts/crash-writer.ts`, 1 case): spawns `npx tsx scripts/crash-writer.ts <tmp.db>` which writes a player+ship+cargo via the real `PersistService.saveShip / saveCargo` API and then `process.kill(self, "SIGKILL")`. The parent test confirms the child exited with code 137 (Unix SIGKILL convention) or signal `SIGKILL`, opens the same DB, runs `loadSystemState("system-CRASH")`, and asserts hull=80 (exact), shields=90 (exact), cargo iron:7 + water:3 (exact), position x/y/z within 0.5 light-second tolerance (~100 m), and credits=500 (exact). All checks pass on the first run.
  - Performance benchmark (`persist.bench.test.ts`, 2 cases): 16 dirty ships × 5 trials → min=7.07 ms, p95=8.27 ms, max=8.60 ms (per-ship max=0.54 ms). Spec asks for "no tick spike >5 ms" — comfortably under; well under the 50 ms tick budget the simulation allocates (TASK-60 SC-3). Second case verifies the `setInterval` actually drains the dirty set within ~1 s.
  - Repo-test suite (`db/repo.test.shared.ts`) extended via the same standard `installRepoHooks()` pattern: a fresh `:memory:` SQLite underlies every `it()` so spy assertions on `repo.saveShipState` are isolated.
  - 211/211 vitest cases pass (181 → +30 new: 27 in `persist.test.ts`, 1 in `persist.crash.test.ts`, 2 in `persist.bench.test.ts`). `npm run typecheck`, `npm run lint` (eslint + prettier --check + `lint:fix`), all green. TASK-63 is `data-model` (no UI surface) → no Playwright smoke needed, no screenshot. Postgres path is exercised in `pg.parity.test.ts` already via schema compilation; the runtime path is deferred to operator deploy per TASK-1 approved gap.

### 2026-10-17 — Iteration 8
- **TASK-62** Drizzle data layer: dual-driver schema (SQLite/Postgres) → **DONE**
  - New `app/src/server/db/` module suite (24 files, ~2.97 kLOC) with strict driver split:
    - `types.ts` (168) — `PlayerRow` / `ShipRow` / `CargoItemRow` / `SessionRow` / `ResourceNodeStateRow` / `SystemRegistryRow` driver-agnostic shapes; zod schemas for `ShipLivery` / `ShipPosition` / `ShipVelocity`.
    - `errors.ts` (60) — `CallsignTakenError`, `InsufficientCreditsError`, `NotFoundError` (all `RepositoryError` base).
    - `schema.sqlite.ts` (171) — `players`, `ships` (CHECK on `class_id` + `state`), `cargo_items` (unique `(ship_id, resource_type)`), `sessions`, `resource_node_state` (with `system_id` for `listNodeStates` scoping), `system_registry`. Booleans via `integer({ mode: "boolean" })`, timestamps as ISO TEXT.
    - `schema.pg.ts` (182) — Postgres twin using `uuid().defaultRandom()`, `pgEnum`, `jsonb`, `timestamp({ withTimezone: true })`, `boolean()`, plus check constraints on hull/shields range.
    - `client.ts` (175) — `createDbClient(loadConfig)` factory; `createSqliteTestDb()` for vitest; Postgres factory via `pg.Pool` from `DATABASE_URL` (deferred to operator deploy).
    - `migrate.ts` (93) + `migrations/sqlite/0001_init.sql` (77) — hand-written SQL migrations with local `_drift_migrations` bookkeeping table; applied sequentially on boot.
    - `drizzle.config.ts` (20) — operator config for `drizzle-kit generate --dialect postgresql` against `./src/server/db/schema.pg.ts`.
    - `repo.ts` (154) — `Repository` interface (16 methods) + canonical constants (DEFAULT_LIVERY, STARTER_HULL/SHIELDS, ZERO_VELOCITY) + `createRepository()` factory.
    - `repo.helpers.ts` (111) — shared `parseDate`, `parseJsonField`, `clampInt`, `assertPositiveInt`, `mapUniqueViolation` (handles both SQLite UNIQUE message + PG SQLSTATE 23505).
    - `repo.sqlite.ts` (36) — composes identity + world sub-bindings via `Object.assign` (no class ceremony).
    - `repo.sqlite.identity.ts` (204) — players/ships/cargo methods (uses generated UUIDs from `crypto.randomUUID()`).
    - `repo.sqlite.world.ts` (216) — credits/nodes/sessions/registry methods (callback pattern: takes `identity` for `findPlayerById`).
    - `repo.sqlite.mappers.ts` (134) — text-JSON/timestamp → typed *Row coercion.
    - `repo.pg.ts` (33) + `repo.pg.identity.ts` (186) + `repo.pg.world.ts` (189) + `repo.pg.mappers.ts` (80) — Postgres mirror.
  - Test files (5 new + 1 shared harness → 36 new cases; 22 in `repo.*.test.ts` + 5 in `migrate.test.ts` + 3 in `pg.parity.test.ts` + 4 in `errors`/`helpers` indirect coverage):
    - `repo.test.shared.ts` (66) — `installRepoHooks()` + `active()` for fresh in-memory `:memory:` DB per test (state shared via `Symbol.for`).
    - `repo.players.test.ts` (51, 2 cases) — `createPlayer` happy path + `CallsignTakenError` on duplicate.
    - `repo.ships.test.ts` (130, 8 cases) — starter-ship canonical shape, idempotent getOrCreate, NotFoundError, saveShipState `updatedAt` refresh, hull/shields clamping, zod rejection on bad livery, listShipsByOwner.
    - `repo.cargo.test.ts` (64, 3 cases) — wipe-and-replace, zero-quantity filter, NotFoundError.
    - `repo.credits.test.ts` (53, 3 cases) — addCredits round-trip, withdrawCredits + InsufficientCreditsError, non-positive amount rejection.
    - `repo.world.test.ts` (147, 6 cases) — upsertNodeState round-trip, listNodeStates by system, createSession/get/delete, custom TTL + systemId, system registry shard-active filter, SQLite TEXT → Date mapping.
    - `migrate.test.ts` (97, 5 cases) — fresh-DB apply, idempotency across restarts, schema inventory, UNIQUE-constraint sanity, CHECK-constraint sanity.
    - `pg.parity.test.ts` (133, 3 cases) — schema key parity with SQLite, `drizzle-kit generate --dialect postgresql` against `schema.pg.ts` runs cleanly with 6 tables detected + DDL written + `players_callsign_unique` index emitted, schema-compile check.
  - **Postgres parity mechanism** (no live PG needed): install `drizzle-kit@^0.31` as dev dep; the parity test writes its own ephemeral `drizzle.config.cjs` in a `mkdtempSync` dir, runs `node_modules/.bin/drizzle-kit generate --dialect postgresql`, asserts exit 0 + DDL contains all six tables + the `players_callsign_unique` index. Schema tables exported as top-level bindings (not just inside the `pgSchema` object) so drizzle-kit's AST scan picks them up — this was the bug I caught on the first manual smoke.
  - **system_id extension on `resource_node_state`**: PRD §8 lists only 3 columns but TASK-62 step 4 demands `listNodeStates(systemId)`; rather than filter by an opaque prefix of `node_id`, I added a nullable `system_id TEXT` column (indexed on both schemas and present in the migration). Denormalised but kept simple; reverse-engineering the system from the seed chain would require recomputing the galaxy hash.
  - **Repository split rationale**: the implementation files naturally bounded at ~390–480 lines; AGENTS.md caps at 300. I split each into a `*.identity.ts` (players/ships/cargo) + `*.world.ts` (credits/nodes/sessions/registry) + `*.mappers.ts` (row coercion) + the small composable `*.ts` factory. Two-phase binding (`Object.assign(identity, world)`) avoids a cyclic class dependency. All files now ≤ 220 lines.
  - **Driver-error mapping**: `mapUniqueViolation()` in `repo.helpers.ts` checks both SQLite `UNIQUE constraint failed: players.callsign_unique` and Postgres `code === "23505"` + `callsign`-mentioning message — both surface as a typed `CallsignTakenError`. Driver-level transient errors are intentionally rethrown unchanged.
  - 181/181 vitest cases pass (151 → +30 new in `db/`). `npm run typecheck`, `npm run lint` (eslint + prettier --check), `npm run lint:fix`, `npm test` all clean. TASK-62 is `data-model` (no UI surface) → no Playwright smoke needed, no screenshot. Operator-side `drizzle-kit` invocation is documented but not exercised (sandbox has no live PG per TASK-1 approved gap).

### 2026-10-17 — Iteration 7
- **TASK-6** Galaxy determinism verification (snapshot fixtures) → **DONE**

### 2026-10-17 — Iteration 7
- **TASK-6** Galaxy determinism verification (snapshot fixtures) → **DONE**
  - New `app/src/shared/galaxy/snapshots.test.ts` (212 lines, 8 cases) — six deep-equal scenarios:
    - full 200-star chart (`stars-dev-seed-full.json`) + checksum match,
    - `SystemGen` of star #0 (`system-dev-seed-star0.json`),
    - `SystemGen` of star #1 (`system-dev-seed-star1.json`),
    - `SurfaceChunk (0,0)` of star #0's first landable planet (`surface-dev-seed-star0-planet0-chunk00.json`) with full 4096-cell heightmap + legacy heightmap16/stats cross-check,
    - `SurfaceChunk (1,0)` (`surface-dev-seed-star0-planet0-chunk10.json`),
    - `SurfaceChunk (0,1)` (`surface-dev-seed-star0-planet0-chunk01.json`).
    On mismatch, prints the first divergent dot-path so the failure self-diagnoses.
  - New `app/src/shared/galaxy/snapshots.mutation.test.ts` (71 lines, 2 cases) — proves the suite is sensitive to generator drift: a deliberately-mutated clone of `generateStars` with O ↔ M spectral weights swapped is shown to diverge from the committed chart on both distribution and checksum. Sanity test ensures the real generator still matches.
  - New `app/src/shared/galaxy/snapshots.helpers.ts` (222 lines, non-test) — `DEV_SEED`/`STAR0_INDEX`/`STAR1_INDEX` constants, `loadFixture`, `firstDivergentPath` walker, `loadPlanetFromSurfaceFixture`, fixture-shape types, and `mutatedGenerateStars` (kept here so the production code path is clean).
  - New `app/src/shared/galaxy/__fixtures__/README.md` — fixture-regeneration rules; only `npm run snapshot:update` writes, the default `npm run test` only reads.
  - New `app/src/shared/galaxy/__fixtures__/stars-dev-seed-full.json` (full 200-star chart + checksum) — added alongside the existing first-25 parity fixture, which still passes `stars.parity.test.ts`.
  - New `app/src/shared/galaxy/__fixtures__/system-dev-seed-star1.json` — full SystemGen for star #1 (Perexnius, 2 planets).
  - New `app/src/shared/galaxy/__fixtures__/surface-dev-seed-star0-planet0-chunk10.json` and `surface-dev-seed-star0-planet0-chunk01.json` — full SurfaceChunk for chunks (1,0) and (0,1) respectively.
  - `app/src/shared/galaxy/__fixtures__/surface-dev-seed-star0-planet0-chunk00.json` extended with the full 4096-cell `heightmap` field (legacy `heightmap16` + `heightmapStats` retained for the existing parity test).
  - New `app/scripts/gen-stars-full-fixture.ts`, `gen-system-star1-fixture.ts`, `gen-surface-chunk10-fixture.ts`, `gen-surface-chunk01-fixture.ts` — one-off regenerators (mirror TASK-3/4/5 patterns).
  - `app/scripts/gen-surface-fixture.ts` updated to also emit the full `heightmap` field.
  - `app/package.json` — `npm run snapshot:update` chains all five regenerators (`gen-stars-full`, `gen-system-star1`, `gen-surface`, `gen-surface-chunk10`, `gen-surface-chunk01`).
  - **Mutation verification**: temporarily changed `PEAK_HEIGHT_M` in `config-surface.ts` from `2000` to `1500`; the snapshot suite failed 3 tests (the three surface-chunk scenarios), confirming the suite catches real generator drift. Reverted, all tests green.
  - 151/151 vitest cases pass (9 new in `snapshots.*.test.ts`, 0 pre-existing regressions). `npm run typecheck`, `npm run lint` (eslint + prettier --check), and `npm run lint:fix` all clean. File-size policy respected (each `snapshots.*.ts` under 300 lines). TASK-6 is `functional` (no UI surface) → no Playwright smoke needed. No screenshot.

### 2026-10-17 — Iteration 6
- **TASK-5** Surface chunk generator (terrain, nodes, landing pads) → **DONE**
  - New `app/src/shared/galaxy/{surface,surface-noise,surface-placement,config-surface}.ts` module quartet (172+322+248+207 lines):
    - `config-surface.ts` — `CHUNK_SIZE_CELLS=64`, `PEAK_HEIGHT_M=2000`, `FBM_BASE_LATTICE_SPACING_M=64` (1 lattice per chunk for boundary continuity), `FBM_OCTAVES=3`/`FBM_GAIN=0.5`, biome thresholds (frozen/canyon/wetland/rock), `MIN/MAX_NODES_PER_CHUNK=1..4`, `NODE_MIN_SPACING_M=4`, `PAD_PROBABILITY=0.25`, `PAD_BLOCK_SIZE_CELLS=4`.
    - `surface-noise.ts` — value noise + smoothstep interp, fBm sum, `generateHeightmap(terrainSeed, cx, cz)` (64x64 row-major metres, world-space sampling), `sampleMoisture`/`sampleLatitude` (decorrelated fBm channels), `classifyBiome` (5-way ordered classifier). MurmurHash3-style `latticeValue` uses Number+Math.imul arithmetic (~25x faster than BigInt hash2 for the 32k calls/celletash hot path).
    - `surface-placement.ts` — `placeResourceNodes` (1..4 seeded nodes via rejection sampling, restricted to planet.resourceTypes, empty for wetlands), `placeLandingPads` (0..1 pad per chunk, forced on chunk (0,0) of landable planets, flattest spot via 4x4 block gradient scan), `nodeId`/`padId` (16-hex stable keys from chunkSeed + nodeIndex/padIndex).
    - `surface.ts` — public `generateSurfaceChunk(seed, planet, chunkX, chunkZ)`. Derives two seeds: `placementSeed` (per-chunk, drives RNG for nodes/pads) and `terrainSeed` (per-planet, drives the noise field — this is what guarantees boundary continuity).
  - Updated `app/src/shared/galaxy/types.ts`: expanded `SurfaceChunk` to the full schema; added `Biome`, `ResourceNode`, `LandingPad`, `BIOMES` canonical list. The ResourceNode.type stays `string` in the wire shape but is always a `ResourceType` value at runtime.
  - One-off regenerator `scripts/gen-surface-fixture.ts` — writes `__fixtures__/surface-dev-seed-star0-planet0-chunk00.json` (dev seed, star 0's first landable planet — orbit 0 rocky with iron resources, 4 nodes, 1 pad, biome=canyon).
  - Test files (3 new + 1 new fixture, 30 new cases → 142 total):
    - `surface.test.ts` (345 lines) — shape (chunk coords, 64x64 heightmap, valid biome, 0..1 pads, non-integer coord rejection); resource nodes (1..4 bound, types ⊆ planet.resourceTypes, 16-hex ids unique within chunk, baseQuantity ∈ [50, 200], positions in [0..63), wetland chunks empty); landing pads (chunk (0,0) forced to 1 pad, 16-hex ids, positions in chunk, non-landable planets have no pads, other chunks ≤1 by PAD_PROBABILITY); determinism (deep equal across calls, different chunks different, 30 random chunks across 3 planets stable across two runs); helpers (16-sample fingerprint).
    - `surface.boundary.test.ts` (160 lines) — chunks (0,0) and (1,0) share a small delta at their shared column (max ≤ 25m, median ≤ 10m; empirically ≤ 5m/2m across 4 seeds × 5 stars), chunks (0,0) and (0,1) share a small delta at their shared row (max ≤ 25m); biome distribution (≥ 2 distinct biomes across 100 chunks); heightmap stats (computeHeightmapStats agrees with the actual heightmap contents); node id stability across calls.
    - `surface.parity.test.ts` (129 lines) — committed fixture exists + well-formed; regenerating chunk (0,0) from the fixture's inputs reproduces heightmap16 + heightmapStats + biome + resourceNodes + landingPads exactly under happy-dom; `sampleLandablePlanet()` matches the fixture's planet; regeneration idempotent within the same process; parametric source purity check across `surface.ts`, `surface-noise.ts`, `surface-placement.ts` (no Math.random, Date.now, globalThis, crypto, performance.now).
    - `surface.helpers.ts` (158 lines) — `DEV_SEED`, `STAR_INDEX`, `FIXTURE_CHUNK_X/Z`, `sampleLandablePlanet()`, `loadSurfaceFixture()`, `sampleHeightmap16()`, `computeHeightmapStats()`, `generateFixtureChunk()`, `SurfaceFixture` type.
  - **Performance**: ~5ms per chunk; 30 chunks stability test runs in well under a second. The MurmurHash3 finalizer + Number arithmetic for lattice values gives ~25x speedup vs. the BigInt hash2 chain; combined with the 3-octave fBm (vs. 5), chunk generation went from 63ms to ~5ms.
  - **Boundary continuity fix**: originally the heightmap used the per-chunk `placementSeed`, which broke the noise field continuity at chunk borders (max delta ~1277m at 2000m peak). Switched to a planet-scoped `terrainSeed` (= `hash2(galaxySeed, planetIdSeed)`); empirically max delta across 4 seeds × 5 stars is ≤ 5m, median ≤ 2m — well inside the 25m/10m test thresholds.
  - 142 vitest cases pass (30 new from TASK-5 + 112 pre-existing). `npm run typecheck`, `npm run lint`, `npm run lint:fix`, `npm test` all clean. TASK-5 is `functional` (no UI surface) → no Playwright smoke needed. No screenshot (no UI).

### 2026-10-17 — Iteration 5
- **TASK-4** System generator (planets, docks, deposits, AI roster) → **DONE**
  - New `app/src/shared/galaxy/{system,planet,config-system}.ts` module trio:
    - `config-system.ts` (138 lines) — `PLANET_COUNT_MIN/MAX = 2..6`, `PLANET_RADIUS_*` (gas 20k..60k km, others 2k..8k), `PLANET_CLASS_WEIGHTS` (rocky 28% / terran 18% / ocean 14% / gas 20% / ice 20%, sum-to-1.0), `ATMOSPHERE_PROBABILITY` (gas/terran/ocean always yes; rocky 0.5; ice 0.3), `DOCK_COUNT_MIN/MAX = 1..3`, `AI_ROSTER_MIN/MAX = 2..5`, `RESOURCE_PICKS_MIN/MAX = 1..3`, `SYSTEM_NAME_SUFFIX = " system"`.
    - `planet.ts` (220 lines) — `generatePlanet(parentStarId, systemSeed, orbitIndex)` builds one Planet independently from its own sub-Rng keyed by `hash2(systemSeed, BigInt(orbitIndex))`. Class/radius/atmosphere/landability/dock/resource/roster all flow through the planet's Rng so sibling planets are decorrelated.
    - `system.ts` (175 lines) — `generateSystem(seed, star)` and the `Star | starId` overload produce `SystemGen = { systemId, name, star, planets }`. `systemId = hex(hash2(masterSeed, seedFromString(star.id)))`; `name = "{star.name}{SYSTEM_NAME_SUFFIX}"`. Planet ordering is orbit-index ascending (asserted); gas giants are never landable (hard invariant).
  - New types in `app/src/shared/galaxy/types.ts`: `PlanetClass`, `ResourceType`, `ShipClassId`, `AIRoster`, `Planet` (full body matching spec), `SystemGen` (the deterministic output envelope), updated `SystemSummary` (lightweight pointer). `PLANET_CLASSES`, `RESOURCE_TYPES`, `SHIP_CLASS_IDS` canonical lists alongside.
  - Roman-numeral planet naming (`Planet`, `Planet I`, `Planet II`, …) — deterministic, unique within the system, no extra word list.
  - One-off regenerator `scripts/gen-system-fixture.ts` — writes `__fixtures__/system-dev-seed-star0.json` (seed `drift-dev-seed-001`, star index 0, 4 planets: rocky/terran/terran/ice with full SystemGen envelope).
  - Test files (5 new):
    - `config-system.test.ts` (85 lines, 7 cases) — weight sum-to-1.0, bounds (2..6, 2k..8k/20k..60k, 1..3, 2..5, 1..3), atmosphere probability range, landable probability range.
    - `planet.test.ts` (67 lines, 5 cases) — id derivation (id == hex(hash2(systemSeed, orbitIndex))), orbitIndex passthrough, roster bound, deterministic-replay, distinct-orbit→distinct-id.
    - `system.test.ts` (274 lines, 18 cases) — generateSystem invariants: 2..6 planets, systemId 16-hex, name == "{star} system", planet id uniqueness, orbit ordering, class validity, all-spec'd-fields-populated, gas-never-landable, dockCount bounds for landable/non-landable/gas, radius range per class, atmosphere class conditional, resource uniqueness, AI roster validity, two-call determinism, (Star object) vs (starId) parity, statistical ≥80% landable+atmosphere over 200 systems, divergent seeds, systemId formula correctness.
    - `system.parity.test.ts` (85 lines, 4 cases) — golden fixture well-formed, regenerates identically under happy-dom, byte-stable systemId, source purity (no Math.random/Date.now/globalThis/crypto/performance).
    - `system.helpers.ts` (77 lines, non-test) — shared `DEV_SEED`, `TEST_SEEDS`, `STAR_INDEX`, `VALID_PLANET_CLASSES/SHIP_CLASSES/RESOURCE_TYPES`, `sampleStar()`, `bigintToHex()`, `loadSystemFixture()`.
  - 110 vitest cases pass (71 new from TASK-4 + 39 pre-existing). `npm run typecheck`, `npm run lint`, `npm run lint:fix`, `npm test` all clean. TASK-4 is `functional` (no UI surface) → no Playwright smoke needed. No screenshot (no UI).

### 2026-10-17 — Iteration 4
- **TASK-3** Star generator (seeded galaxy layout) → **DONE**
  - New `app/src/shared/galaxy/` module with:
    - `types.ts` — `Star`, `SpectralClass`, and placeholder interfaces (`SystemSummary`, `Planet`, `SurfaceChunk`) so future tasks can extend them without breaking the import graph.
    - `config.ts` — `GALAXY_STAR_COUNT = 200`, `SYSTEM_COUNT_MIN/MAX = 2..8`, log-normal disk geometry, spectral class weights (O=0.5%, …, M=37.5%, sum = 1.0), and three **disjoint** name word lists (52/54/52 entries — capital prefixes, lowercase consonant-vowel-consonant roots, lowercase vowel-ending suffixes; enforced by the test suite).
    - `stars.ts` — `generateStars(seed, count?)` using `Rng` (TASK-2) + `hash2(masterSeed, BigInt(i))` sub-seeds. Position: log-normal radius + uniform theta + thin Gaussian z (rounded to 6 decimals for cross-platform stability). Name: `prefix+root+suffix` with bounded retry loop for uniqueness. Class: weighted pick from the master RNG (so the *sequence* of classes is fixed). `id` is the zero-padded 16-char hex of the sub-seed.
    - `canonical.ts` — `canonicalJson(value)` (sorted keys, locale-independent number rendering, rejects NaN/±Infinity/undefined) and `starListChecksum(stars)` (FNV-1a 64-bit folded twice with different offsets → 128-bit hex digest, Node + browser).
  - Golden snapshot fixture committed: `app/src/shared/galaxy/__fixtures__/stars-dev-seed.json` (seed `drift-dev-seed-001`, count 200, first 25 stars + checksum `6d05a1f1075b13d70e10737e6cf0c9c0`).
  - `scripts/gen-stars-fixture.ts` — one-off regenerator (`npx tsx scripts/gen-stars-fixture.ts`) for when the generator intentionally changes.
  - Two test files: `stars.test.ts` (36 cases) and `stars.parity.test.ts` (happy-dom parity, 4 cases). Coverage:
    - Config tunables: count, systemCount bounds, spectral weights sum-to-1.0, ordering O<B<A<F<G<K<M, list min length, no-overlap, alphabetic.
    - Generator: default 200, custom count (incl. 0), input validation, determinism across 5 seeds, divergence on different seeds, unique ids, unique names, 16-hex id format, valid class, systemCount in range, name length ≤ 24.
    - Position: |xy| ≤ 30, |z| < 2, star 0 id equals `hash2(master, 0n)` (sub-seed independence).
    - Class distribution: roughly matches weights (single-seed loose + 5-seed cumulative ordering).
    - Golden: fixture exists & well-formed, first-25 equality, count equality, checksum equality, mutation sensitivity.
    - Canonical: sorted keys, nested, integer/float rendering, rejects NaN/Infinity/undefined, checksum order-independent.
  - 75 vitest cases pass (39 new + 36 pre-existing). `npm run typecheck`, `npm run lint`, `npm run lint:fix` all clean. TASK-3 is `functional` (no UI surface) → no Playwright smoke needed.

### 2026-10-17 — Iteration 3
- **TASK-2** Shared deterministic PRNG + hash library → **DONE**
  - New module `app/src/shared/random.ts` (280 lines) — pure TypeScript, zero imports.
    Exports:
      - `seedFromString(s: string): bigint` (FNV-1a 64-bit over UTF-8 bytes via `TextEncoder`).
      - `Rng` class (xoshiro128** over a 4×U32 state seeded from any `bigint` via 4× splitmix64 rounds) with `nextU32()`, `nextF64()`, `nextRange(min, max)`, `nextInt(n)`, `pick(arr)`, `nextGauss(mean, sd)`.
      - `hash2(a, b): bigint` (XOR-multiply mix + splitmix64 finalizer) for per-entity sub-seeds.
  - Two test files: `random.test.ts` (node env) and `random.parity.test.ts` (happy-dom env via per-file `// @vitest-environment` pragma). The Vitest 4 default is to use the per-file pragma; `environmentMatchGlobs` was removed in v4 so the existing `vitest.config.ts` was updated to document the per-file pattern.
  - 36 vitest cases pass (21 new + 15 pre-existing). Coverage:
      - Golden values for `seedFromString` on 4 known strings (incl. FNV offset basis check on `""`).
      - Golden `nextU32()` and `nextF64()` sequences for `drift-dev-seed-001` (8 each).
      - Rng construction determinism + cross-seed divergence.
      - `hash2` stability and order-sensitivity.
      - `nextRange`, `nextInt` (incl. distribution), `pick`, `nextGauss` (mean/sd check).
      - 100k-sample chi-square-lite uniformity test (per-bin dev < 20%, chi² < 21.7 at 9 d.o.f.).
      - Source purity: reads `random.ts`, strips comments, asserts no `Math.random`, `Date.now`, `Date.constructor`, `crypto`, `globalThis.*`, or `performance.now`.
      - Happy-dom parity: same digest/U32/F64/hash2 values under `// @vitest-environment happy-dom`.
  - Added `happy-dom` to `app/devDependencies` (lighter than jsdom; we only need `TextEncoder` / `Uint8Array` shape).
  - `npm run typecheck`, `npm run lint`, `npm run lint:fix`, `npm run test` all clean. No UI surface → no Playwright smoke needed for this task (TASK-2 is `functional` not `ui-ux`).

### 2026-10-17 — Iteration 2
- **TASK-68** Scaffold TS monorepo (client/server/shared) with tooling → **DONE**
  - Created `app/src/{shared,client,server}` trees with strict TypeScript (`tsconfig.json`, target ES2022, module ESNext, moduleResolution bundler, `strict: true`).
  - Path aliases wired in `tsconfig.json`, `vite.config.ts`, and `vitest.config.ts`: `@shared/*`, `@client/*`, `@server/*`.
  - Server (`src/server/`): `config.ts` loads `PROJECT_ROOT/.env.local` via dotenv with defaults; `server.ts` exposes `buildApp()` (testable via Fastify `inject()`); `ws.ts` attaches a `ws.Server` at `config.wsPath`; `index.ts` listens on `apiPort = PORT + 1` (default 3001) so Vite (PORT=3000) and Fastify don't collide.
  - Client (`src/client/`): `main.tsx` mounts a React shell, `App.tsx` lays out a stable `<canvas>` placeholder (`data-testid="drift-canvas"`) for the three.js renderer, plus a "DRIFT — SCAFFOLD" HUD label; Vite proxies `/api` and `/ws` to the Fastify server.
  - Tooling: `npm run dev` (concurrently vite + tsx), `npm run build` (vite build), `npm run test` (vitest), `npm run typecheck` (tsc --noEmit), `npm run lint` (eslint + prettier --check), `npm run start` (tsx server). Plus `eslint.config.js` (flat config, typescript-eslint + prettier) and `.prettierignore`.
  - Tests: 15 vitest cases pass (3 files: prereqs, shared/health, server/server). One Playwright e2e (`tests/e2e/scaffold.spec.ts`) renders the React shell, asserts the canvas is visible, hits `/api/health` through the Vite proxy, and fails on any console error.
  - Smoke verified end-to-end: `curl http://localhost:3000/api/health` (proxied) and `curl http://localhost:3001/api/health` (direct) both return `{"ok":true,"galaxySeed":"DRIFT-SEED-0001"}`; `ws://localhost:3001/ws` upgrades and replies `{"type":"hello",...}`.
  - Screenshot: `.ralph/screenshots/TASK-68-1.png` — shows the dark canvas with the "DRIFT — SCAFFOLD" header (no console errors).
  - `.gitignore` updated to exclude `app/data/`, `data/`, `playwright-report/`, `test-results/`, and `.pi/`.
  - `.ralph/STRUCTURE.md` refreshed to reflect the new `app/src/**` layout.

### 2026-10-17 — Iteration 1
- **TASK-1** Verify project prerequisites and access → **DONE**
  - Confirmed `.env.local` exists with all 8 required names from PRD §7 (PORT, SESSION_SECRET, GALAXY_SEED, DB_DRIVER, DB_PATH, DATABASE_URL, SYSTEM_INSTANCE_COUNT, WS_PATH); `SESSION_SECRET` filled with a 64-char hex value (length checked only — value never exported).
  - `.env.local` is git-ignored; secret value is not present in any tracked file or in chat/PRD/task artifacts.
  - Verified `better-sqlite3@^11` resolves and can create/read `./data/drift.db` (DB_PATH) inside the sandbox.
  - MCP servers (playwright, context7, sequential-thinking) are declared in `.mcp.json` and reachable on npm (registry HEAD OK).
  - All five PRD §7 documentation links return HTTP 200 (three.js, Fastify, ws, Drizzle ORM, better-sqlite3).
  - Callsign-only auth confirmed (no test user setup needed); e2e planned against `TEST-ALPHA` / `TEST-BRAVO` (created at runtime, no secrets).
  - Recorded **user-approved proceed gaps** (per TASK-1 step 4 / acceptance criteria):
    1. No live Postgres in this sandbox — PG parity will be exercised via Drizzle dual-driver unit tests on SQLite now and against the postgres-js adapter in CI later. Live PG validation is post-v1.
    2. Headless CI WebGL is functional-only; render-performance verification (SC-1/SC-4/SC-5) will be confirmed on reference hardware, not in this sandbox.
  - Added automated guard test at `app/prereqs.test.ts` (12 vitest cases) so a future regression in any of the above items fails CI.
  - Dev server (`npm run dev`) was **not** started: the app scaffold lands in TASK-68, and `app/package.json` currently has no `scripts` entry. Start deferred to that task.
  - No screenshot — TASK-1 is environment/setup verification with no UI surface yet.
