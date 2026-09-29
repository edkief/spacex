# Project Build Log

`Current Status`
=================
**Last Updated:** 2026-09-29
**Tasks Completed:** 5
**Current Task:** TASK-4 Complete

----------------------------------------------

## Session Log

### 2026-09-29 — TASK-4: System generator (planets, docks, deposits, AI roster)
Implemented pure, deterministic star-system generation on top of the TASK-3 star generator:
- `app/src/shared/galaxy/system.ts` — `generateSystem(seed, starId): SystemGen` + `generatePlanet(seed, starId, index): Planet`. Sub-seed = hash2(seedFromString(seed), seedFromString(starId)); per-planet sub-seed hash2(systemSub, j) so planets are order-independent and planet ids (16-hex) are stable keys for TASK-5. systemId = hex of the system sub-seed; name = star name + ' system'; star class/name drawn from the same sub-seed Rng (reused exported `pickSpectralClass`/`makeStarName` from stars.ts).
- Per-planet fixed draw order: class (weighted rocky 32/terran 18/ice 20/ocean 12/gas 18), radiusKm (gas 20k–60k, else 2k–8k), hasAtmosphere (per-class probability), landable (gas never; per-class probability), dockCount (1–3 landable / 0 else), resourceTypes (1–3 unique from iron/copper/silicon/rare-earths/water/gas-compounds), aiRoster (count 2–5, classes from scout/freighter/interceptor matching TASK-19 ids), name (prefix+root, deterministic re-draw on in-system collision).
- `types.ts` — Planet rebuilt to TASK-4 shape (class, radiusKm, hasAtmosphere, landable, dockCount, resourceTypes, aiRoster); added PlanetClass, ShipClassId, AiRoster, SystemGen. `config.ts` — planet class weights, per-class atmosphere/landable chances, RESOURCE_TYPES, SHIP_CLASS_IDS.
- Golden fixture `__fixtures__/system-dev-seed-star0.json`: star #0 of dev seed 'drift-dev-seed-001' (id 7dc36749a54c15d8), sha256=67f44440…fe418 of canonical JSON.
- Tests `system.test.ts` (16): golden snapshot (deep-equal + checksum), determinism across two calls, per-planet independence vs generatePlanet (fresh independent Rng per planet), two identically-seeded Rng instances draw identically, divergence on star/seed change, systemId formula check; 200-system statistical suite: 2–6 planets, unique 16-hex ids, unique names, radius bounds, gas never landable, dockCount bounds, resource/roster bounds — and 182/200 (91%) systems have ≥1 landable+atmosphere planet (>80% required); invariants repeated for 3 other seeds (incl. unicode + empty) × 30 systems.
- No UI changes → Playwright/e2e skipped (pure logic, unit coverage complete).
- Verified: `tsc --noEmit`, `eslint --fix` + `prettier --write`, full `npm run test` → 6 files / 63 tests all pass.

### 2026-09-29 — TASK-3: Star generator (seeded galaxy layout)
Implemented pure, deterministic galaxy star generation on top of the TASK-2 PRNG:
- `app/src/shared/galaxy/types.ts` — Star, SystemSummary, Planet, SurfaceChunk interfaces (forward-looking; later tasks extend).
- `app/src/shared/galaxy/config.ts` — GALAXY_STAR_COUNT=200, GALAXY_RADIUS=1000, GALAXY_THICKNESS=40, spectral weights (O:1 B:5 A:10 F:15 G:20 K:28 M:21), name word lists (45 prefixes / 44 roots / 43 suffixes, all unique), log-normal disk-radius helper.
- `app/src/shared/galaxy/stars.ts` — `generateStars(seed, count=200)`: per-star sub-seed `hash2(seedFromString(seed), i)` → Rng; thin-disk position (log-normal radius, uniform angle, clamped gaussian z), weighted spectral class, seeded 40+ word-combiner name with deterministic collision re-draw (guarantees uniqueness), systemCount 2..8, id = 16-hex sub-seed (stable key for TASK-4 / DB).
- `app/src/shared/canonical.ts` — `canonicalJson` (recursively key-sorted) for platform-stable checksums.
- Golden fixture `app/src/shared/galaxy/__fixtures__/stars-dev-seed.json`: seed 'drift-dev-seed-001', 200 stars, first 25 embedded, sha256=1b043184…6b0e90 of canonical JSON of all stars.
- Tests `stars.test.ts`: golden snapshot (deep-equal + length + checksum), default/custom count + prefix property, 5 seeds (incl. unicode + empty) × determinism / unique 16-hex ids / unique names / coordinate bounds / systemCount + class validity, distribution check (O+B < 25, K+M > 70 of 200). 24 new tests.
- No UI changes → Playwright/e2e skipped (pure logic, unit coverage complete).
- Verified: `tsc --noEmit`, `eslint --fix` + `prettier --write`, full `npm run test` → 5 files / 47 tests all pass.

### 2026-09-29 — TASK-2: Shared deterministic PRNG + hash library
Implemented `app/src/shared/random.ts` — pure, zero-import module (root of galaxy determinism):
- `seedFromString(s): bigint` — FNV-1a 64-bit over UTF-8 bytes (BigInt arithmetic). Verified against the known 'hello' vector (0xa430d84680aabd0b) and the '' offset basis.
- `Rng` (xoshiro128** over 4×U32, seeded via splitmix64 from a 128-bit seed): `nextU32()`, `nextF64()` (24-bit precision, documented tradeoff), `nextRange(min,max)`, `nextInt(n)`, `pick(arr)`, `nextGauss(mean,sd)` (Box-Muller, log(0)-guarded). Zero-state guard for all-zero seeds.
- `hash2(a,b): bigint` — order-sensitive 64-bit key combiner (splitmix finalizer) for per-entity sub-seeds.
- Tests: `random.test.ts` (node) — golden values for seed 'drift-dev-seed-001' (8× nextU32 + 5× nextF64 hardcoded), 3 known seedFromString strings, hash2 golden values, determinism/divergence, helper bounds + coverage, gauss moments, source-grep purity test (no Math.random/Date.now/crypto/performance.now/new Date, comments stripped), 100k-sample chi-square-lite uniformity (<20% bin deviation). `random.browser.test.ts` — `@vitest-environment happy-dom` parity suite asserting the identical golden constants.
- Added `happy-dom` devDependency for the parity environment. No UI changes → Playwright/e2e skipped (unit coverage complete).
- Verified: `npm run typecheck`, `eslint --fix` + `prettier --write`, full `npm run test` → 4 files / 23 tests all pass.

### 2026-09-29 — TASK-68: Scaffold TS monorepo (client/server/shared) with tooling
Stood up the `app/` scaffold (work was partially present uncommitted from a prior pass; verified, fixed, and completed it):
- Source trees `app/src/{shared,client,server}` with `@shared/*`, `@client/*`, `@server/*` aliases in tsconfig.json, vite.config.ts, and vitest.config.ts (strict, ESNext/bundler, ES2022).
- Server: `src/server/index.ts` (dotenv from PROJECT_ROOT/.env.local, Fastify + ws at WS_PATH, PORT from env), `server.ts` (buildServer for inject() tests), `env.ts` (zod-validated env with defaults: PORT, SESSION_SECRET, GALAXY_SEED, DB_DRIVER, DB_PATH, SYSTEM_INSTANCE_COUNT, WS_PATH). Client: `src/client/main.tsx` React shell with stable `#game-canvas` placeholder.
- Vite dev server proxies `/api` and `/ws` to the Node server (port 3001) so the browser stays same-origin.
- npm scripts: dev (concurrently vite + tsx server), build, test, test:e2e, typecheck, lint, start. Deps per spec (three, react, fastify, ws, drizzle-orm, better-sqlite3, zod, dotenv, tsx, concurrently, typescript-eslint, etc.).
- eslint flat config (typescript-eslint recommended) + .prettierrc (semi, singleQuote, printWidth 100). `.env.local` and `data/` confirmed git-ignored; added `test-results/` to root .gitignore.
- Tests: `src/shared/health.test.ts` (vitest), `src/server/health.test.ts` (Fastify inject → /api/health 200 {ok, galaxySeed}), Playwright `tests/scaffold.spec.ts` (canvas + health + no console errors).
- Verified: `npm run dev` boots both (vite :3000, server :3001), /api/health 200 via proxy, WS welcome on /ws; lint/typecheck/test/build all green; Playwright 1/1 passed.
- Screenshot: `.agent/screenshots/TASK-68-1.png`

### 2026-09-29 — TASK-1: Verify project prerequisites and access
Verified all prerequisites; task passes.
- `.env.local` present at PROJECT_ROOT with all 8 required names (PORT, SESSION_SECRET, GALAXY_SEED, DB_DRIVER, DB_PATH, DATABASE_URL, SYSTEM_INSTANCE_COUNT, WS_PATH); SESSION_SECRET holds a real 64-char random value (value not printed/stored anywhere but the git-ignored file); DATABASE_URL left as placeholder (SQLite driver in use).
- Storage: Node v24.20.0 + npm 11.19.0 available. `better-sqlite3` verified installable in a temp dir; create + insert + select round-trip succeeded. Valid SQLite file exists at `app/data/drift.db` (header "SQLite format 3").
- Gaps recorded with proceed decision:
  1. **No live Postgres in sandbox** — proceed; PG parity to be covered by Drizzle dual-driver unit tests (per PRD).
  2. **MCP servers in `.mcp.json` (playwright/context7/sequential-thinking) are not registered for this implementing agent** (no tools in the agent catalog; `.mcp.json` playwright executable path `/home/agent/.cache/...` is stale — actual browser lives at `/opt/ms-playwright/chromium-1243`). Proceed: direct Playwright via `@playwright/test` + chromium works (smoke run produced a screenshot with no console errors), so functional equivalence is covered.
  3. **Headless CI WebGL is functional-only**; perf verification deferred to reference hardware.
- Service docs reachable (HTTP 200 after redirects): threejs.org/docs, fastify.dev/docs, github.com/websockets/ws, orm.drizzle.team, github.com/WiseLibs/better-sqlite3.
- Test users: callsign-only auth; e2e will create disposable callsigns TEST-ALPHA / TEST-BRAVO at runtime. No passwords stored.
- Steering work completed: deps installed, Playwright system deps + chromium installed, dev server started (HTTP 200 at :3000), screenshot taken.
- Screenshot: `.agent/screenshots/TASK-1-1.png` (smoke: `app/smoke-task1.mjs`)
