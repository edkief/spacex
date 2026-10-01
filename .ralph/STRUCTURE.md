# Project Structure

Excludes dotfiles, tests, and config.

```
/workspace/master
├── app/
│   ├── data/
│   │   └── drift.db          # local SQLite db (git-ignored)
│   ├── index.html            # Vite entry
│   ├── scripts/
│   │   ├── gen-surface-fixture.ts  # regenerates the TASK-5 golden chunk fixture
│   │   ├── gen-galaxy-snapshots.ts # npm run snapshot:update — regenerates the 6 TASK-6 snapshot fixtures
│   │   ├── gen-flight-fixtures.ts  # npm run snapshot:update:flight — regenerates the 2 TASK-22 golden trajectory fixtures
│   │   └── dev-test.mjs            # TASK-70: npm run dev:test — vite + tsx server on env/ random ports with tmp DB for the e2e fixture
│   ├── smoke-task1.mjs       # TASK-1 Playwright smoke script (chromium screenshot)
│   ├── smoke-task10.mjs      # TASK-10 live smoke: REST claim/session + WS token auth over the :3000 proxy
│   ├── smoke-task13.mjs      # TASK-13 live smoke: shard join + 10 Hz snapshots + input integration + stale seq over the :3000 proxy
│   ├── smoke-task21.mjs      # TASK-21 live smoke: livery REST happy path + Playwright page load/screenshot
│   └── src/
│       ├── client/
│       │   ├── main.tsx      # React shell: #game-canvas, callsign claim form + session boot (WS → join, ?sys= override), presence HUD, live occupancy, chat log (TASK-16); TASK-70: starfield renderer mounted on #game-canvas; TASK-17: ConnectionLostOverlay (#connection-lost-overlay + #reconnect-retry) on 'lost' + "reconnecting…/connection lost" status-line suffixes, resync keeps chat/list UI when the system is unchanged; TASK-71: feeds __DRIFT__ the /api/health seed; TASK-7: M-key/"SYSTEMS (M)" HUD button toggles the star chart panel (src/client/ui); TASK-29.3: self entity_update drives the DOCKED indicator (state/docked isDocked) + WorldManager.setShipPos, snapshot resets the docked state; TASK-31: self entity resolved CHARACTER-first (disembark), E-key handler sends 'exit_ship' while the leave-ship prompt is up, WorldManager.setCharacterPos/clearCharacter bridged
│       │   ├── drift-debug.ts # TASK-71: dev-only window.__DRIFT__ hook (import.meta.env.DEV gate, never ships) — ready/seed + starChart()/planetList() derived from the server seed, for the two-client determinism e2e
│       │   ├── stream-debug.ts # TASK-26.2: dev-only window.__STREAM__ hook (import.meta.env.DEV gate, never ships) — surfaceBenchmark() renders the 13-chunk default-LOD scene (Torolm dev-seed, resting player) through a fresh WebGLRenderer + detached canvas, returns renderer.info.render.triangles + per-ring SceneTriangleStats, disposes everything (no GL context leak)
│       │   ├── atmosphere-debug.ts # TASK-28.3: dev-only window.__ATMO__ hook (import.meta.env.DEV gate, never ships) — midBoundaryComparison() scans the seeded galaxy (40 systems) for the min/max mid-boundary-haze atmospheric pair, renders each dome in isolation through a real WebGLRenderer (offscreen canvas; raw-sRGB uniform override + NoBlending so the sampled pixel is EXACTLY lerp(clear, atmo, hazeMid)), samples the center pixel, disposes everything (no GL context leak)
│       │   ├── net/
│       │   │   ├── prediction.ts   # TASK-14: ClientShipPredictor — per-frame integrateShip + server-timeline reconcile (blend/rewind/snap, 10 s queue cap)
│       │   │   ├── interpolation.ts # TASK-14: RemoteEntityBuffer/Tracker — 200 ms lerp/slerp, stale on underrun, dim after 1 s
│       │   │   ├── presence.ts     # TASK-15: PresenceStore — snapshot + join/leave events, self "(you)", lastSeen, occupancy, toast events (no emit on unchanged snapshots); TASK-17: 'reconnected' toast
│       │   │   ├── session.ts      # TASK-15/17: ClientSession — browser WS client, hello→auth(token), joinSystem → enter_system snapshot; TASK-17: lazy dial, ConnectionState (connecting/connected/reconnecting/lost), auto-retry 1 s backoff capped 5 s, 30 s 'lost' window + retryNow(), onSnapshot(snapshot, reconnect) full resync (prediction/buffers/presence rebuilt, chat merged)
│       │   │   └── chat.ts         # TASK-16/17: ChatStore — 100-msg ring buffer, loadSnapshot (system-change clear + ts watermark), emit only on change; TASK-17: mergeSnapshot (append only newer-than-tail, no full clear on resync)
│       │   ├── state/
│       │   │   ├── warp.ts       # TASK-7/8: warp event bus + phase store (idle/warping-in/awaiting/warp-out) + WarpController — idle→warping-in(2s)→awaiting(net)→warp-out(2s)→idle, failure→idle+onFailed('System full' toast), injectable delay
│       │   │   ├── regime.ts     # TASK-25: client regime tracker — local regimeFor prediction + server authority (self entity_update flightRegime), 500 ms divergence snap + debug warn (space/atmosphere only — surface is server-authoritative: client has no terrain yet), injectable clock/warn, onRegimeChange
│       │   │   ├── regime-wiring.ts # TASK-25.2: live session wiring — one tracker + one ControlsRemapper; setSystem(seed, systemId) (reset + systemRegimePlanets + full Planet[] mirror), onSelfUpdate(entity, nowMs) (flightRegime authority + last-known-state prediction), atmosphereBoundaryAt(pos) (0 in space, shared boundaryFactor at the tracked planet — COSMETIC, TASK-28.2); consumed by useGameSession (main.tsx)
│       │   │   ├── reentry.ts      # TASK-28.2: re-entry tint store — setReentryTint clamps to [0, REENTRY_TINT_MAX] + emit-on-change, reentryTintSubscribe (immediate catch-up), __resetReentryTint; driven by main.tsx self entity_update (reentryTintFactor), never feeds physics
│       │   │   └── docked.ts       # TASK-29.3: docked-indicator store — pure isDocked(regime, padId) predicate (regime 'docked' AND non-empty padId), setDockedIndicator emit-on-change, dockedIndicatorSubscribe (immediate catch-up), __resetDockedIndicator; driven by main.tsx self entity_update, HUD only
│       │   ├── input/
│       │   │   └── controls.ts   # TASK-25: ControlsRemapper — one ControlScheme per regime (space flight, atmosphere + VTOL key, surface walk/look/interact stub for TASK-31), instant setRegime swap + debug log, pure readInput/readCharacterInput
│       │   ├── perf/
│       │   │   ├── frameMonitor.ts # TASK-57: frame monitor — 300-frame circular buffer (p50/p95/p99 nearest-rank), 1 s FPS window, renderer.info capture, getFrameStats() {fps, percentiles, drawCalls, triangles, entities}; budget hook (registerBudget/budgetCheck, per-name rolling max, 1 warn per name per 10 s) — shared by TASK-30/58/59/61
│       │   │   └── logger.ts     # TASK-57: perf logger with injectable sink (setPerfLogSink for test spies)
│       │   ├── world/
│       │   │   ├── WorldManager.ts # TASK-8: in-system three.js world on #game-canvas (star at origin, near-field planets, spawn-gate ring); swapWorld builds-then-replaces (budget < 300 ms, measured); pure buildSystemLayout (three-free); TASK-57: render loop feeds frameMonitor (beginFrame → render → endFrame with renderer.info); TASK-29.3: client pad list via shared padsForSystem (getPads(), rebuilt per swap) + glowing pad-ring markers (pure padRingsFor/padRingVisible, 500 m per-frame culling vs setShipPos, rings live in the per-system group); TASK-31: on-foot mode — setCharacterPos (placeholder capsule + CameraRig feed + handoff('onfoot')) / clearCharacter / isOnFoot, render loop drives the rig only while disembarked
│       │   │   ├── entity-registry.ts # TASK-57: client entity registry — rendered entities (ship/character/wreck) register/unregister; renderedEntityCount() feeds the frame monitor
│       │   │   └── chunks.ts # TASK-26: streaming pipeline — chunk grid (320 m), LOD rings 512/2048/8000 m, activeSet (13 rest / 49 @speed≥100), ChunkStreamer: 4 ms/frame budget, heading-corrected nearest-first queue, far-impostor window (Chebyshev 6, drop-far-first under backlog), 400-chunk LRU (never evicts active), impostor→full upgrade on approach
│       │   │   └── chunk-geometry.ts # TASK-26: resumable staged ChunkBuild (height→placement→near/mid/far mips, one bounded unit per advanceUnit, 65x65 near grid shares borders) + 1-unit ImpostorBuild; RING_TRIANGLES/RING_BYTES
│       │   │   └── chunk-scene.ts # TASK-26: three.js group, one mesh per mounted chunk, LOD swap = pre-built geometry pointer change, biome materials, per-ring tris to frameMonitor + 400k surface gauge
│       │   ├── ui/
│       │   │   ├── debug-overlay.tsx # TASK-57: dev-only frame monitor overlay — F3 toggle, 2 Hz poll of frameMonitor.getFrameStats(), top-right monospace panel (FPS, p50/p95/p99, draw calls/tris, entities) + stats JSON export; mounted only under import.meta.env.DEV
│       │   │   ├── star-chart.tsx  # TASK-7: star chart panel — overview fetch, 5 s occupancy poll, search, select + Warp button (dispatches warp-started), Esc closes
│       │   │   ├── chart-map.tsx   # TASK-7: pure SVG map (800x500) — spectral-class nodes, ls + warp-time edge labels, occupancy badges, focus rings, 'Warping…'
│       │   │   ├── reentry-tint.tsx # TASK-28.2: cosmetic orange rim overlay — fixed full-screen radial-gradient (z 80, pointer-events none, aria-hidden), opacity = live tint, null at tint ≤ 0
│       │   │   └── docked-indicator.tsx # TASK-29.3: single #docked-indicator DOM node — small monospace 'DOCKED' stub (z 85, pointer-events none, role=status), rendered while state/docked is true, null otherwise; full ship HUD is TASK-51
│       │   ├── hud/
│       │   │   ├── player-list.tsx # TASK-15: bottom-left monospace callsign list + status dots, presence-event re-renders only
│       │   │   ├── toast-stack.tsx # TASK-15: top-right join/leave toasts, 3 s fade, 3 visible + queue
│       │   │   └── chat-log.tsx    # TASK-16: top-left chat column — '[HH:MM] CALLSIGN: text', text-only (no innerHTML), Enter-toggled input, bottom-pinned scroll
│       │   ├── camera/
│       │   │   ├── CameraRig.ts     # TASK-27: the ONE PerspectiveCamera (FOV 75) for all regimes — cockpit (ship-local (0,0.5,1.2) offset, k=8/s exponential follow ≈100 ms) + on-foot (4 m behind, 1.6 m up, yaw/pitch ±80° clamp); handoff() = 600 ms ease-in-out along a 5-sample terrain-nudged path, input-locked mid-anim, cancellable only by a second handoff; injectable clock/heightAt/lifecycle
│       │   │   ├── pose-math.ts     # TASK-27: pure DOM-free handoff math on @shared/physics/vec — cockpitPose/onFootPose, lerpPose, slerpVec (short-arc), easeInOutCubic, clampPitch, nudgeOutOfTerrain + computeHandoffPath (5 samples, never enters geometry), samplePath
│       │   │   └── camera-debug.ts  # TASK-27: dev-only window.__CAMERA__ hook (import.meta.env.DEV gate) — handoffProbe() scripts the rig standalone (fake ship/char + analytic mesa + 10 ms clock), reports the full contract, renders the final on-foot view into #__camera-probe-canvas
│       │   └── render/
│       │       ├── atmosphere-dome.ts # TASK-28: back-face atmosphere dome — one shared haze number drives color = mix(uSkyColor, uAtmoColor, uHaze), alpha = uHaze (hidden at 0); raw ShaderMaterial (no color-space math), ATMOSPHERE_HAZE_COLORS per planet class, renderOrder 2 (sky 0 < stars 1 < dome 2)
│       │       ├── ship-mesh.ts # TASK-21: ShipMeshBuilder — 3 paint-zone materials + in-place applyLivery
│       │       └── starfield.ts # TASK-70: deterministic three.js starfield on #game-canvas (PRNG sky sphere + point sprites, preserveDrawingBuffer for e2e pixel sampling) — placeholder until TASK-26
│       ├── server/
│       │   ├── env.ts        # zod-validated env (PROJECT_ROOT/.env.local)
│       │   ├── index.ts      # process entry: Fastify + ws, REST routes + token auth, galaxy router (shards on demand + reaper + periodic flush + stopAll on signal), 10 s shutdown watchdog (TASK-12), input routed per-conn system, listens on PORT
│       ├── shards.ts     # TASK-20/21: in-process ship-swap + livery bus, shipToEntity, entity_update broadcast bridge; TASK-31: routeGameMessage(shard, conn, type, payload) — the single gameplay dispatch surface (input queue / chat / exit_ship), used by index.ts and the live-ws tests verbatim
│       │   ├── server.ts     # buildServer() for tests/inject()
│       │   ├── auth/
│       │   │   ├── token.ts       # TASK-10: HMAC-SHA256 token codec (base64url body + MAC, constant-time, 30 s exp skew)
│       │   │   └── session.ts     # TASK-10: session service (sha256-stored tokens, 7 d TTL) + WS token authenticator
│       │   ├── galaxy/
│       │   │   ├── router.ts  # TASK-11/12: createGalaxyRouter — Map<systemId, Shard> on demand (pending-promise collapse + loadChain), 60 s reap grace (flush-before-stop), 16-player cap, per-system shard generation counter (bumped per DB (re)load, proves reuse vs reload), stats/stopAll, periodic + chained flushes
│       │   │   └── gateway.ts # TASK-11: createRouterGateway — SystemGateway over the router (enter → {snapshot}, leave → grace)
│       │   │   └── (tests) router.test.ts (unit: collapse/reap/cap/restart, fake clock), router.ws.test.ts (live ws: 10 clients/3 systems, cap stays-put, health, not-found), reconnect.ws.test.ts (live ws TASK-17: mid-flight drop → idle coast + continuity < 1 u + no duplicate entity, zombie-conn input/leave guards, fake-clock reap-and-rejoin at flushed position)
│       │   └── routes/
│       │       ├── index.ts        # registerApiRoutes(repo, sessions, galaxySeed, shipSwapBus)
│       │       ├── auth.ts         # TASK-41: shared Bearer extraction + requireAuth (structured 401 reasons)
│       │       ├── callsigns.ts    # TASK-10: POST /api/callsigns (claim → player + starter ship + session token); RouteDeps (+ optional galaxyRouter, TASK-11)
│       │       ├── galaxy.ts       # TASK-11: GET /api/galaxy/health (auth) → {shards: [{systemId, name, players, uptimeMs}]}; TASK-7: GET /api/galaxy/overview (auth, ?home=) → 3-system seeded chart, in-process forever cache
│       │       ├── players.ts      # TASK-41: GET /api/players/me (Bearer → own profile incl. credits)
│       │       ├── session.ts      # TASK-10: GET /api/session (Bearer → profile, structured 401s)
│       │       ├── ships.ts        # TASK-20/21/23: GET /api/ships, POST /api/ships/buy (docked purchase), POST /api/ships/livery (3-slot hex paint), POST /api/ships/repair (docked, credit cost)
│       │       └── dev.ts          # TASK-29: dev-only (non-production) e2e hooks — GET /api/dev/pad-target (deterministic first landable-atmosphere pad), POST /api/dev/teleport {x,y,z} (shard.teleportForTesting, clears held input)
│       │   ├── ws.ts         # TASK-9 WS lifecycle: handshake state machine, structured errors, presence, 15s/45s keepalive; TASK-16 chat sanitize → rate-limit → onGameMessage; TASK-17: onGameMessage carries `source: conn` so the shard can attribute inputs and drop stale-conn frames
│       │   ├── shard/
│       │   │   ├── sim.ts  # TASK-13: SimLoop — 20 Hz fixed tick, drift-corrected setTimeout chain, 5-tick max catch-up + input-drop flag
│       │   │   ├── histogram.ts  # TASK-13: TickHistogram — ring-buffer tick durations, p50/p95/p99
│       │   │   ├── terrain.ts  # TASK-13: TerrainContext — 3x3 chunk neighborhood cache, bilinear O(1) heightAt, world-coord pads
│       │   │   ├── shard.ts  # TASK-13/23/24: SystemShard — input queues (latest-wins, stale seq), integrateShip per tick (destroyed skipped), applyHit + static 600 s wrecks, 10 Hz shared-buffer snapshots; loadShips() restart rehydration (saved flight state / dock coords / unexpired wrecks); TASK-17: idle continuation (tick iterates playerEntities, input-less ships keep coasting, `idle` flag) + stale-conn guards (register supersedes zombie conns, unregister/leave/enqueueInput source-checked, adoptEntity un-idles); TASK-29: pad state machine (per-tick resolvePadTarget + hysteresis keep, dock/undock events, VTOL approach assist, flat-disc padSurfaceHeight, teleportForTesting clears held input); TASK-31: handleExitShip (pad-docked check, character spawn at the shared-math position, {not-docked}/{unknown-ship} denials to the requesting conn) + disembarked ship frozen in the tick (inputs dropped) + the character persists across disconnect (TASK-24 pattern)
│       │   │   ├── types.ts  # TASK-13/23/24/31: Shard/ConnState/SimEntity contracts (kind 'wreck' | 'character', destroyed/ttl, destroyedAtMs, disembarked)
│       │   │   ├── persist.ts  # TASK-24: shard flush/load service — one-tx multi-row upsert to ships + load with expired-wreck cleanup, flush timer
│       │   │   ├── index.ts  # TASK-13: barrel exports
│       │   │   └── (tests) persist.test.ts (flush/load + p95 < 8 ms bench), crash-restart.test.ts (SIGKILL restart integration, real child server)
│       │   ├── persist.ts               # TASK-63 save-point service: dock/damage-milestone/5s-interval/shutdown, crash-load
│       │   ├── persist-crash-child.ts   # TASK-63 test helper: child process that saves state, then gets SIGKILL'd
│       │   ├── ratelimit.ts             # TASK-65 per-conn token bucket (20/s, burst 40), ChatLimiter (option rules; TASK-16 = 200 chars / 5 per 10 s), 3-in-10 s escalation
│       │   └── db/
│       │       ├── schema.ts          # dual-driver Drizzle schema (sqlite + pg), 6 tables + row types
│       │       ├── client.ts          # createDb/getDb: DB_DRIVER → better-sqlite3 file (WAL) | pg Pool; migrate on boot
│       │       ├── migrate.ts         # sequential .sql migrator with _migrations tracking table (sqlite)
│       │       ├── repo.ts            # Repository: players/ships/cargo/credits/nodes/sessions; zod-validated JSON (strict 3-slot livery, TASK-21)
│       │       ├── errors.ts          # CallsignTakenError, InsufficientCreditsError, NotFoundError
│       │       └── migrations/
│       │           ├── 000000_init.sql # initial SQLite DDL
│       │           └── 000001_ship_persistence.sql # TASK-24: ships +rotation/regime/on_pad/destroyed_at + uq_ships_owner
│       └── shared/
│           ├── canonical.ts  # canonicalJson: stable key-sorted JSON for checksums
│           ├── callsign.ts   # TASK-10: shared zod callsign schema (3-16 alnum+dash, lowercase transform)
│           ├── health.ts     # HealthPayload + GalaxyShardHealth/GalaxyHealthPayload (TASK-11) types
│           ├── random.ts     # Deterministic PRNG (xoshiro128**) + FNV-1a/splitmix hashing
│           ├── protocol.ts       # TASK-9: version constant, Envelope, encode/decode, parseMessage, error codes; TASK-11: MAX_PLAYERS_PER_SYSTEM = 16
│           ├── protocol/
│           ├── chat.ts       # TASK-16: chat contract — CHAT_MAX_CHARS/CHAT_WINDOW_*/CHAT_HISTORY_MAX + sanitizeChatText (strips C0/C1/DEL, ANSI CSI, bidi, zero-width)
│           │   └── schemas.ts    # TASK-9/16/23/31: zod payload schema per message type (chat = union of {text} inbound / {from,text,ts} broadcast, combat_event damaged/destroyed) + EntityState/StateSnapshot shapes (TASK-31: optional playerId/onFoot for kind 'character')
│           ├── ships.ts          # TASK-19/21: SHIP_CLASSES + shipStats/compareShips/totalWeaponCount/shipPrice, Livery type + per-class defaultLivery
│           ├── physics/
│           │   ├── vec.ts        # TASK-22: Vec3/Quat ops (add/scale/dot/cross/normalize/lerp, fromEuler/multiply/toMat3/rotateVector)
│           │   ├── atmosphere.ts # TASK-22: 1 km drag boundary ramp atmosphereFactor (shared with TASK-28)
│           │   ├── flight.ts     # TASK-22: integrateShip — deterministic space/atmosphere/VTOL physics + ground collision (substepped)
│           │   ├── damage.ts     # TASK-23: applyDamage (pure, shield-first, destroyed at hull zero, double-destroy guard) + repairCost
│           │   └── character.ts  # TASK-31: disembark spawn math — characterSpawnPos(shipPos, quat, padHeight) = ship world pos + 2.5 m world-right (CHAR_SHIP_SIDE_OFFSET_M), y pinned to the pad plane; shared by the sim (authority), unit tests and e2e
│           └── world/
│               └── pads.ts       # TASK-29: shared pad math — padsForSystem(seed, system) (one pad per landable planet, cached per (seed, systemId)), resolvePadTarget (20 m acquire / 25 m hysteresis, ties by padId), satisfiesDock (≤20 m + surface + |vel.y|<2 + |alt−padY|≤1), VTOL assist gate + applyVtolAssist (×0.5 x/z), padSurfaceHeight (flat disc → raised-cosine blend → terrain)
│           ├── regime.ts        # TASK-25: shared flight-regime state machine — regimeFor(pos, planets, current, speed) with atmosphere enter/exit + surface altitude hysteresis; server (authority) and client (prediction) use it verbatim
│           └── galaxy/
│               ├── types.ts  # Star, SystemSummary, Planet, SurfaceChunk, Biome interfaces
│               ├── config.ts # GALAXY_STAR_COUNT, spectral weights, name word lists, disk params
│               ├── noise.ts  # deterministic 2D value noise + fBm (world-space lattice)
│               ├── stars.ts  # generateStars(seed, count) — seeded thin-disk galaxy layout
│               ├── system.ts # generateSystem(seed, starId) — planets, docks, deposits, AI roster
│               ├── home.ts   # TASK-10: homeSystemIdForPlayer(seed, playerId) — deterministic spawn system
│               ├── chart.ts  # TASK-7: galaxyChart(seed, home) — v1 3-system chart (home + 2 nearest), 800x500 projection, travel table (ls/gu, warp speed) + label formats
│               └── dock.ts   # TASK-20: homeDockPosition(seed, systemId) — seed-derived dock coordinates
│               ├── planets.ts  # TASK-25: regime-view of a system's planets — planetAnchor(i) (10 km spacing), atmosphere radius (1 km TASK-22 boundary / 0 airless), landable; heightAt caller-injected (server terrain / client flat until TASK-26)
│               └── surface.ts# generateSurfaceChunk(seed, planet, chunkX, chunkZ) — heightmap, biome, nodes, pads
├── ralph/                    # Ralph loop implementation (TypeScript)
│   └── src/
└── scripts/
    └── assets/
```

Notes:
- `app` is the Vite + React client (port 3000); the Node server (Fastify + ws) runs on port 3001 in dev; Vite proxies `/api` and `/ws` so the browser stays same-origin.
- Path aliases: `@shared/*` → `src/shared/*`, `@client/*` → `src/client/*`, `@server/*` → `src/server/*` (tsconfig, vite, vitest).
- `ralph/` is the standalone Ralph loop project driving opencode.
