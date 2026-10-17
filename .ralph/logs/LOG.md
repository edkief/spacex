# Project Build Log

`Current Status`
=================
**Last Updated:** 2026-10-17 12:35
**Tasks Completed:** 3 of 71
**Current Task:** TASK-2 Complete

----------------------------------------------

## Session Log

### 2026-10-17 — Iteration 3
- **TASK-2** Shared deterministic PRNG + hash library → **DONE**
  - New module `app/src/shared/random.ts` (280 lines) — pure TypeScript, zero imports.
    Exports:
      - `seedFromString(s: string): bigint` (FNV-1a 64-bit over UTF-8 bytes via `TextEncoder`).
      - `Rng` class (xoshiro128** over a 4×U32 state seeded from any `bigint` via 4× splitmix64 rounds) with `nextU32()`, `nextF64()`, `nextRange(min, max)`, `nextInt(n)`, `pick(arr)`, `nextGauss(mean, sd)`.
      - `hash2(a, b): bigint` (XOR-multiply mix + splitmix64 finalizer) for per-entity sub-seeds.
  - Two test files: `random.test.ts` (node env) and `random.parity.test.ts` (happy-dom env via per-file `// @vitest-environment` pragma). The Vitest 4 default is to use the per-file pragma; `environmentMatchGlobs` was removed in v4 so the existing `vitest.config.ts` was updated to document the per-file pattern.
  - 36 vitest cases pass (21 new + 15 pre-existing). Coverage:
      - Golden values for `seedFromString` on 4 known strings (incl. FNV offset basis check on `""`).
      - Golden `nextU32()` and `nextF64()` sequences for `drift-dev-seed-001` (8 each).
      - Rng construction determinism + cross-seed divergence.
      - `hash2` stability and order-sensitivity.
      - `nextRange`, `nextInt` (incl. distribution), `pick`, `nextGauss` (mean/sd check).
      - 100k-sample chi-square-lite uniformity test (per-bin dev < 20%, chi² < 21.7 at 9 d.o.f.).
      - Source purity: reads `random.ts`, strips comments, asserts no `Math.random`, `Date.now`, `Date.constructor`, `crypto`, `globalThis.*`, or `performance.now`.
      - Happy-dom parity: same digest/U32/F64/hash2 values under `// @vitest-environment happy-dom`.
  - Added `happy-dom` to `app/devDependencies` (lighter than jsdom; we only need `TextEncoder` / `Uint8Array` shape).
  - `npm run typecheck`, `npm run lint`, `npm run lint:fix`, `npm run test` all clean. No UI surface → no Playwright smoke needed for this task (TASK-2 is `functional` not `ui-ux`).

### 2026-10-17 — Iteration 2
- **TASK-68** Scaffold TS monorepo (client/server/shared) with tooling → **DONE**
  - Created `app/src/{shared,client,server}` trees with strict TypeScript (`tsconfig.json`, target ES2022, module ESNext, moduleResolution bundler, `strict: true`).
  - Path aliases wired in `tsconfig.json`, `vite.config.ts`, and `vitest.config.ts`: `@shared/*`, `@client/*`, `@server/*`.
  - Server (`src/server/`): `config.ts` loads `PROJECT_ROOT/.env.local` via dotenv with defaults; `server.ts` exposes `buildApp()` (testable via Fastify `inject()`); `ws.ts` attaches a `ws.Server` at `config.wsPath`; `index.ts` listens on `apiPort = PORT + 1` (default 3001) so Vite (PORT=3000) and Fastify don't collide.
  - Client (`src/client/`): `main.tsx` mounts a React shell, `App.tsx` lays out a stable `<canvas>` placeholder (`data-testid="drift-canvas"`) for the three.js renderer, plus a "DRIFT — SCAFFOLD" HUD label; Vite proxies `/api` and `/ws` to the Fastify server.
  - Tooling: `npm run dev` (concurrently vite + tsx), `npm run build` (vite build), `npm run test` (vitest), `npm run typecheck` (tsc --noEmit), `npm run lint` (eslint + prettier --check), `npm run start` (tsx server). Plus `eslint.config.js` (flat config, typescript-eslint + prettier) and `.prettierignore`.
  - Tests: 15 vitest cases pass (3 files: prereqs, shared/health, server/server). One Playwright e2e (`tests/e2e/scaffold.spec.ts`) renders the React shell, asserts the canvas is visible, hits `/api/health` through the Vite proxy, and fails on any console error.
  - Smoke verified end-to-end: `curl http://localhost:3000/api/health` (proxied) and `curl http://localhost:3001/api/health` (direct) both return `{"ok":true,"galaxySeed":"DRIFT-SEED-0001"}`; `ws://localhost:3001/ws` upgrades and replies `{"type":"hello",...}`.
  - Screenshot: `.ralph/screenshots/TASK-68-1.png` — shows the dark canvas with the "DRIFT — SCAFFOLD" header (no console errors).
  - `.gitignore` updated to exclude `app/data/`, `data/`, `playwright-report/`, `test-results/`, and `.pi/`.
  - `.ralph/STRUCTURE.md` refreshed to reflect the new `app/src/**` layout.

### 2026-10-17 — Iteration 1
- **TASK-1** Verify project prerequisites and access → **DONE**
  - Confirmed `.env.local` exists with all 8 required names from PRD §7 (PORT, SESSION_SECRET, GALAXY_SEED, DB_DRIVER, DB_PATH, DATABASE_URL, SYSTEM_INSTANCE_COUNT, WS_PATH); `SESSION_SECRET` filled with a 64-char hex value (length checked only — value never exported).
  - `.env.local` is git-ignored; secret value is not present in any tracked file or in chat/PRD/task artifacts.
  - Verified `better-sqlite3@^11` resolves and can create/read `./data/drift.db` (DB_PATH) inside the sandbox.
  - MCP servers (playwright, context7, sequential-thinking) are declared in `.mcp.json` and reachable on npm (registry HEAD OK).
  - All five PRD §7 documentation links return HTTP 200 (three.js, Fastify, ws, Drizzle ORM, better-sqlite3).
  - Callsign-only auth confirmed (no test user setup needed); e2e planned against `TEST-ALPHA` / `TEST-BRAVO` (created at runtime, no secrets).
  - Recorded **user-approved proceed gaps** (per TASK-1 step 4 / acceptance criteria):
    1. No live Postgres in this sandbox — PG parity will be exercised via Drizzle dual-driver unit tests on SQLite now and against the postgres-js adapter in CI later. Live PG validation is post-v1.
    2. Headless CI WebGL is functional-only; render-performance verification (SC-1/SC-4/SC-5) will be confirmed on reference hardware, not in this sandbox.
  - Added automated guard test at `app/prereqs.test.ts` (12 vitest cases) so a future regression in any of the above items fails CI.
  - Dev server (`npm run dev`) was **not** started: the app scaffold lands in TASK-68, and `app/package.json` currently has no `scripts` entry. Start deferred to that task.
  - No screenshot — TASK-1 is environment/setup verification with no UI surface yet.
