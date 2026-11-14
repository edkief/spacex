# Project Build Log

`Current Status`
=================
**Last Updated:** 2026-11-14
**Tasks Completed:** 18 / 73
**Current Task:** TASK-13 Complete

----------------------------------------------

## Session Log

### 2026-11-14 — TASK-13 Server sim: 20 Hz tick with 10 Hz snapshots (lead-implemented)

- `src/server/shard/`: `SimLoop` (fixed 50 ms step, accumulator, max 5 catch-up ticks then drop), `Shard` (single-writer tick calling shared `stepShip`; latest input wins; stale seqs ignored; one-shot dock/undock actions are never lost to a later input in the same tick; presence; `entity_update` every second tick with the recipient's own `lastInputSeq`), `SurfaceAccess` (cached terrain fields, pads generated lazily only when a ship is on the ground), `ShardRouter` (replaces the directory stub: shard per system on first join, 16-player cap, reaped 60 s after emptying, ships saved on leave / every 5 s / on shutdown).
- Ships left by a disconnected owner stay in the sim with idle input. New pilots appear docked at their home system's first orbital dock.
- This also delivers the core of TASK-11 and TASK-12; still open there: `/api/galaxy/health`, the process-restart and leak tests, wiring the TASK-63 persistence service (the shard currently saves through the repository directly), and persisting ship orientation.
- Measured: 16 flying ships tick in 0.10 ms median, 0.33 ms p95 (budget 30 ms).
- The Sonnet worker session ran out of usage budget during this stretch; this task and the surface-chart rework were done by the lead.
- Verified: lint, typecheck, 774 unit tests, 2 e2e specs.

### 2026-11-14 — TASK-22 Flight model and world model (plus shared parts of TASK-25 and TASK-28)

- World model documented in `app/docs/world-model.md`: metres/seconds, planets at 1:100 scale (20-80 km landable, 200-600 km gas giants), static layout (star at origin, planets in the y = 0 plane, orbital docks at 1.6 R).
- System generator extended with layout, docks and atmosphere parameters; all previously generated fields are unchanged (verified over 800 systems).
- **Surface mapping (lead rework, commit 72ad7de):** two conformal stereographic charts per landable planet (`<planetId>:n|s`), terrain as 3D value noise on the sphere. Replaced a single azimuthal projection that stretched terrain up to ~32x and left a cap unlandable. Surface fixtures and digests were regenerated deliberately; star and system fixtures are byte-identical. Chunk generation is about 2.4 ms.
- Flight (`src/shared/physics/`): `stepShip` = docking + frame-local integration + frame/chart switching + regime resolution. Speed cap and acceleration scale with distance to the nearest body (1 + d/1000, max 4000x), swept-sphere collision, gravity/drag ramp at the atmosphere top, VTOL hover assist, terrain collision, pad detection. 100,000 km to 2 km altitude takes 75 s (interceptor) to 217 s (freighter).
- Regime resolution (`src/shared/regime.ts`) with 50 m hysteresis is done; TASK-25's client control remap and divergence handling, and TASK-28's visuals, remain open.
- Tasks TASK-72 (renderer core) and TASK-73 (input pipeline) were added: the original list assumed both without creating them.
- Open design notes: no speed rule yet for open-space combat at cruise speeds; renderer must use camera-relative math (positions reach 1e8 m).
- Verified by lead: lint, typecheck, 755 unit tests and 2 e2e specs pass.

### 2026-11-14 — TASK-9, 64, 65, 10, 66, 41 Protocol, validation, rate limiting, auth, credits REST

- Protocol v1 in `src/shared/protocol/`: JSON envelopes, separate client→server (18 types) and server→client (12 types) zod registries with inferred discriminated unions. Positions carry a frame (`system` or a planet id); EntityState has a quaternion.
- One dispatcher (`src/server/ws/dispatch.ts`) is the only path from socket to handler: envelope → version → type → connection state → schema → handler. Valid but unhandled types answer `not-implemented`. `SystemDirectory` stub stands in for shards.
- Limits: 64 KB frames, 20 msg/s (burst 40), chat 1 per 2 s and 10 per 30 s, 3 violations in 10 s closes with 4009; 8 sockets per IP, 4 per token; 5 callsign claims per minute per IP.
- Auth: `POST /api/callsigns` (uppercase-canonical callsigns), HMAC-SHA256 tokens valid only with signature + expiry + live session row, logout/revocation closes live sockets, permanent log-leak regression test. `GET /api/players/me` returns credits (TASK-41 complete).
- WS upgrades: same-origin only, no query strings, missing Origin allowed only outside production. `TRUST_PROXY` env var added.
- Server entry now opens the DB and runs migrations; dev DB lands in git-ignored `app/data/`.
- PRD note: section 10's "callsign re-claim revokes old sessions" is moot — re-claim is impossible (409).
- Not verified: production Postgres pool, real reverse proxy/TLS, non-Chromium browsers.
- Verified by lead: lint, typecheck, 629 unit tests and 2 e2e specs pass (real browser completes claim → hello → auth → join_system).

### 2026-11-14 — TASK-19, TASK-62, TASK-63 Ship catalog, Drizzle data layer, persistence service

- Ship catalog (`src/shared/ships/catalog.ts`) in SI units: scout 300 m/s, freighter 150 m/s, interceptor 450 m/s. These are local-manoeuvre speeds; long-range travel is a TASK-22 decision.
- Data layer: `src/server/db/schema.ts` is the single (SQLite-flavoured) schema; the Postgres schema is derived from it by introspection, with a drift test and a migration-reproducibility test. Migrations committed under `app/drizzle/{sqlite,pg}`.
- One async `Repository`, tested on real SQLite **and** real Postgres semantics via in-process PGlite (about 130 backend-parametrised tests). Production node-postgres wiring (`openPostgres`) is untested: no credentials for the local instance.
- Credits are atomic conditional updates; the 100-concurrent-withdrawal test passes on both backends. This covers the repository half of TASK-41; its REST endpoint comes with auth.
- Deviation from PRD section 8: `resource_node_state.system_id` added (needed by `listNodeStates(systemId)`). Enums are text + CHECK; pg `real` is `double precision`.
- Persistence service (`src/server/persist.ts`): dock/damage-threshold/interval/shutdown save points with injectable clock and scheduler; not yet wired to a shard. Real SIGKILL crash tests pass.
- Flush timing for 16 dirty ships: median about 3.3 ms, p95 about 4.6 ms, rare rounds 6-9 ms. The spec's strict "no >5 ms" is met typically but not guaranteed; revisit under the TASK-60 tick budget.
- Verified by lead: lint, typecheck and 337 tests pass.

### 2026-11-14 — TASK-2 to TASK-6 Deterministic PRNG and galaxy generation (M0)

- `src/shared/random.ts`: FNV-1a 64 seeding, splitmix64, xoshiro128**, `hash2`, 53-bit `nextF64`, unbiased `nextInt`, Irwin-Hall `nextGauss`. Golden values for `drift-dev-seed-001` were reproduced by the lead with a separate Python implementation.
- **Cross-engine rule:** generation code uses only exactly-specified operations (no sin/cos/log/exp/pow, no `**`); enforced by eslint and a source-scan guard test. This is why `nextGauss` is not Box-Muller as the spec suggested.
- Stars (200, disk layout, unique names), systems (2-6 planets, docks, resource fields, AI rosters), surface chunks (64x64 heightmap in decimetres at 4 m spacing, 256 m chunks, biomes, resource nodes, landing pads). `createSurfaceField` / `surfaceHeightAt` is the single source of truth for terrain height.
- Snapshot fixtures in `src/shared/galaxy/__fixtures__/` plus a digest fixture over all 200 systems and an 8x8 chunk grid per planet class; regenerate only with `npm run snapshot:update`. Mutation checks performed (four generator constants; all detected once digests were added).
- Known limits: node and jsdom both run V8, so cross-engine equality is by construction, not yet measured (TASK-71). Star #0 of the dev seed has no landable planet — spawn selection must not assume it does. Systems have no orbital positions yet; these will be added when the flight model needs them (fixtures will change deliberately).
- Verified by lead: lint, typecheck and 174 tests pass.

### 2026-11-14 — TASK-68 Scaffold TS monorepo (client/server/shared) with tooling

- `app/` created: Vite 8 + React 19 client (`src/client`, builds to `dist/client`), Fastify 5 + ws server (`src/server`, bundled to `dist-server` by esbuild), `src/shared` for code that runs verbatim in both.
- Dev: Vite on PORT (3000) proxies `/api` and WS_PATH to the Node server on API_PORT (PORT+1). Production: Node alone on PORT, serving the built client.
- `src/server/config.ts` validates env with zod as a pure function; SESSION_SECRET is required and errors never include values. Env file is `PROJECT_ROOT/.env.local`.
- Boundaries enforced by eslint + a DOM/Node-free `tsconfig.shared.json`: shared cannot import client/server or use DOM/Node globals.
- Vitest projects: `node` (all tests) and `dom` (jsdom; `*.dom.test.*` and `*.parity.test.*`, the latter run under both).
- Playwright uses a resolver (`tests/support/chromium.ts`) that falls back to the preinstalled Chromium 1254 because Playwright 1.65.1 expects an uninstalled revision.
- TypeScript pinned to 6.0.x (typescript-eslint does not support 7 yet).
- Verified by lead: lint, typecheck, 30 unit tests, build, build:server and the e2e smoke spec all pass. Screenshot: `.ralph/screenshots/TASK-68-1.png`.

### 2026-11-14 — TASK-1 Verify project prerequisites and access

- `.env.local` created at project root with all eight variable names; `SESSION_SECRET` generated locally (96 hex chars, never printed or logged); `DATABASE_URL` left as placeholder. File is git-ignored.
- Machine is x86_64 with Node v24.22.3 / npm 11.19.1 (PRD says Node 22; nothing tested objects to 24).
- better-sqlite3 13.2.0 installs from a prebuilt binary and round-trips a row in a temp dir.
- **PRD correction:** a Postgres 16 instance *is* listening on localhost:5432 (`pg_isready` OK). Credentials unknown and no login attempted. v1 dev stays on SQLite; live PG validation is possible later if credentials are provided.
- Doc links (three.js, Fastify, ws, Drizzle, better-sqlite3) and the npm registry all return 200.
- Chromium: preinstalled revision 1254 at `/opt/ms-playwright/chromium-1254/chrome-linux64/chrome` (`PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright`, root-owned). Latest @playwright/test (1.65.1) wants revision 1255 and cannot install into /opt, so e2e config must set `executablePath` (or pin Playwright). Headless WebGL2 context verified with the 1254 binary.
- MCPs: context7 and sequential-thinking available. **playwright MCP fails to connect** — `.mcp.json` points at `/home/agent/.cache/ms-playwright/chromium-1208/...`, which does not exist here. Gap recorded; e2e uses @playwright/test directly.
- Test users: none needed (callsign-only); e2e will use TEST-ALPHA / TEST-BRAVO.
- Stale `.ralph/STEERING.md` and `.ralph/STRUCTURE.md` from a previous run were reset (user-approved).
