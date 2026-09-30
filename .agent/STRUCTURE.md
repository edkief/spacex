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
│       │   ├── main.tsx      # React shell + #game-canvas placeholder
│       │   ├── net/
│       │   │   ├── prediction.ts   # TASK-14: ClientShipPredictor — per-frame integrateShip + server-timeline reconcile (blend/rewind/snap, 10 s queue cap)
│       │   │   └── interpolation.ts # TASK-14: RemoteEntityBuffer/Tracker — 200 ms lerp/slerp, stale on underrun, dim after 1 s
│       │   └── render/
│       │       └── ship-mesh.ts # TASK-21: ShipMeshBuilder — 3 paint-zone materials + in-place applyLivery
│       ├── server/
│       │   ├── env.ts        # zod-validated env (PROJECT_ROOT/.env.local)
│       │   ├── index.ts      # process entry: Fastify + ws, REST routes + token auth + ship-swap broadcast, shard flush timer + shutdown flush, listens on PORT
│       ├── shards.ts     # TASK-20/21: in-process ship-swap + livery bus, shipToEntity, entity_update broadcast bridge (folds into TASK-11/12)
│       │   ├── server.ts     # buildServer() for tests/inject()
│       │   ├── auth/
│       │   │   ├── token.ts       # TASK-10: HMAC-SHA256 token codec (base64url body + MAC, constant-time, 30 s exp skew)
│       │   │   └── session.ts     # TASK-10: session service (sha256-stored tokens, 7 d TTL) + WS token authenticator
│       │   └── routes/
│       │       ├── index.ts        # registerApiRoutes(repo, sessions, galaxySeed, shipSwapBus)
│       │       ├── auth.ts         # TASK-41: shared Bearer extraction + requireAuth (structured 401 reasons)
│       │       ├── callsigns.ts    # TASK-10: POST /api/callsigns (claim → player + starter ship + session token)
│       │       ├── players.ts      # TASK-41: GET /api/players/me (Bearer → own profile incl. credits)
│       │       ├── session.ts      # TASK-10: GET /api/session (Bearer → profile, structured 401s)
│       │       └── ships.ts        # TASK-20/21/23: GET /api/ships, POST /api/ships/buy (docked purchase), POST /api/ships/livery (3-slot hex paint), POST /api/ships/repair (docked, credit cost)
│       │   ├── ws.ts         # TASK-9 WS lifecycle: handshake state machine, structured errors, presence, 15s/45s keepalive
│       │   ├── shard/
│       │   │   ├── sim.ts  # TASK-13: SimLoop — 20 Hz fixed tick, drift-corrected setTimeout chain, 5-tick max catch-up + input-drop flag
│       │   │   ├── histogram.ts  # TASK-13: TickHistogram — ring-buffer tick durations, p50/p95/p99
│       │   │   ├── terrain.ts  # TASK-13: TerrainContext — 3x3 chunk neighborhood cache, bilinear O(1) heightAt, world-coord pads
│       │   │   ├── shard.ts  # TASK-13/23/24: SystemShard — input queues (latest-wins, stale seq), integrateShip per tick (destroyed skipped), applyHit + static 600 s wrecks, 10 Hz shared-buffer snapshots; loadShips() restart rehydration (saved flight state / dock coords / unexpired wrecks)
│       │   │   ├── types.ts  # TASK-13/23/24: Shard/ConnState/SimEntity contracts (kind 'wreck', destroyed/ttl, destroyedAtMs)
│       │   │   ├── persist.ts  # TASK-24: shard flush/load service — one-tx multi-row upsert to ships + load with expired-wreck cleanup, flush timer
│       │   │   ├── index.ts  # TASK-13: barrel exports
│       │   │   └── (tests) persist.test.ts (flush/load + p95 < 8 ms bench), crash-restart.test.ts (SIGKILL restart integration, real child server)
│       │   ├── persist.ts               # TASK-63 save-point service: dock/damage-milestone/5s-interval/shutdown, crash-load
│       │   ├── persist-crash-child.ts   # TASK-63 test helper: child process that saves state, then gets SIGKILL'd
│       │   ├── ratelimit.ts             # TASK-65 per-conn token bucket (20/s, burst 40), chat limiter (2 s gap / 280 chars / 10 per 30 s), 3-in-10 s escalation
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
│           ├── health.ts     # HealthPayload type
│           ├── random.ts     # Deterministic PRNG (xoshiro128**) + FNV-1a/splitmix hashing
│           ├── protocol.ts       # TASK-9: version constant, Envelope, encode/decode, parseMessage, error codes
│           ├── protocol/
│           │   └── schemas.ts    # TASK-9/23: zod payload schema per message type (combat_event damaged/destroyed) + EntityState/StateSnapshot shapes
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
