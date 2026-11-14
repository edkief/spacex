# Project Build Log

`Current Status`
=================
**Last Updated:** 2026-11-14
**Tasks Completed:** 10 / 71
**Current Task:** TASK-63 Complete

----------------------------------------------

## Session Log

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
