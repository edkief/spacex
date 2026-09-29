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
│   └── src/
│       ├── client/
│       │   └── main.tsx      # React shell + #game-canvas placeholder
│       ├── server/
│       │   ├── env.ts        # zod-validated env (PROJECT_ROOT/.env.local)
│       │   ├── index.ts      # process entry: Fastify + ws, REST routes + token auth + ship-swap broadcast, listens on PORT
│       ├── shards.ts     # TASK-20: in-process ship-swap bus + shipToEntity + entity_update broadcast bridge (folds into TASK-11/12)
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
│       │       └── ships.ts        # TASK-20: GET /api/ships + POST /api/ships/buy (docked purchase, tx: withdraw + scrub + insert)
│       │   ├── ws.ts         # TASK-9 WS lifecycle: handshake state machine, structured errors, presence, 15s/45s keepalive
│       │   ├── persist.ts               # TASK-63 save-point service: dock/damage-milestone/5s-interval/shutdown, crash-load
│       │   ├── persist-crash-child.ts   # TASK-63 test helper: child process that saves state, then gets SIGKILL'd
│       │   ├── ratelimit.ts             # TASK-65 per-conn token bucket (20/s, burst 40), chat limiter (2 s gap / 280 chars / 10 per 30 s), 3-in-10 s escalation
│       │   └── db/
│       │       ├── schema.ts          # dual-driver Drizzle schema (sqlite + pg), 6 tables + row types
│       │       ├── client.ts          # createDb/getDb: DB_DRIVER → better-sqlite3 file (WAL) | pg Pool; migrate on boot
│       │       ├── migrate.ts         # sequential .sql migrator with _migrations tracking table (sqlite)
│       │       ├── repo.ts            # Repository: players/ships/cargo/credits/nodes/sessions; zod-validated JSON
│       │       ├── errors.ts          # CallsignTakenError, InsufficientCreditsError, NotFoundError
│       │       └── migrations/
│       │           └── 000000_init.sql # initial SQLite DDL
│       └── shared/
│           ├── canonical.ts  # canonicalJson: stable key-sorted JSON for checksums
│           ├── callsign.ts   # TASK-10: shared zod callsign schema (3-16 alnum+dash, lowercase transform)
│           ├── health.ts     # HealthPayload type
│           ├── random.ts     # Deterministic PRNG (xoshiro128**) + FNV-1a/splitmix hashing
│           ├── protocol.ts       # TASK-9: version constant, Envelope, encode/decode, parseMessage, error codes
│           ├── protocol/
│           │   └── schemas.ts    # TASK-9: zod payload schema per message type + EntityState/StateSnapshot shapes
│           ├── ships.ts          # TASK-19: SHIP_CLASSES (scout/freighter/interceptor) + shipStats/compareShips/totalWeaponCount/shipPrice
│           ├── physics/
│           │   ├── vec.ts        # TASK-22: Vec3/Quat ops (add/scale/dot/cross/normalize/lerp, fromEuler/multiply/toMat3/rotateVector)
│           │   ├── atmosphere.ts # TASK-22: 1 km drag boundary ramp atmosphereFactor (shared with TASK-28)
│           │   └── flight.ts     # TASK-22: integrateShip — deterministic space/atmosphere/VTOL physics + ground collision (substepped)
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
