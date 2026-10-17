# Project Directory Structure

Snapshot taken 2026-10-17 after **TASK-19** (Ship catalog: 3 data-driven ship classes).

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
│   ├── package.json             # Scripts: dev, build, test, typecheck, lint, snapshot:update
│   ├── playwright.config.ts     # Playwright e2e config (base URL :3000)
│   ├── prereqs.test.ts          # TASK-1 prerequisite guard tests
│   ├── src/
│   │   ├── shared/              # Wire types/utilities shared client+server
│   │   │   ├── galaxy/          # Seed-derived galaxy geometry (TASK-3+4+5)
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
│   │   │   ├── protocol/        # WS protocol: envelope + handshake + zod schemas (TASK-9)
│   │   │   │   ├── index.ts          # PROTOCOL_VERSION, EnvelopeSchema, encode/decode, parseMessage, ProtocolError
│   │   │   │   ├── schemas.ts        # One zod schema per message type + PAYLOAD_SCHEMAS registry
│   │   │   │   └── schemas.test.ts   # Parametrized valid/invalid + envelope round-trip
│   │   │   ├── random.ts        # seedFromString + Rng (xoshiro128**) + hash2 (TASK-2)
│   │   │   ├── random.test.ts   # Golden / distribution / purity suite (node)
│   │   │   ├── random.parity.test.ts # Same golden values under happy-dom
│   │   │   ├── ships.ts         # SHIP_CLASSES + shipStats/compareShips/totalWeaponCount/shipPrice (TASK-19)
│   │   │   └── ships.test.ts    # 32 cases: shape, stat validity, balance, helpers, throw on unknown
│   │   ├── client/              # React + three.js frontend (Vite)
│   │   │   ├── App.tsx          # Top-level shell
│   │   │   ├── components/      # UI sub-components (CanvasStage.tsx)
│   │   │   ├── index.html       # Vite HTML entry
│   │   │   ├── main.tsx         # React DOM bootstrap
│   │   │   └── public/          # Static assets served by Vite (favicon.ico)
│   │   └── server/              # Fastify + ws backend (tsx)
│   │       ├── config.ts        # dotenv loader + typed ServerConfig
│   │       ├── index.ts         # Entry: listen + graceful shutdown
│   │       ├── server.ts        # buildApp() factory (testable via inject)
│   │       ├── server.test.ts   # Fastify inject() smoke for /api/health
│   │       ├── persist.ts       # PersistService: save points + dirty-set + interval (TASK-63)
│   │       ├── persist.test.ts          # 27 cases covering save points + dirty flag (TASK-63)
│   │       ├── persist.crash.test.ts    # Child-process SIGKILL → loadSystemState round-trip (TASK-63)
│   │       ├── persist.bench.test.ts    # 16-ship dirty-flush perf benchmark (TASK-63)
│   │       ├── ws.ts            # ws upgrade handler attached to Fastify (TASK-9)
│   │       ├── ws.connection.ts # Connection struct + ConnectionRegistry (TASK-9, extended with bucket/floodTracker/chatLimiter in TASK-65)
│   │       ├── ws.dispatch.ts   # processRawFrame + dispatch + noteInvalidInput + noteRateViolation + INVALID_DROP_THRESHOLD=50 + MAX_MESSAGE_BYTES=64KB (TASK-9 + TASK-64 + TASK-65)
│   │       ├── ws.dispatch.helpers.ts # sendFrame + sendError + closeFloodedConnection (TASK-65)
│   │       ├── ws.handlers.ts   # onHello + onAuth + onJoinSystem + onChat per-state handlers (TASK-9 + TASK-65)
│   │       ├── ws.resolvers.ts  # defaultAuthResolver + defaultJoinResolver stubs (TASK-9)
│   │       ├── ratelimit.ts     # TokenBucket + FloodTracker + ChatLimiter + constants (TASK-65)
│   │       ├── ratelimit.test.ts        # Unit tests: accept/accept/reject + sliding window + chat window (TASK-65)
│   │       ├── ratelimit.flood.test.ts  # Flood benchmark: attacker drops with code 4009 within 5 s (TASK-65)
│   │       ├── ws.ratelimit-helpers.ts  # Shared harness helpers for rate-limit integration tests (TASK-65)
│   │       ├── ws.ratelimit.test.ts     # Rate-limit integration: bucket + chat + escalation + isolation (TASK-65)
│   │       ├── ws.fuzz-helpers.ts # bootFuzzHarness + openFuzzClient + collectFuzzMessages (TASK-64)
│   │       ├── ws.fuzz-payloads.ts # 20 crafted malformed payloads + REQUIRED_FUZZ_NAMES + nestedObject/byteString builders (TASK-64)
│   │       ├── validation-fuzz.test.ts # 6 cases: 20-payload burst + 1 MB size cap + health hammered + threshold pin (TASK-64)
│   │       ├── ws.auth.test.ts # WS auth via real callsign/token resolver: claim, resume, duplicate, out-of-order (TASK-10)
│   │       ├── ws.test.ts       # Real Fastify+ws boot: handshake, errors, unknown-type, keepalive (TASK-9)
│   │       ├── ws.logout.test.ts # 7 cases: WS `logout` → `logout_ok` + 1000 close + concurrent-use + unauthenticated path (TASK-66)
│   │       ├── routes/          # REST route registrations
│   │       │   ├── callsigns.ts # POST /api/callsigns + GET /api/session + POST /api/session/logout (TASK-10 + TASK-66)
│   │       │   ├── callsigns.test.ts # 11 cases: POST /api/callsigns + GET /api/session (REST integration via fastify.inject) (TASK-10)
│   │       │   └── logout.test.ts # 12 cases: POST /api/session/logout revoke + double-logout + tampered/garbage tokens (TASK-66)
│   │       └── auth/            # Token codec + WS auth resolver (TASK-10)
│   │           ├── token.ts     # HMAC-SHA256 session-token codec: sign/verify/hashToken + clock-skew tolerance (TASK-10)
│   │           ├── resolver.ts  # claimCallsign + resumeSession + revokeSession + buildAuthResolver + buildLogoutResolver + pickHomeSystemId (TASK-10 + TASK-66)
│   │           ├── token.test.ts # 16 cases: round-trip, expiry (fake clock), MAC tamper, payload tamper, length-tolerance (TASK-10) + 162-case exhaustive codec matrix (TASK-66)
│   │           ├── resolver.test.ts # 19 cases: schema validation, claim happy path, duplicate, resume, profile, WS resolver adapter (TASK-10) + revokeSession + buildLogoutResolver + concurrent-use (TASK-66)
│   │           └── log-leak.test.ts # Log-leak guard: Fastify capture-stream logger scan for SESSION_SECRET/raw token/tokenHash across full claim/logout cycle (TASK-66)
│   │       └── db/              # Drift persistence layer (TASK-62 / TASK-63)
│   │           ├── types.ts     # PlayerRow / ShipRow / etc. + zod shapes for JSON columns
│   │           ├── errors.ts    # CallsignTakenError / InsufficientCreditsError / NotFoundError
│   │           ├── schema.ts    # selectSchemaFor(driver) re-exports both bundles
│   │           ├── schema.sqlite.ts   # better-sqlite3 schema (sqliteTable)
│   │           ├── schema.pg.ts       # postgres schema (pgTable, pgEnum, jsonb)
│   │           ├── client.ts   # createDbClient(loadConfig) — driver factory
│   │           ├── migrate.ts   # tiny SQL-bookkeeping runner over hand-written *.sql files
│   │           ├── migrations/sqlite/0001_init.sql  # Six tables + indexes + CHECKs + `_drift_migrations`
│   │           ├── repo.ts      # Repository interface + constants (DEFAULT_LIVERY, STARTER_HULL, …)
│   │           ├── repo.helpers.ts   # parseDate / parseJsonField / clampInt / mapUniqueViolation
│   │           ├── repo.sqlite.ts    # SQLite factory (composes identity + world sub-bindings)
│   │           ├── repo.sqlite.identity.ts   # players / ships / cargo methods (SQLite)
│   │           ├── repo.sqlite.world.ts      # credits / nodes / sessions / registry (SQLite)
│   │           ├── repo.sqlite.mappers.ts    # text → *Row coercion for SQLite
│   │           ├── repo.pg.ts        # Postgres factory (composes identity + world sub-bindings)
│   │           ├── repo.pg.identity.ts       # players / ships / cargo methods (Postgres)
│   │           ├── repo.pg.world.ts          # credits / nodes / sessions / registry (Postgres)
│   │           ├── repo.pg.mappers.ts        # native-Date + jsonb coercion for Postgres
│   │           ├── migrate.test.ts            # migrateSqlite() idempotency + table sanity (TASK-62)
│   │           ├── pg.parity.test.ts          # drizzle-kit generate parity (no live PG required)
│   │           ├── repo.test.shared.ts        # per-test harness factory (`installRepoHooks()`)
│   │           ├── repo.players.test.ts       # createPlayer / findPlayer* / CallsignTakenError
│   │           ├── repo.ships.test.ts         # getOrCreateStarterShip / saveShipState / NotFoundError
│   │           ├── repo.cargo.test.ts         # saveCargo wipe-and-replace + zero-quantity filtering
│   │           ├── repo.credits.test.ts       # add/withdrawCredits + InsufficientCreditsError
│   │           └── repo.world.test.ts         # nodes / sessions / system registry + schema invariants
│   ├── drizzle.config.ts         # drizzle-kit config for operator-driven PG migrations
│   ├── tests/
│   │   └── e2e/
│   │       └── scaffold.spec.ts # Playwright smoke (canvas + /api/health)
│   ├── scripts/
│   │   ├── gen-stars-fixture.ts         # Regenerate __fixtures__/stars-dev-seed.json (TASK-3)
│   │   ├── gen-stars-full-fixture.ts    # Regenerate __fixtures__/stars-dev-seed-full.json (TASK-6)
│   │   ├── gen-system-fixture.ts        # Regenerate __fixtures__/system-dev-seed-star0.json (TASK-4)
│   │   ├── gen-system-star1-fixture.ts  # Regenerate __fixtures__/system-dev-seed-star1.json (TASK-6)
│   │   ├── gen-surface-fixture.ts       # Regenerate chunk00 fixture (TASK-5)
│   │   ├── gen-surface-chunk10-fixture.ts # Regenerate chunk10 fixture (TASK-6)
│   │   └── gen-surface-chunk01-fixture.ts # Regenerate chunk01 fixture (TASK-6)
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
