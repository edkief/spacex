# Project Directory Structure

Snapshot taken 2026-10-18 after **TASK-8** (Inter-system warp flow: WS warp frame + server flush/leave/join + WarpStore + WarpOverlay + WarpResolver).

## Conventions
- Dotfiles (`.env*`, `.git*`, `.mcp.json`, `.eslintrc*`, …) are excluded.
- Test files (`*.test.ts(x)`) are excluded from the tree listing.
- Configuration/build output (`dist/`, `node_modules/`, `playwright-report/`,
  `test-results/`) is excluded.
- Generated artefacts under `.ralph/history` and `.ralph/screenshots/*.png`
  are excluded by `.gitignore`.

## Top-level layout
```
PROJECT_ROOT
├── AGENTS.md                    # Agent conventions (read first)
├── CLAUDE.md                    # Stub pointer to AGENTS.md
├── app/                         # Drift TS monorepo (TASK-68)
│   ├── data/                    # Runtime SQLite DB lives here (gitignored)
│   ├── dist/                    # Vite build output (gitignored)
│   ├── eslint.config.js         # Flat ESLint config + prettier integration
│   ├── node_modules/            # Installed deps (gitignored)
│   ├── package-lock.json
│   ├── package.json             # Scripts: dev, build, test, test:e2e, typecheck, lint, snapshot:update
│   ├── playwright.config.ts     # Playwright e2e config — fixture spawns its own dev server per worker; chromium-1248 executablePath override (TASK-70)
│   ├── prereqs.test.ts          # TASK-1 prerequisite guard tests
│   ├── src/
│   │   ├── shared/              # Wire types/utilities shared client+server
│   │   │   ├── galaxy/          # Seed-derived galaxy geometry (TASK-3+4+5)
│   │   │   ├── regime.ts        # TASK-25 — Regime = 'space'|'atmosphere'|'surface' + regimeFor() pure resolver + HYSTERESIS_FACTOR + SURFACE_PROXIMITY_M
│   │   │   ├── regime.test.ts   # 33 cases: boundary math + hysteresis + forbidden transitions + determinism (node)
│   │   │   ├── regime.parity.test.ts # happy-dom parity snapshot (node vs browser)
│   │   │   ├── regime-planets.ts # TASK-25 — deterministic planetWorldPosition(seed, starId, orbitIndex) + regimePlanetContexts() builder for the sim
│   │   │   ├── regime-planets.test.ts # 16 cases: position determinism + context shape + orbit spacing
│   │   │   │   ├── types.ts          # Star, Planet, SystemGen, Biome, ResourceNode, LandingPad, SurfaceChunk (TASK-3, 4, 5)
│   │   │   │   ├── config.ts         # GALAXY_STAR_COUNT, spectral weights, name lists (TASK-3)
│   │   │   │   ├── config-system.ts  # Planet count, radius, AI roster, dock, resource, atmosphere bounds (TASK-4)
│   │   │   │   ├── config-surface.ts # Chunk geometry, fBm, biome thresholds, node/pad placement (TASK-5)
│   │   │   │   ├── stars.ts          # generateStars(seed, count?) — keystone of SC-2
│   │   │   │   ├── system.ts         # generateSystem(seed, star | starId) — TASK-4 entry point
│   │   │   │   ├── planet.ts         # generatePlanet per orbit slot
│   │   │   │   ├── surface.ts        # generateSurfaceChunk(seed, planet, cx, cz) — TASK-5 entry point
│   │   │   │   ├── surface-noise.ts  # Value noise + fBm + heightmap + biome classifier (TASK-5)
│   │   │   │   ├── surface-placement.ts # Resource-node + landing-pad placement (TASK-5)
│   │   │   │   ├── canonical.ts      # canonicalJson + starListChecksum (Node + browser)
│   │   │   │   ├── system.helpers.ts # DEV_SEED, sampleStar, bigintToHex, fixture loader (shared by test files)
│   │   │   │   ├── surface.helpers.ts # Surface fixture loader + sampling helpers (TASK-5)
│   │   │   │   ├── travel.ts         # Travel/warp-time table + planar projection + 3-nearest-neighbour edges (TASK-7)
│   │   │   │   ├── travel.test.ts    # 21 cases: conversions + symmetry + projection (TASK-7)
│   │   │   │   ├── overview.ts       # buildGalaxyOverview(seed, starCount, currentSystemId) — chart payload (TASK-7)
│   │   │   │   ├── overview.test.ts  # 9 cases: payload shape + layout determinism (TASK-7)
│   │   │   │   ├── config-system.test.ts  # Integer-bound and weight-sum assertions (TASK-4)
│   │   │   │   ├── planet.test.ts         # generatePlanet direct-slot probe (TASK-4)
│   │   │   │   ├── system.test.ts         # generateSystem invariants + determinism + stats (TASK-4)
│   │   │   │   ├── system.parity.test.ts  # Same golden fixture under happy-dom + source purity (TASK-4)
│   │   │   │   ├── stars.test.ts          # Determinism / uniqueness / golden (TASK-3)
│   │   │   │   ├── stars.parity.test.ts   # Same output under happy-dom (TASK-3)
│   │   │   │   ├── surface.test.ts        # Shape / nodes / pads / determinism (TASK-5)
│   │   │   │   ├── surface.boundary.test.ts # Boundary continuity + biome distribution + stats (TASK-5)
│   │   │   │   ├── surface.parity.test.ts # Golden snapshot + source purity (TASK-5)
│   │   │   │   ├── snapshots.test.ts      # Full galaxy / system / surface deep-equal suite (TASK-6)
│   │   │   │   ├── snapshots.mutation.test.ts # Mutation-detection suite (TASK-6)
│   │   │   │   ├── snapshots.helpers.ts   # Snapshot suite helpers + mutated generator (TASK-6)
│   │   │   │   ├── properties.test.ts     # Property-style determinism suite: 10 seeds × 10 stars + 200 random (planet, chunk) pairs (TASK-71)
│   │   │   │   └── __fixtures__/
│   │   │   │       ├── README.md          # Regeneration rules for committed fixtures (TASK-6)
│   │   │   │       ├── stars-dev-seed.json          # First-25 + checksum parity fixture (TASK-3)
│   │   │   │       ├── stars-dev-seed-full.json     # Full 200-star chart deep-equal fixture (TASK-6)
│   │   │   │       ├── system-dev-seed-star0.json   # System of star #0 (TASK-4 + TASK-6)
│   │   │   │       ├── system-dev-seed-star1.json   # System of star #1 (TASK-6)
│   │   │   │       ├── surface-dev-seed-star0-planet0-chunk00.json  # Chunk (0,0) (TASK-5 + TASK-6)
│   │   │   │       ├── surface-dev-seed-star0-planet0-chunk10.json  # Chunk (1,0) (TASK-6)
│   │   │   │       └── surface-dev-seed-star0-planet0-chunk01.json  # Chunk (0,1) (TASK-6)
│   │   │   ├── health.ts        # HealthPayload interface + factory
│   │   │   ├── health.test.ts   # Trivial vitest (TASK-68 acceptance)
│   │   │   ├── galaxy/          # Shared galaxy constants (TASK-11)
│   │   │   │   └── constants.ts # MAX_PLAYERS_PER_SYSTEM + DEFAULT_SHARD_REAP_GRACE_MS + DEFAULT_ROUTER_REAP_INTERVAL_MS
│   │   │   ├── protocol/        # WS protocol: envelope + handshake + zod schemas (TASK-9 + TASK-14)
│   │   │   │   ├── index.ts          # PROTOCOL_VERSION, EnvelopeSchema, encode/decode, parseMessage, ProtocolError
│   │   │   │   ├── schemas.ts        # One zod schema per message type + PAYLOAD_SCHEMAS registry; EntityUpdateSchema now requires lastAppliedSeq map (TASK-14)
│   │   │   │   └── schemas.test.ts   # Parametrized valid/invalid + envelope round-trip + entity_update includes lastAppliedSeq (TASK-14)
│   │   │   ├── random.ts        # seedFromString + Rng (xoshiro128**) + hash2 (TASK-2)
│   │   │   ├── random.test.ts   # Golden / distribution / purity suite (node)
│   │   │   ├── random.parity.test.ts # Same golden values under happy-dom
│   │   │   ├── ships.ts         # SHIP_CLASSES + shipStats/compareShips/totalWeaponCount/shipPrice (TASK-19)
│   │   │   ├── ships.test.ts    # 32 cases: shape, stat validity, balance, helpers, throw on unknown
│   │   │   ├── physics/         # Deterministic ship flight model (TASK-22)
│   │   │   │   ├── vec.ts          # Vec3 + Quat math (plain objects, zero deps) + quatSlerp (TASK-14)
│   │   │   │   ├── vec.test.ts     # 26 cases: ops + rotations + orthonormal mat3 + quatSlerp (clamp, short-arc, lerp fallback, half-rotation accuracy)
│   │   │   │   ├── damage.ts       # applyDamage + repairCost pure math — shield-first, double-destroy guard, source attribution (TASK-23)
│   │   │   │   ├── damage.test.ts  # 31 cases: shield-first ordering + boundary cases + degenerate inputs + repair-cost table
│   │   │   │   ├── atmosphere.ts   # PlanetAtmosphere + boundaryFactor + dragCoefficient (shared with TASK-28)
│   │   │   │   ├── atmosphere.test.ts # 19 cases: ramp continuity + density scaling
│   │   │   │   ├── flight.ts       # integrateShip(state, input, dt, regime, shipClass, planet?) + helpers
│   │   │   │   ├── flight.test.ts  # 33 cases: space/atmo/VTOL/pad/speed cap/determinism/golden
│   │   │   │   └── __fixtures__/
│   │   │   │       ├── README.md            # Regeneration rules for committed fixtures (TASK-22)
│   │   │   │       └── trajectories.ts      # Golden 60s space + 30s atmo final states (TASK-22)
│   │   ├── client/              # React + three.js frontend (Vite)
│   │   │   ├── input/           # TASK-25 — controls remap per regime
│   │   │   │   ├── controls.ts    # ControlScheme per regime + Controls class with applyRegime() swap + shouldSnapToServer() divergence rule
│   │   │   │   └── controls.test.ts # 24 cases: scheme table + applyRegime transitions + listener fanout + divergence tolerance
│   │   │   ├── App.tsx          # Top-level shell — mounts CanvasStage + PlayerList + ToastStack + ChatLog + DriftClient (TASK-15 + TASK-16 wired up)
│   │   │   ├── components/      # UI sub-components (CanvasStage.tsx + PlayerList + ToastStack + ChatLog for TASK-15/16)
│   │   │   │   ├── PlayerList.tsx           # Bottom-left roster HUD — monospace + status dots + "(you)" marker (TASK-15)
│   │   │   │   ├── ToastStack.tsx           # Top-right toast column — 3-visible cap + 8-deep queue + 3 s lifetime + 0.4 s fade (TASK-15)
│   │   │   │   └── ChatLog.tsx              # Top-left chat panel — 100-message ring + Enter-toggled input + auto-escape (XSS-safe) + auto-scroll only when at-bottom (TASK-16)
│   │   │   ├── state/           # Client state machines (TASK-7 + TASK-8)
│   │   │   │   ├── warp.ts               # WarpStore — state machine: idle → warping-in → awaiting → warping-out → idle (TASK-7 stub; TASK-8 wires the WS flow)
│   │   │   │   └── warp.test.ts          # 21 cases: state transitions + helpers + faulty-listener tolerance (TASK-7)
│   │   │   ├── ui/              # Standalone full-screen UI overlays (TASK-7)
│   │   │   │   ├── StarChart.tsx         # Fullscreen DOM/SVG galaxy map overlay — systems + edges + occupancy + Warp button (TASK-7)
│   │   │   │   └── StarChart.test.tsx    # 15 cases: rendering + formatters + spectral colours (TASK-7)
│   │   ├── net/             # Client prediction + reconciliation (TASK-14) + WS glue + presence store (TASK-15) + chat store (TASK-16)
│   │   │   │   ├── prediction.ts          # ClientShipPredictor (local input → integrate → reconcile) + RemoteEntityBuffer (200 ms interp ring) + applyEntityUpdateToBuffer + simEntityFromWire + tuning constants
│   │   │   │   ├── prediction.test.ts     # 28 cases: input stamping, bit-equality with server integrator, blend/rewind/force-snap thresholds, queue cap + age overflow, 150 ms RTT acceptance, jittery 10 Hz remote interp
│   │   │   │   ├── presence.ts            # PresenceStore — in-system player roster Map<playerId, PresencePlayer> built from presence frames, join/leave diff events, cached snapshot for useSyncExternalStore, setOwnCallsign for "(you)" marker, toastTextFor + statusDotColor helpers (TASK-15)
│   │   │   │   ├── presence.test.ts       # 14 cases: apply/diff/leave/leaveAll, isYou stamping, listener dedupe, unsubscribe, faulty-listener tolerance, snapshot identity (TASK-15)
│   │   │   │   ├── chat.ts                # ChatStore — 100-message ring + cached snapshot for useSyncExternalStore + applyChatFrame + seedHistory + clear; formatChatLine + formatTime helpers (TASK-16)
│   │   │   │   ├── wsClient.ts            # DriftClient — WebSocket glue wrapping the Drift handshake (claim → hello → auth → join_system) + presence frame routing + chat frame routing + sendChat + post-boot joinSystem() for warp UI + auto-retry + resync (TASK-15 + TASK-16 + TASK-17)
│   │   │   │   ├── wsClient.test.ts       # 9 cases: auto-retry on close with exponential backoff (1s→5s capped), retry-budget exhaustion → 'lost', onResync event with preserved flag (same-system vs >60s gap), stop() cancels the loop, remote-entity buffers reset on resync, happy-path status transitions, exported retry defaults (TASK-17)
│   │   │   │   ├── notifications.ts       # NotificationStore — pub/sub for transient non-presence notifications (TASK-17 reconnect + connection-lost); subscribes the ToastStack to both the PresenceStore and the notification stream
│   │   │   │   ├── driftDebug.ts          # Dev-only `window.__DRIFT__` API: requestGalaxySeed + regenerateStarChart + regenerateSystem + regenerateSurfaceChunk (TASK-71); tree-shaken from production builds by `import.meta.env.DEV` guard
│   │   │   │   ├── driftDebug.test.ts     # 9 cases: cache lifecycle + override seam + installDriftDebug + determinism of regen* APIs (TASK-71)
│   │   │   ├── ships/           # Paint-zone + mesh-registry logic (TASK-21)
│   │   │   │   ├── ShipMeshBuilder.ts      # PaintZone enum + ShipPaintRegistry + MaterialAdapter interface + defaultLiveryFor + in-memory test adapter
│   │   │   │   ├── threeAdapter.ts          # three.js-backed MaterialAdapter factory (mutates Color in place)
│   │   │   │   └── ShipMeshBuilder.test.ts  # 24 cases: zone enumeration, defaults, idempotent build, in-place applyLivery, disposeShip/disposeAll
│   │   │   ├── perf/            # In-game frame monitor + dev-only overlay (TASK-57) — 300-frame circular buffer + 2 Hz overlay poll
│   │   │   │   ├── frameMonitor.ts          # FrameMonitor class: recordFrameTime + recordRendererInfo + recordEntityCount + recordCategoryCount + budgetCheck(name, ms, budgetMs, now?) rate-limited warn hook + pickPercentile helper
│   │   │   │   ├── frameMonitor.test.ts     # 27 cases: percentile math, rolling window wrap, FPS over 1 s, budget emission + cooldown, latest-wins renderer info, per-category counters, console-backed default logger
│   │   │   │   ├── DebugOverlay.tsx         # Dev-only top-right React panel; 2 Hz poll via setInterval; FPS/p50/p95/p99/draws/tris/ents rows with budget-threshold accents; F3-toggled via App.tsx
│   │   │   │   └── DebugOverlay.test.tsx    # 5 cases: closed returns null, every labelled row renders, stats reflect monitor snapshot, formatter shapes, overhead benchmark (< 1 ms p95 delta amortised)
│   │   │   ├── world/           # Surface chunk streaming pipeline (TASK-26) — 512 m render chunks, LOD mip chain, LRU cache, frame-sliced scheduler
│   │   │   │   ├── chunks.ts                # chunkKey + chunkCoordFor + lodFor + generateChunk + ChunkLruCache(400) + TriangleBudget(400k) + buildHeightGrid + buildLodGeometry + computeActiveSet + LRU eviction
│   │   │   │   ├── chunks.test.ts           # 48 cases: chunk math, LOD rings, LRU eviction, budget tracker, mip-chain math, 13-chunk benchmark, scripted-flight perf budget (median 2.71ms, p95 3.57ms)
│   │   │   │   ├── frameScheduler.ts        # FrameScheduler: per-frame time-sliced executor (4 ms budget) + FIFO queue + pushFront + clear + tick (returns completed count)
│   │   │   │   ├── frameScheduler.test.ts   # 11 cases: FIFO order, budget stop, single-task overrun, async fire-and-forget, clock-injected duration recording, completedCount
│   │   │   │   ├── pipeline.ts              # ChunkPipeline orchestrator: setPlayerPosition + tick (active-set + scheduler + LRU + budget) + onMount/onEvict/onLodChange/onBudgetCheck callbacks + getStats() for debug overlay
│   │   │   │   ├── pipeline.test.ts         # 13 cases: active-set population, nearest-first ordering, LOD budget recording, fast-movement 7×7 expansion, LRU eviction, mount/evict callbacks, determinism, dispose
│   │   │   │   └── index.ts                 # Barrel re-export of the public pipeline API
│   │   │   ├── index.html       # Vite HTML entry
│   │   │   ├── main.tsx         # React DOM bootstrap
│   │   │   └── public/          # Static assets served by Vite (favicon.ico)
│   │   └── server/              # Fastify + ws backend (tsx)
│   │       ├── config.ts        # dotenv loader + typed ServerConfig
│   │       ├── index.ts         # Entry: listen + graceful shutdown
│   │       ├── server.ts        # buildApp() factory (testable via inject) + registerGalaxyHealthRoute wiring (TASK-11)
│   │       ├── server.test.ts   # Fastify inject() smoke for /api/health
│   │       ├── persist.ts       # PersistService: save points + dirty-set + interval (TASK-63)
│   │       ├── persist.test.ts          # 27 cases covering save points + dirty flag (TASK-63)
│   │       ├── persist.crash.test.ts    # Child-process SIGKILL → loadSystemState round-trip (TASK-63)
│   │       ├── persist.bench.test.ts    # 16-ship dirty-flush perf benchmark (TASK-63)
│   │       ├── combat.ts        # applyCombatDamage + cleanupExpiredWrecks + broadcastCombatEvent + WRECK_TTL_S=600 (TASK-23) — server-side hook for weapons (TASK-43) + hazards (TASK-48)
│   │       ├── combat.test.ts   # 17 cases: shield-first on live entity, destroyed ships skip integration, double-destroy guard, wreck TTL cleanup, combat_event broadcast to all connections
│   │       ├── shard/         # Per-system authoritative sim (TASK-13 + TASK-14 + TASK-24)
│   │       │   ├── persist.ts       # flushShips + ShardFlushService (30s interval) + DEFAULT_FLUSH_INTERVAL_MS + entityToShipPatch (TASK-24)
│   │       │   ├── persist.test.ts   # 13 cases: full-patch round-trip, second-flush overwrite, docked state via onPad, wreck state, ShardFlushService timer idempotency, flushNow()
│   │       │   ├── persist.crash.test.ts # Real child-process crash + loadShipsForShard round-trip within 1u + destruction persistence
│   │       │   ├── persist.bench.test.ts # 16-ship × 200-iteration flush latency: p95 ≈ 7ms (spec ≤ 8ms)
│   │       │   ├── load.ts           # loadShipsForShard (deleteExpiredWrecks + listLiveShipsBySystem + shipRowToEntitySpec) + specToEntityFields + entityIdForSpec (TASK-24)
│   │       │   ├── load.test.ts      # 11 cases: empty system, scoped to systemId, skip docked + opt-in, expired-wreck GC, future-wreck preservation
│   │       │   ├── registry.ts       # ShardRegistry: Map<systemId, Shard> + flushAll() for graceful shutdown (TASK-24)
│   │       ├── ws.ts            # ws upgrade handler attached to Fastify (TASK-9; JoinResolver signature gained `connId` parameter in TASK-11 so the router can bind player entities to specific sockets)
│   │       ├── ws.connection.ts # Connection struct + ConnectionRegistry (TASK-9, extended with bucket/floodTracker/chatLimiter in TASK-65 + chatWindowLimiter in TASK-16; `connId` field added in TASK-11 so the router can bind ships to specific sockets)
│   │       ├── ws.dispatch.ts   # processRawFrame + dispatch + noteInvalidInput + noteRateViolation + INVALID_DROP_THRESHOLD=50 + MAX_MESSAGE_BYTES=64KB (TASK-9 + TASK-64 + TASK-65)
│   │       ├── ws.dispatch.helpers.ts # sendFrame + sendError + closeFloodedConnection (TASK-65)
│   │       ├── ws.handlers.ts   # onHello + onAuth + onJoinSystem + onChat per-state handlers (TASK-9 + TASK-65); onChat pipeline is validate→sanitize→rate-limit→broadcast (TASK-16)
│   │       ├── ws.resolvers.ts  # defaultAuthResolver + defaultJoinResolver stubs (TASK-9)
│   │       ├── ratelimit.ts     # TokenBucket + FloodTracker + ChatLimiter + constants (TASK-65)
│   │       ├── ratelimit.test.ts        # Unit tests: accept/accept/reject + sliding window + chat window (TASK-65)
│   │       ├── ratelimit.flood.test.ts  # Flood benchmark: attacker drops with code 4009 within 5 s (TASK-65)
│   │       ├── chat.ts         # ChatRingBuffer (100-entry FIFO) + ChatWindowLimiter (5/10s sliding) + sanitizeChatText (control+bidi strip, whitespace collapse) + validateChatText (length+empty+non-string) (TASK-16)
│   │       ├── chat.test.ts    # 24 cases: sanitize ranges + validate reasons + FIFO eviction + sliding-window reset + non-positive bounds (TASK-16)
│   │       ├── ws.ratelimit-helpers.ts  # Shared harness helpers for rate-limit integration tests (TASK-65)
│   │       ├── ws.ratelimit.test.ts     # Rate-limit integration: bucket + chat + escalation + isolation (TASK-65; chat paths now exercise TASK-16 surface)
│   │       ├── ws.chat.test.ts  # 9 cases: real Fastify+ws boot verifying broadcast (sender echo) + monotonic-ts ordering + 6/10s rate-limit drop + invalid-message on empty/long/non-string + control-byte sanitization + XSS inert-text wire round-trip + enter_system.chat history seed (TASK-16)
│   │       ├── ws.fuzz-helpers.ts # bootFuzzHarness + openFuzzClient + collectFuzzMessages (TASK-64)
│   │       ├── ws.fuzz-payloads.ts # 20 crafted malformed payloads + REQUIRED_FUZZ_NAMES + nestedObject/byteString builders (TASK-64)
│   │       ├── validation-fuzz.test.ts # 6 cases: 20-payload burst + 1 MB size cap + health hammered + threshold pin (TASK-64)
│   │       ├── ws.auth.test.ts # WS auth via real callsign/token resolver: claim, resume, duplicate, out-of-order (TASK-10)
│   │       ├── ws.test.ts       # Real Fastify+ws boot: handshake, errors, unknown-type, keepalive (TASK-9)
│   │       ├── ws.logout.test.ts # 7 cases: WS `logout` → `logout_ok` + 1000 close + concurrent-use + unauthenticated path (TASK-66)
│   │       ├── routes/          # REST route registrations
│   │       │   ├── repair.ts    # POST /api/ships/repair (TASK-23) — auth + docked + cost calc + atomic withdraw + restore
│   │       │   ├── galaxy-health.ts   # GET /api/galaxy/health (TASK-11) — auth-gated read-only stats surface (shardCount, totalPlayers, per-system players+uptime)
│   │       │   ├── galaxy-overview.ts   # GET /api/galaxy/overview (TASK-7) — cached chart payload (every system + 3 nearest-neighbour warp edges + chart positions)
│   │       │   ├── galaxy-overview.test.ts # 5 cases: 401 + 200 + cache + determinism (TASK-7)
│   │       │   ├── galaxy-health.test.ts # 4 cases: 401 missing token, 401 bad token, 200 empty stats, 200 with populated shard
│   │       │   ├── repair.test.ts # 11 cases: cost table per class + auth + not-docked + insufficient-credits + transaction rollback
│   │       │   ├── callsigns.ts # POST /api/callsigns + GET /api/session + POST /api/session/logout (TASK-10 + TASK-66)
│   │       │   ├── callsigns.test.ts # 11 cases: POST /api/callsigns + GET /api/session (REST integration via fastify.inject) (TASK-10)
│   │       │   ├── logout.test.ts # 12 cases: POST /api/session/logout revoke + double-logout + tampered/garbage tokens (TASK-66)
│   │       │   ├── players.ts # GET /api/players/me — callsign/credits/home/ship (TASK-41)
│   │       │   ├── players.test.ts # 8 cases: happy-path, reflected mutations, 401 paths, per-player isolation (TASK-41)
│   │       │   ├── ships.ts # GET /api/ships + POST /api/ships/buy (TASK-20) + POST /api/ships/livery (TASK-21) — current ship + dock purchase + persistent paint customization
│   │       │   └── ships.test.ts # 27 cases: starter on claim + happy-path buy for each class + all error paths + event-bus broadcast (TASK-20) + 11 livery endpoint cases: valid/invalid/partial hex, mid-flight rejection, livery-changed bus event, persistence round-trip (TASK-21)
│   │       ├── shards/          # In-process shard event bus (TASK-20; future TASK-11/15 consumers)
│   │       │   └── event-bus.ts # ShipSwapEvent + LiveryChangedEvent + ShardsBus singleton (EventEmitter + process.nextTick)
│   │       ├── galaxy/          # Galaxy router (TASK-11 + TASK-12)
│   │       │   ├── router.ts    # GalaxyRouter class — Map<systemId, Shard> + pending-promise collapse for concurrent spawns + 16-player cap enforcement + reapEmpty() with 60s grace timer + flushShips-on-reap + presence broadcasts on join/leave/reap + per-system generation counter + forceReap + stats() surface; threads connSender into every spawned shard (TASK-16)
│   │       │   ├── router-types.ts # RouterConnectionContext + JoinResult + JoinRejection + RouterShardStats + RouterStats + RouterOptions (extracted from router.ts so the file stays under the AGENTS.md line cap); RouterOptions gained optional connSender (TASK-16)
│   │       │   ├── router-load.ts # loadAndRegister — spawn a new shard + hydrate entities + bump generation; delegates to hydrateShardEntities; accepts optional connSender so shard.send is wired to a real WS writer (TASK-16)
│   │       │   ├── router-connection.ts # makeShardConnection + bindConnectionToEntity — per-join bookkeeping for router.joinSystem
│   │       │   ├── router-reap.ts # reapEmpty — sweep shards that have been empty past the grace window; flushShips + sim.stop + emit empty presence frame
│   │       │   ├── router-lifecycle.ts # routerStart + routerShutdown — start/stop the reap sweep timer; graceful close
│   │       │   ├── router-stats.ts # buildRouterStats + readGeneration — stats snapshot + generation counter (used by /api/galaxy/health)
│   │       │   ├── presence.ts # PresenceBroadcaster + buildPresencePayload + firePresenceBroadcast — TASK-12 wire-shape helpers for the presence frame
│   │       │   ├── hydrate.ts # hydrateShardEntities — walk SimEntitySpec[] + mint one entity per row (TASK-11 path; extracted from router.ts in TASK-12)
│   │       │   ├── ws-router-bridge.ts # buildPresenceBroadcaster + createConnectionCloseHook — WS layer ↔ router bridge; iterates ConnectionRegistry to push presence frames
│   │       │   ├── router.test.ts # 20 cases: construction invariants + lazy spawn + concurrent collapse + cap + grace reap (fake clock) + 10-client/3-system cross-system test + restart-with-position + force-reap + idempotent shutdown
│   │       │   ├── router.presence.test.ts # 15 cases: presence on join/leave/reap + reconnect storm with generation counter + 100 join/leave cycles + idempotent shutdown (TASK-12)
│   │       │   ├── router.ws-bridge.test.ts # 6 cases: real Fastify + ws round-trip verifying presence frame on join, drop on close, no-crash on never-joined, reconnect storm with same generation, presence payload shape, keepalive-terminate triggers onConnectionClose (TASK-12)
│   │       │   ├── presence-integration.test.ts # 4 cases: 3-in-one-system vs round-trip verifying each client sees the other 2; one leaves → others update within 1 s; one joins a different system → not listed; roster updates within one snapshot of a same-system join (TASK-15)
│   │       │   ├── system-data.ts # buildShardContext — derive SystemGen + per-planet closures from (seed, starId); GalaxySystemNotFoundError tagged error
│   │       │   ├── join-resolver.ts # buildRouterJoinResolver — maps (systemId, callsign, connId) to router.joinSystem + repo.findPlayerByCallsign + repo.listShipsByOwner + tag errors with code field for the WS dispatcher; seeds enter_system.chat with shard.chatLog.snapshot() (TASK-16)
│   │       │   ├── join-resolver.test.ts # 4 cases: success + cap-full + system-not-found + missing-callsign defensive path
│   │       │   ├── warp-resolver.ts # buildRouterWarpResolver — flush source shard → persist spawn-gate pos/quat → leave source → join target → return canonical snapshot (TASK-8)
│   │       │   └── warp-resolver.test.ts # 6 cases: happy-path A→B + spawn-gate pos/quat (forward -X) + same-system/full/unknown rejections + disconnect-mid-warp ghost check (TASK-8)
│   │       │   └── index.ts     # Re-export barrel
│   │       └── auth/            # Token codec + WS auth resolver (TASK-10)
│   │           ├── token.ts     # HMAC-SHA256 session-token codec: sign/verify/hashToken + clock-skew tolerance (TASK-10)
│   │           ├── resolver.ts  # claimCallsign + resumeSession + revokeSession + buildAuthResolver + buildLogoutResolver + pickHomeSystemId (TASK-10 + TASK-66)
│   │           ├── token.test.ts # 16 cases: round-trip, expiry (fake clock), MAC tamper, payload tamper, length-tolerance (TASK-10) + 162-case exhaustive codec matrix (TASK-66)
│   │           ├── resolver.test.ts # 19 cases: schema validation, claim happy path, duplicate, resume, profile, WS resolver adapter (TASK-10) + revokeSession + buildLogoutResolver + concurrent-use (TASK-66)
│   │           └── log-leak.test.ts # Log-leak guard: Fastify capture-stream logger scan for SESSION_SECRET/raw token/tokenHash across full claim/logout cycle (TASK-66)
│   │       └── shards/          # Authoritative sim runtime per system (TASK-13; future TASK-11 consumers)
│   │       │   └── event-bus.ts # ShipSwapEvent + LiveryChangedEvent + ShardsBus singleton (EventEmitter + process.nextTick)
│   │       └── shard/           # Per-system authoritative sim (TASK-13 + TASK-14 + TASK-24)
│   │       │   ├── types.ts     # Shard + ShardConnection + PlayerInput + SimEntity + ShardSystemContext contracts (TASK-13) — SnapshotBroadcaster now takes lastAppliedSeq map for client reconciliation (TASK-14); SimEntity gained wreckExpiresAt? field (TASK-23) + onPad (TASK-24); ConnSender widened to accept entity_update|chat|combat_event (TASK-16); per-shard chatLog ring buffer (TASK-16)
│   │       │   ├── entity.ts    # Player/AI/Wreck entity factory + entity → EntityState wire serializer (TASK-13 + TASK-23)
│   │       │   ├── input-queue.ts # Per-connection seq-protected slot, latest-wins, stale-seq drop + counters (TASK-13)
│   │       │   ├── histogram.ts # Ring-buffer histogram (p50/p95/p99) for per-tick duration (TASK-13)
│   │       │   ├── combat.ts    # applyCombatDamage + cleanupExpiredWrecks + broadcastCombatEvent + WRECK_TTL_S=600 (TASK-23)
│   │       │   ├── combat.test.ts   # 17 cases: shield-first on live entity, destroyed ships skip integration, double-destroy guard, wreck TTL cleanup, combat_event broadcast to all connections
│   │       │   ├── persist.ts       # flushShips + ShardFlushService (30s interval) + DEFAULT_FLUSH_INTERVAL_MS + entityToShipPatch (TASK-24)
│   │       │   ├── persist.test.ts   # 13 cases: full-patch round-trip, second-flush overwrite, docked state via onPad, wreck state, ShardFlushService timer idempotency, flushNow(), ShardRegistry flushAll
│   │       │   ├── persist.crash.test.ts # Real child-process crash + loadShipsForShard round-trip within 1u + destruction persistence
│   │       │   ├── persist.bench.test.ts # 16-ship × 200-iteration flush latency: p95 ≈ 7ms (spec ≤ 8ms)
│   │       │   ├── load.ts           # loadShipsForShard (deleteExpiredWrecks + listLiveShipsBySystem + shipRowToEntitySpec) + specToEntityFields + entityIdForSpec (TASK-24)
│   │       │   ├── load.test.ts      # 11 cases: empty system, scoped to systemId, skip docked + opt-in, expired-wreck GC, future-wreck preservation
│   │       │   ├── registry.ts       # ShardRegistry: Map<systemId, Shard> + flushAll() for graceful shutdown (TASK-24)
│   │       │   ├── sim.ts       # SimLoop class: 20 Hz tick, accumulator + 5-step catch-up ceiling, 10 Hz snapshot every 2nd tick, integrateShip() + heightAt3x3 cache, ship persisted-state plumbing (TASK-13); cumulative lastAppliedSeq map per player for ack (TASK-14)
│   │       │   ├── index.ts     # createShard() factory + spawnShip/spawnAiShip + pushPlayerInput + simulateNTicks + sendEntityUpdate with lastAppliedSeq (TASK-13 + TASK-14); broadcastChat + ChatRingBufferEntry export (TASK-16)
│   │       │   └── sim.test.ts  # 18 cases: accumulator math (1000 ticks no drift), 5-step catch-up ceiling, 10 Hz cadence, latest-input-wins, stale-seq drops, broadcast payload shape, entity kind mapping, 32 KB warning gate, histogram p50/p95/p99, 16-ship 60s benchmark p95 < 30 ms (TASK-13) + lastAppliedSeq ack map populated for owning player + empty for AI-only frames (TASK-14)
│   │       └── db/              # Drift persistence layer (TASK-62 / TASK-63 / TASK-41)
│   │           ├── types.ts     # PlayerRow / ShipRow / etc. + zod shapes for JSON columns
│   │           ├── errors.ts    # CallsignTakenError / InsufficientCreditsError / NotFoundError
│   │           ├── schema.ts    # selectSchemaFor(driver) re-exports both bundles
│   │           ├── schema.sqlite.ts   # better-sqlite3 schema (sqliteTable)
│   │           ├── schema.pg.ts       # postgres schema (pgTable, pgEnum, jsonb)
│   │           ├── client.ts   # createDbClient(loadConfig) — driver factory
│   │           ├── migrate.ts   # tiny SQL-bookkeeping runner over hand-written *.sql files
│   │           ├── migrations/sqlite/0001_init.sql  # Six tables + indexes + CHECKs + `_drift_migrations`
│   │           ├── migrations/sqlite/0002_ship_state.sql  # TASK-24: quat + regime + on_pad + wreck_expires_at columns
│   │           ├── repo.ts      # Repository interface + constants (DEFAULT_LIVERY, STARTER_HULL, …) + listLiveShipsBySystem + deleteExpiredWrecks (TASK-24)
│   │           ├── repo.helpers.ts   # parseDate / parseJsonField / clampInt / mapUniqueViolation / isoFromMs (TASK-24)
│   │           ├── repo.sqlite.ts    # SQLite factory (composes identity + world sub-bindings)
│   │           ├── repo.sqlite.identity.ts   # players / ships / cargo methods (SQLite) — TASK-24: saveShipState writes quat/regime/onPad/wreckExpiresAt + listLiveShipsBySystem + deleteExpiredWrecks + fast-path save (single SELECT + UPDATE)
│   │           ├── repo.sqlite.world.ts      # credits / nodes / sessions / registry + runInTransaction (SQLite, TASK-41)
│   │           ├── repo.sqlite.world.credits.ts # sqliteAddSync / sqliteWithdrawSync atomic UPDATEs + SqliteCreditHandle (TASK-41)
│   │           ├── repo.sqlite.mappers.ts    # text → *Row coercion for SQLite + TASK-24 parseShipQuaternion/parseShipRegime defaults
│   │           ├── repo.pg.ts        # Postgres factory (composes identity + world sub-bindings)
│   │           ├── repo.pg.identity.ts       # players / ships / cargo methods (Postgres) + TASK-24 quat/regime/onPad/wreckExpiresAt patches + listLiveShipsBySystem + deleteExpiredWrecks
│   │           ├── repo.pg.world.ts          # credits / nodes / sessions / registry (Postgres)
│   │           ├── repo.pg.mappers.ts        # native-Date + jsonb coercion for Postgres + TASK-24 parseShipQuaternion/parseShipRegime defaults
│   │           ├── migrate.test.ts            # migrateSqlite() idempotency + table sanity (TASK-62)
│   │           ├── repo.purchase.test.ts      # 9 cases: purchaseShip happy/error/atomicity (TASK-20)
│   │           ├── pg.parity.test.ts          # drizzle-kit generate parity (no live PG required)
│   │           ├── repo.test.shared.ts        # per-test harness factory (`installRepoHooks()`)
│   │           ├── repo.players.test.ts       # createPlayer / findPlayer* / CallsignTakenError
│   │           ├── repo.ships.test.ts         # getOrCreateStarterShip / saveShipState / NotFoundError + TASK-24 listLiveShipsBySystem + deleteExpiredWrecks + full-field round-trip
│   │           ├── repo.cargo.test.ts         # saveCargo wipe-and-replace + zero-quantity filtering
│   │           ├── repo.credits.test.ts       # 12 cases: start 500, atomic add, atomic withdraw, insufficient, zero floor, 100-concurrent withdrawals of 10 (50 success, bal 0), transaction commit + rollback (TASK-41)
│   │           └── repo.world.test.ts         # nodes / sessions / system registry + schema invariants
│   ├── drizzle.config.ts         # drizzle-kit config for operator-driven PG migrations
│   ├── tests/
│   │   └── e2e/
│   │       ├── fixtures.ts      # Worker-scoped Playwright fixture: spawns `npm run dev` with PORT/API_PORT on `::1`, DB in tmp dir, GALAXY_SEED per worker; exposes `DriftServer` (baseURL/apiURL/wsURL/tmpDir/galaxySeed) + `sampleCanvasPixels(page, 256)` helper (TASK-70)
│   │       ├── pages/
│   │       │   └── claim.ts     # ClaimPage page object — drift-canvas/header/player-list/chat-log/toast-stack selectors + bootAndWaitForOnline/currentCallsign/joinSystem/sendChat (TASK-70)
│   │       ├── chat.spec.ts     # Playwright smoke (two browser contexts → both see each other's chat messages + XSS inert-text + no <img> in DOM, screenshot) (TASK-16, fixture-rewritten in TASK-70)
│   │       ├── core-flow.spec.ts# Auto-claim → handshake → join → canvas + player-list end-to-end smoke (TASK-70)
│   │       ├── determinism.spec.ts # Two-client star-chart + planet-list + surface-chunk comparison via window.__DRIFT__ + 3-consecutive-run stability check (TASK-71)
│   │       ├── livery.spec.ts   # Playwright smoke (claim → set livery → re-read + invalid-hex rejection, screenshot) (TASK-21, fixture-rewritten in TASK-70)
│   │       ├── prediction.spec.ts# Prediction module import smoke + browser + Node-side integrate/reconcile (TASK-14, fixture-rewritten in TASK-70)
│   │       ├── presence.spec.ts # Playwright smoke (two browser contexts → both see each other in the in-system player list, screenshot) (TASK-15, fixture-rewritten in TASK-70)
│   │       ├── reconnect.spec.ts# DriftClient auto-reconnect + "Reconnected" toast after forced socket close (TASK-17, fixture-rewritten in TASK-70)
│   │       ├── render-smoke.spec.ts # Headless WebGL starfield smoke — samples 256x256 via 2D scratch canvas; asserts variance + starFraction (TASK-70)
│   │       ├── scaffold.spec.ts # Playwright smoke (canvas + /api/health) (TASK-68, fixture-rewritten in TASK-70)
│   │       ├── star-chart.spec.ts # Playwright smoke (open chart via M key + Systems button, click a node, screenshot the open chart, verify Warp button enables with the shortest-hop warp time) (TASK-7)
│   │       ├── warp.spec.ts     # Playwright smoke (open chart via M, click a non-current system, click Warp, assert overlay mounts + systemId flips to target + total duration 2.5-7 s + overlay hides, screenshot pre/post) (TASK-8)
│   ├── scripts/
│   │   ├── gen-stars-fixture.ts         # Regenerate __fixtures__/stars-dev-seed.json (TASK-3)
│   │   ├── gen-stars-full-fixture.ts    # Regenerate __fixtures__/stars-dev-seed-full.json (TASK-6)
│   │   ├── gen-system-fixture.ts        # Regenerate __fixtures__/system-dev-seed-star0.json (TASK-4)
│   │   ├── gen-system-star1-fixture.ts  # Regenerate __fixtures__/system-dev-seed-star1.json (TASK-6)
│   │   ├── gen-surface-fixture.ts       # Regenerate chunk00 fixture (TASK-5)
│   │   ├── gen-surface-chunk10-fixture.ts # Regenerate chunk10 fixture (TASK-6)
│   │   ├── gen-surface-chunk01-fixture.ts # Regenerate chunk01 fixture (TASK-6)
│   │   ├── gen-flight-trajectories.ts   # Regenerate flight golden fixtures (TASK-22)
│   │   ├── crash-writer.ts              # Child-process SIGKILL crash test for PersistService (TASK-63)
│   │   ├── shard-crash-runner.ts        # Child-process runner for shard flush + position continuity crash test (TASK-24)
│   ├── tsconfig.json            # Strict TS, path aliases @shared/@client/@server
│   ├── vite.config.ts           # Vite root, proxy /api + /ws → server :API_PORT
│   └── vitest.config.ts         # Vitest mirrors vite aliases
├── node_modules/                # Top-level runtime deps (gitignored)
├── opencode.json                # opencode provider/model registry (repo-local)
└── ralph/                       # Vendored ralph runtime
```

## .ralph/ workspace (Ralph loop state)
```
.ralph/
├── PROMPT.md                    # Loop prompt template
├── STEERING.md                  # Critical pre-task steering notes
├── SUMMARY.md                   # (not present in this iteration)
├── STRUCTURE.md                 # this file
├── history/                     # Per-iteration JSONL event logs (gitignored)
├── logs/
│   └── LOG.md                   # Human-readable build log (newest on top)
├── prd/
│   └── PRD.md                   # Source PRD; required env names listed in §7
├── screenshots/                 # Per-task UI screenshots (gitignored as .png)
├── skills/                      # Ralph-provided skills
└── tasks/
    ├── tasks.json               # Task index (passes flag per task)
    └── TASK-${ID}.json          # Per-task spec (TASK-1.json … TASK-71.json)
```

## Runtime prerequisites (TASK-1)
- `PROJECT_ROOT/.env.local` declares all eight env vars from PRD §7.
- `.mcp.json` declares `playwright`, `context7`, `sequential-thinking`.
- No secret values are committed (verified: `git ls-files | xargs grep`).

## Dev port allocation (TASK-68)
- `PORT` (default 3000) → Vite dev server (browser URL: `http://localhost:${PORT}`)
- `API_PORT` (default `PORT + 1`, i.e. 3001) → Fastify + ws server.
- Vite proxies `/api/*` and `/ws` to `API_PORT`, so the browser stays on
  a single origin.
