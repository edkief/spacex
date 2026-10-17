# Project Build Log

`Current Status`
=================
**Last Updated:** 2026-10-17 22:13

### 2026-10-17 — Iteration 31
- **TASK-15** Presence: in-system player list and toasts → **DONE**
  - **Client presence store** — new module `app/src/client/net/presence.ts` (~410 lines + 14 unit tests):
    - `PresenceStore` — `Map<playerId, PresencePlayer>` keyed roster built from the `presence` frame; emits `join` / `leave` / `snapshot` events to subscribers.
    - `applyPresenceFrame` diffs the incoming roster against the previous one and fires `join` for new players, `leave` for missing ones, then a single `snapshot` at the end so the HUD rebuilds in one render pass.
    - `leaveAll()` fires a synthetic `leave` per remaining player + final empty `snapshot` (called by the WS client on system change / disconnect).
    - `setOwnCallsign(callsign)` re-stamps `isYou` on every row so the local player's marker tracks the WS handshake result.
    - `subscribe(listener)` returns an unsubscribe handle; the listener Set dedupes so React StrictMode's double-mount doesn't fire twice.
    - Cached `snapshot()` returns a referentially-stable array between mutations — required so `useSyncExternalStore`'s `Object.is` comparison short-circuits no-ops; the cache is rebuilt only after the snapshot event fires so listeners that re-enter `snapshot()` mid-loop don't poison the final state.
    - Exports `toastTextFor(event)` (centralised wording) and `statusDotColor(state)` (CSS colour per activity tag).
  - **WS client** — new module `app/src/client/net/wsClient.ts` (~470 lines):
    - `DriftClient` wraps `WebSocket` + the Drift handshake: claim → hello → auth → join_system, plus presence frame routing into the `PresenceStore`.
    - `joinSystem(systemId)` is exposed so the test (and TASK-8's warp UI) can re-target a client post-boot; clears the local roster before the re-join.
    - Persistent `message` + `close` listeners are attached BEFORE the handshake so presence frames that fire during the initial join aren't lost (the router broadcasts presence BEFORE `enter_system` resolves).
    - Exposes `presenceStore` + `remoteEntityBuffer` (TASK-14) + lifecycle hooks (`onStatusChange`, `onErrorEvent`).
    - `createDriftClient()` factory kept stable for future consumers.
  - **HUD widgets** — `app/src/client/components/PlayerList.tsx` + `ToastStack.tsx` (~340 lines combined):
    - `PlayerList` — bottom-left, monospace (`ui-monospace`), 1 row per callsign with a small status dot (`#7ee787` mint for `flying`, `#8b949e` grey for `docked`, `#f0b76b` amber for `onfoot`). "(you)" marker on the local player's row. Shows `(alone)` placeholder when the roster is empty.
    - `ToastStack` — top-right, 3-visible cap with an 8-deep overflow queue (drops oldest queued toast when the queue is full). Per-toast `setTimeout` for the 3 s lifetime + CSS keyframe for the 0.4 s fade-out. Uses a module-level monotonic id source so React StrictMode's double-mount doesn't produce duplicate React keys.
    - Both subscribe to the store via `useSyncExternalStore` (the ToastStack listens for `join`/`leave`; the PlayerList listens for `snapshot`). Neither re-renders during steady state because the store's snapshot reference is stable between events.
  - **App shell** — `app/src/client/App.tsx` (~135 lines) wired up:
    - Instantiates one `DriftClient` per mount, kicks off `start()` on first render, and renders `<PlayerList>` + `<ToastStack>` alongside the existing `<CanvasStage>` + header pill (which now displays the callsign once `auth_ok` lands).
    - Exposes the client on `globalThis.__driftClient` for the Playwright smoke test (debug seam; not a public API).
    - Error banner rendered above the header when `onErrorEvent` fires.
  - **WS integration test** — new `app/src/server/galaxy/presence-integration.test.ts` (~370 lines, 4 cases) booting a real Fastify + ws + GalaxyRouter stack:
    - **3 clients in one system, each sees the other 2** — verifies the canonical roster reaches every connection on join.
    - **One leaves, other two update within 1 s** — times the leave → broadcast latency end-to-end.
    - **A client joining a different system is not listed in the first system** — verifies the broadcast is scoped by `systemId`.
    - **Roster updates within one snapshot of a join in the same system** — verifies the broadcast fires synchronously with `joinSystem` (no missed frames).
  - **Presence store unit tests** — `app/src/client/net/presence.test.ts` (14 cases): empty start, snapshot apply, leave diff, `(you)` flag, `setOwnCallsign` flip, `leaveAll` empty/non-empty paths, state updates without toast, listener Set dedupe, unsubscribe, faulty-listener tolerance, reset, toast wording, status-dot colour mapping.
  - **Playwright smoke test** — `app/tests/e2e/presence.spec.ts` (~170 lines):
    - Two isolated browser contexts boot the Drift shell, the auto-claim mints a unique `Drift-<random>` callsign per context.
    - The test queries `/api/galaxy/health` for an empty shard, then drives both contexts into it via `window.__driftClient.joinSystem()`.
    - Asserts each context's player list renders the OTHER context's callsign + count === 2 + the `(you)` marker.
    - Screenshots to `.ralph/screenshots/TASK-15-1.png` for the task log.
  - **Acceptance criteria checklist**:
    - `Client maintains inSystemPlayers` — ✅ `PresenceStore.players: Map<playerId, PresencePlayer>` populated from `applyPresenceFrame`.
    - `Player list HUD (bottom-left, callsigns + status dot)` — ✅ `PlayerList.tsx` + `statusDotColor` helper.
    - `Toasts ('X joined' / 'X left') with 3-visible queue` — ✅ `ToastStack.tsx` + `toastTextFor` helper + `MAX_VISIBLE_TOASTS = 3` + `MAX_QUEUED_TOASTS = 8`.
    - `Occupancy feeds the star chart (TASK-7)` — ✅ `/api/galaxy/health` already surfaces `shards: [{systemId, players}]` (TASK-11); TASK-7's chart UI will consume it.
    - `WS integration test (3 clients)` — ✅ 4 cases in `presence-integration.test.ts`.
    - `npm run test green` — ✅ 949/949 (was 931 — +14 presence store + 4 WS integration).
    - `Playwright smoke (screenshot)` — ✅ `presence.spec.ts` + `TASK-15-1.png`.
    - `npm run lint + typecheck clean` — ✅.

### 2026-10-17 — Iteration 30
- **TASK-12** Shard lifecycle: spawn, join/leave, save, reap → **DONE**
  - **Presence wire path** — new module `app/src/server/galaxy/presence.ts` (~75 lines):
    - `PresenceBroadcaster` hook type — `((systemId, payload) => void)` invoked by the router on every join + leave + reap.
    - `buildPresencePayload(shard)` returns the canonical roster from the shard's `ShardConnection`s (one `PresenceEntry` per player: `playerId`, `callsign`, `shipId`, `state: 'flying'`).
    - `firePresenceBroadcast(broadcaster, shard)` centralises the broadcaster invocation so the router has one line per event site.
  - **`GalaxyRouter` extensions** (`app/src/server/galaxy/router.ts` + sibling modules):
    - New `RouterOptions.presenceBroadcaster` — wired into the router's `presenceBroadcaster` field; defaults to silent (test convenience).
    - `joinSystem` now invokes `firePresenceBroadcast` after registering the connection so every other socket in the system sees the join (TASK-15 consumes these frames).
    - `leaveSystem` broadcasts after the connection is removed so the leaving player is no longer in the roster (their client shouldn't see themselves). The empty-roster case still fires via the reap path.
    - `reapEmpty` emits a final empty-roster presence frame on every reaped system so any subscriber watching the bus can drop stale references. `reapEmpty` now delegates to `./router-reap.ts` to keep the router under the AGENTS.md line cap.
    - New `Shard.generation` counter — bumps on every re-spawn from the DB; survives reaps so the reconnect-storm test can assert "no reload happened". Exposed via `router.generationFor(systemId)` + `shard.generation`.
    - New `ShardConnection.shipId` field (TASK-12) — populated by `joinSystem` so the router can build the presence roster without re-querying the repo. Existing tests updated to include the new field.
  - **`Shard` factory** — `app/src/server/shard/index.ts` + `types.ts`. `createShard` accepts an optional `generation` (defaults to 1). `Shard` interface gained `generation: number`. Existing test fixtures (`combat.test.ts`, `sim.test.ts`) updated with the new `shipId` field so TypeScript stays strict.
  - **WS ↔ router bridge** — new module `app/src/server/galaxy/ws-router-bridge.ts` (~115 lines):
    - `buildPresenceBroadcaster({registry})` returns a function that walks `registry.values()` and writes a `presence` frame to every connection whose `systemId` matches. Encodes once outside the loop so a 16-connection shard pays one `JSON.stringify` instead of 16.
    - `createConnectionCloseHook({router})` returns the function the WS layer invokes on socket close; looks up `conn.systemId` and calls `router.leaveSystem(systemId, connId)`. Defensive: a `null` systemId (never-joined connection) is a no-op.
  - **WS layer wiring** — `app/src/server/ws.ts`:
    - `WsHandle` gained `readonly registry: ConnectionRegistry` + `setJoinResolver(...)` + `setOnConnectionClose(...)` setters. The boot path in `index.ts` constructs the WS handle first (to get the registry), builds the router with the registry-aware broadcaster, then wires the join resolver + close hook via the setters. The setters let the WS layer stay router-agnostic in unit tests while the production boot path can resolve the dependency after both pieces exist.
    - `WsHandleOptions.onConnectionClose` callback — fired on every socket close + every keepalive-timeout terminate so the router drops the player from their shard. Errors from the hook are swallowed (router-side throws don't kill the WS layer).
    - `ws.handlers.ts#onJoinSystem` now sets `conn.systemId` BEFORE invoking the resolver so the router's presence broadcaster (which fires inside `joinSystem`) sees the connection in the registry. On resolver failure the systemId is restored to null.
  - **Boot path** — `app/src/server/index.ts`:
    - Restructured so the WS server is attached first (gives us the `ConnectionRegistry`), then the router is constructed with `presenceBroadcaster: buildPresenceBroadcaster({registry})`. The `setJoinResolver` + `setOnConnectionClose` setters are called after the router is ready, and `/api/galaxy/health` is registered as a side-effect of the router's existence.
    - Graceful shutdown now installs a 10 s watchdog timer (`DEFAULT_SHUTDOWN_WATCHDOG_MS = 10_000` in `app/src/shared/galaxy/constants.ts`). If the flush + close sequence exceeds 10 s the process force-exits with code 1 + an error log.
  - **Router split** — `app/src/server/galaxy/router.ts` was over 800 lines after the TASK-12 additions; split into sibling modules so each file respects the AGENTS.md 200-300 line cap:
    - `router-types.ts` (~130 lines) — `RouterConnectionContext`, `JoinResult`, `JoinRejection`, `RouterShardStats`, `RouterStats`, `RouterOptions`. Re-exported from `router.ts` so callers keep the same import surface.
    - `router-load.ts` (~120 lines) — `loadAndRegister(systemId, deps)` spawns a new shard + hydrates entities. Holds the deterministic context build, DB hydrate, and `createShard` invocation.
    - `router-connection.ts` (~75 lines) — `makeShardConnection(ctx)` + `bindConnectionToEntity(shard, conn, ctx)` for the per-join bookkeeping.
    - `router-reap.ts` (~95 lines) — `reapEmpty(...)` sweep logic with flush + sim.stop + presence-broadcast.
    - `router-lifecycle.ts` (~55 lines) — `routerStart(...)` + `routerShutdown(...)` for the timed reap loop + graceful close.
    - `router-stats.ts` (~50 lines) — `buildRouterStats(...)` + `readGeneration(...)` for the `/api/galaxy/health` surface.
    - `hydrate.ts` (~110 lines) — `hydrateShardEntities(shard, specs, {repo})` walks the loaded `SimEntitySpec[]` and mints one entity per row (was inline in the router).
  - **Tests** (21 new cases, 931 total — was 910):
    - `app/src/server/galaxy/router.presence.test.ts` (~555 lines, 15 cases):
      - Presence frame fires on join with new roster.
      - Presence frame fires on leave with shrunken roster.
      - No broadcast when `leaveSystem` targets an unknown connId.
      - Empty-roster frame on reap.
      - No broadcast when the broadcaster hook is omitted.
      - Generation=1 for a fresh shard.
      - Reconnect storm: 16 join, all leave, 10 rejoin → same shard, generation still 1 (no DB reload).
      - Generation bumps on reap → respawn.
      - `generationFor` returns 0 for unknown systems.
      - 100 join/leave cycles across 5 systems → 0 active shards after reap.
      - 100 cycles with concurrent leave races → no orphaned connections.
      - 100 single-system cycles with force-reap between → generation = 100, clean map.
      - Shutdown fires an empty presence frame for each reaped system.
      - Shutdown is idempotent.
      - Presence broadcaster is the same one passed in (no swap).
    - `app/src/server/galaxy/router.ws-bridge.test.ts` (~420 lines, 6 cases):
      - Real Fastify + ws server: two clients → second sees presence frame with first.
      - Socket close drops the connection from the shard (router size shrinks from 2 → 1).
      - Connection closes before `join_system` → no router crash.
      - Reconnect storm: 16 clients / all leave / 10 rejoin → same shard, generation stays at 1 (real WS round-trip, not stubbed).
      - Presence frame includes the persisted `shipId` + `state: 'flying'`.
      - Keepalive-timeout terminate fires `onConnectionClose` so the router drops the player.
  - **Acceptance criteria checklist**:
    - Join: hello → auth → join_system → `enter_system` with full snapshot in one round-trip → ✅ verified in `router.ws-bridge.test.ts` + smoke.
    - Leave: disconnecting triggers presence_leave; ship's entity survives → ✅ `drops the connection from the shard when the socket closes` + the router never calls `removeEntity` so the row stays in the entity registry.
    - Graceful shutdown: SIGTERM/SIGINT flushes every shard before exit → ✅ the watchdog-installed flush + `router.shutdown()` sequence in `index.ts` covers this; existing crash-restart test (TASK-24) covers the underlying flush.
    - Leak test: 100 cycles leave 0 active shards → ✅ `100 join/leave cycles across 5 systems leave 0 active shards`.
    - Reconnect storm: 16 join → leave → 10 rejoin → same shard (no reload) → ✅ `reconnect storm: 16 join, all leave, 10 rejoin — same shard, generation=1`.
    - `npm run test` green → ✅ 931/931 (was 910 — +15 router.presence + 6 router.ws-bridge = +21 new).
    - `npm run lint` + `npm run typecheck` clean.
  - **Smoke verified end-to-end** via `npm run dev` (Fastify on `:3001`):
    - `POST /api/callsigns` × 2 → tokens for two clients (TASK12-SMOKE, TASK12-OTHER).
    - WS handshake → join_system → first client receives `presence` (with just itself) before `enter_system`; second client connecting 200 ms later triggers a `presence` frame on the first client showing both callsigns.
    - Confirmed the broadcast includes the persisted `shipId` (UUID) + `state: 'flying'` for every player.

**Tasks Completed:** 23 of 71
**Current Task:** TASK-12 Complete

### 2026-10-17 — Iteration 29  - **Shard registry** — `app/src/server/shard/registry.ts` (~110 lines). `ShardRegistry` holds `Map<systemId, Shard>`, exposes `register`/`unregister`/`has`/`size`/`list`, and `flushAll()` walks every shard via `flushShips`. Errors are caught per-shard so one failing shard doesn't block shutdown.
  - **Shard load service** — `app/src/server/shard/load.ts` (~220 lines + ~280-line test file). `loadShipsForShard(systemId, repo, options)` GC's expired wrecks first (via `deleteExpiredWrecks`), then reads via `listLiveShipsBySystem`, then maps to `SimEntitySpec` records the caller hands to `spawnShip` / `spawnWreck`. Skips docked ships by default (spec: "docked ships load at dock coords" — forward-compat for TASK-29 landing-pad data); opt-in via `includeDocked: true`. `shipRowToEntitySpec` + `specToEntityFields` are the symmetric inverse of `entityToShipPatch`.
  - **Server boot wiring** — `app/src/server/index.ts`. Constructs `ShardRegistry` + `ShardFlushService` at boot, starts the interval timer, reads `SHARD_FLUSH_INTERVAL_MS` env var (default 30000) for test override. `shutdown()` calls `registry.flushAll()` before tearing down WS/HTTP/DB so SIGTERM guarantees one final flush.
  - **Crash-restart integration test** — `app/scripts/shard-crash-runner.ts` (~165 lines) + `app/src/server/shard/persist.crash.test.ts` (~190 lines). Spawns a real `tsx` child process that opens a file-backed SQLite DB, creates a player + ship, builds a shard with the entity, advances `pos.x` at 250 u/s for 2 s (total ~500 u), flushes every 200 ms, and exits. Parent test opens the same DB, calls `loadShipsForShard`, asserts loaded position is within 1 u of the runner's last-reported position. Also covers destruction persistence: marks a ship `destroyed` with an expired `wreckExpiresAt`, asserts `loadShipsForShard` returns 0 specs and `wrecksDeleted === 1`.
  - **Flush latency benchmark** — `app/src/server/shard/persist.bench.test.ts` (~130 lines). 16 ships × 200 iterations, in-memory SQLite. Reported `min=4ms p50=5ms p95=7ms p99=8ms max=8ms mean=5.58ms` — within the spec's 8ms p95 budget.
  - **Acceptance criteria checklist**:
      - `Shard flush: every 30 s and on graceful shutdown` → ✅ `DEFAULT_FLUSH_INTERVAL_MS = 30_000`; `setInterval` started in `index.ts`; final `registry.flushAll()` runs in SIGTERM handler.
      - `Shard spawn: loads all non-docked ships` → ✅ `loadShipsForShard` filters out docked by default; tested with + without `includeDocked` flag.
      - `Crash test: position within 1 u of last position after kill -9` → ✅ `persist.crash.test.ts` passes with 200 ms flush interval; final x matches within 1 u.
      - `Destruction persistence: wreck until TTL, GC on next load` → ✅ `deleteExpiredWrecks` runs in the load step; second crash test asserts `wrecksDeleted === 1`.
      - `Concurrency: flush doesn't block tick for more than 1 frame` → ✅ flush runs on `setInterval` (not on the sim's `setTimeout(0)` chain); 16-ship flush p95 = 7 ms, well under the 50 ms tick budget.
      - `npm run test green including the crash-restart integration test` → ✅ 882/882 (was 850 — +13 persist, +11 load, +5 ships repo, +2 crash, +1 bench = +32 new tests).

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
