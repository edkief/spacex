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
│   │   └── gen-flight-fixtures.ts  # npm run snapshot:update:flight — regenerates the 2 TASK-22 golden trajectory fixtures
│   ├── smoke-task1.mjs       # TASK-1 Playwright smoke script (chromium screenshot)
│   ├── smoke-task10.mjs      # TASK-10 live smoke: REST claim/session + WS token auth over the :3000 proxy
│   ├── smoke-task13.mjs      # TASK-13 live smoke: shard join + 10 Hz snapshots + input integration + stale seq over the :3000 proxy
│   ├── smoke-task21.mjs      # TASK-21 live smoke: livery REST happy path + Playwright page load/screenshot
│   └── src/
│       ├── client/
│       │   ├── main.tsx      # React shell: #game-canvas, callsign claim form + session boot (WS → join, ?sys= override), presence HUD, live occupancy, chat log (TASK-16); TASK-17: ConnectionLostOverlay (#connection-lost-overlay + #reconnect-retry) on 'lost' + "reconnecting…/connection lost" status-line suffixes, resync keeps chat/list UI when the system is unchanged
│       │   ├── net/
│       │   │   ├── prediction.ts   # TASK-14: ClientShipPredictor — per-frame integrateShip + server-timeline reconcile (blend/rewind/snap, 10 s queue cap)
│       │   │   ├── interpolation.ts # TASK-14: RemoteEntityBuffer/Tracker — 200 ms lerp/slerp, stale on underrun, dim after 1 s
│       │   │   ├── presence.ts     # TASK-15: PresenceStore — snapshot + join/leave events, self "(you)", lastSeen, occupancy, toast events (no emit on unchanged snapshots); TASK-17: 'reconnected' toast
│       │   │   ├── session.ts      # TASK-15/17: ClientSession — browser WS client, hello→auth(token), joinSystem → enter_system snapshot; TASK-17: lazy dial, ConnectionState (connecting/connected/reconnecting/lost), auto-retry 1 s backoff capped 5 s, 30 s 'lost' window + retryNow(), onSnapshot(snapshot, reconnect) full resync (prediction/buffers/presence rebuilt, chat merged)
│       │   │   └── chat.ts         # TASK-16/17: ChatStore — 100-msg ring buffer, loadSnapshot (system-change clear + ts watermark), emit only on change; TASK-17: mergeSnapshot (append only newer-than-tail, no full clear on resync)
│       │   ├── hud/
│       │   │   ├── player-list.tsx # TASK-15: bottom-left monospace callsign list + status dots, presence-event re-renders only
│       │   │   ├── toast-stack.tsx # TASK-15: top-right join/leave toasts, 3 s fade, 3 visible + queue
│       │   │   └── chat-log.tsx    # TASK-16: top-left chat column — '[HH:MM] CALLSIGN: text', text-only (no innerHTML), Enter-toggled input, bottom-pinned scroll
│       │   └── render/
│       │       └── ship-mesh.ts # TASK-21: ShipMeshBuilder — 3 paint-zone materials + in-place applyLivery
│       ├── server/
│       │   ├── env.ts        # zod-validated env (PROJECT_ROOT/.env.local)
│       │   ├── index.ts      # process entry: Fastify + ws, REST routes + token auth, galaxy router (shards on demand + reaper + periodic flush + stopAll on signal), 10 s shutdown watchdog (TASK-12), input routed per-conn system, listens on PORT
│       ├── shards.ts     # TASK-20/21: in-process ship-swap + livery bus, shipToEntity, entity_update broadcast bridge
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
│       │       ├── galaxy.ts       # TASK-11: GET /api/galaxy/health (auth) → {shards: [{systemId, name, players, uptimeMs}]} (feeds TASK-7 dots)
│       │       ├── players.ts      # TASK-41: GET /api/players/me (Bearer → own profile incl. credits)
│       │       ├── session.ts      # TASK-10: GET /api/session (Bearer → profile, structured 401s)
│       │       └── ships.ts        # TASK-20/21/23: GET /api/ships, POST /api/ships/buy (docked purchase), POST /api/ships/livery (3-slot hex paint), POST /api/ships/repair (docked, credit cost)
│       │   ├── ws.ts         # TASK-9 WS lifecycle: handshake state machine, structured errors, presence, 15s/45s keepalive; TASK-16 chat sanitize → rate-limit → onGameMessage; TASK-17: onGameMessage carries `source: conn` so the shard can attribute inputs and drop stale-conn frames
│       │   ├── shard/
│       │   │   ├── sim.ts  # TASK-13: SimLoop — 20 Hz fixed tick, drift-corrected setTimeout chain, 5-tick max catch-up + input-drop flag
│       │   │   ├── histogram.ts  # TASK-13: TickHistogram — ring-buffer tick durations, p50/p95/p99
│       │   │   ├── terrain.ts  # TASK-13: TerrainContext — 3x3 chunk neighborhood cache, bilinear O(1) heightAt, world-coord pads
│       │   │   ├── shard.ts  # TASK-13/23/24: SystemShard — input queues (latest-wins, stale seq), integrateShip per tick (destroyed skipped), applyHit + static 600 s wrecks, 10 Hz shared-buffer snapshots; loadShips() restart rehydration (saved flight state / dock coords / unexpired wrecks); TASK-17: idle continuation (tick iterates playerEntities, input-less ships keep coasting, `idle` flag) + stale-conn guards (register supersedes zombie conns, unregister/leave/enqueueInput source-checked, adoptEntity un-idles)
│       │   │   ├── types.ts  # TASK-13/23/24: Shard/ConnState/SimEntity contracts (kind 'wreck', destroyed/ttl, destroyedAtMs)
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
│           │   └── schemas.ts    # TASK-9/16/23: zod payload schema per message type (chat = union of {text} inbound / {from,text,ts} broadcast, combat_event damaged/destroyed) + EntityState/StateSnapshot shapes
│           ├── ships.ts          # TASK-19/21: SHIP_CLASSES + shipStats/compareShips/totalWeaponCount/shipPrice, Livery type + per-class defaultLivery
│           ├── physics/
│           │   ├── vec.ts        # TASK-22: Vec3/Quat ops (add/scale/dot/cross/normalize/lerp, fromEuler/multiply/toMat3/rotateVector)
│           │   ├── atmosphere.ts # TASK-22: 1 km drag boundary ramp atmosphereFactor (shared with TASK-28)
│           │   ├── flight.ts     # TASK-22: integrateShip — deterministic space/atmosphere/VTOL physics + ground collision (substepped)
│           │   └── damage.ts     # TASK-23: applyDamage (pure, shield-first, destroyed at hull zero, double-destroy guard) + repairCost
│           └── galaxy/
│               ├── types.ts  # Star, SystemSummary, Planet, SurfaceChunk, Biome interfaces
│               ├── config.ts # GALAXY_STAR_COUNT, spectral weights, name word lists, disk params
│               ├── noise.ts  # deterministic 2D value noise + fBm (world-space lattice)
│               ├── stars.ts  # generateStars(seed, count) — seeded thin-disk galaxy layout
│               ├── system.ts # generateSystem(seed, starId) — planets, docks, deposits, AI roster
│               ├── home.ts   # TASK-10: homeSystemIdForPlayer(seed, playerId) — deterministic spawn system
│               └── dock.ts   # TASK-20: homeDockPosition(seed, systemId) — seed-derived dock coordinates
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
