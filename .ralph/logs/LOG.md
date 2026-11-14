# Project Build Log

`Current Status`
=================
**Last Updated:** 2026-11-14
**Tasks Completed:** 2 / 71
**Current Task:** TASK-68 Complete

----------------------------------------------

## Session Log

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
