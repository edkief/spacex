# Project Directory Structure

Snapshot taken 2026-10-17 after **TASK-3** (star generator).

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
│   ├── package.json             # Scripts: dev, build, test, typecheck, lint
│   ├── playwright.config.ts     # Playwright e2e config (base URL :3000)
│   ├── prereqs.test.ts          # TASK-1 prerequisite guard tests
│   ├── src/
│   │   ├── shared/              # Wire types/utilities shared client+server
│   │   │   ├── galaxy/          # Seed-derived galaxy geometry (TASK-3+)
│   │   │   │   ├── types.ts     # Star, SpectralClass, SystemSummary, Planet, SurfaceChunk
│   │   │   │   ├── config.ts    # GALAXY_STAR_COUNT, spectral weights, name lists
│   │   │   │   ├── stars.ts     # generateStars(seed, count?) — keystone of SC-2
│   │   │   │   ├── canonical.ts # canonicalJson + starListChecksum (Node + browser)
│   │   │   │   ├── stars.test.ts          # Determinism / uniqueness / golden
│   │   │   │   ├── stars.parity.test.ts   # Same output under happy-dom
│   │   │   │   └── __fixtures__/
│   │   │   │       └── stars-dev-seed.json # Committed golden snapshot
│   │   │   ├── health.ts        # HealthPayload interface + factory
│   │   │   ├── health.test.ts   # Trivial vitest (TASK-68 acceptance)
│   │   │   ├── random.ts        # seedFromString + Rng (xoshiro128**) + hash2 (TASK-2)
│   │   │   ├── random.test.ts   # Golden / distribution / purity suite (node)
│   │   │   └── random.parity.test.ts # Same golden values under happy-dom
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
│   │       └── ws.ts            # ws upgrade handler attached to Fastify
│   ├── tests/
│   │   └── e2e/
│   │       └── scaffold.spec.ts # Playwright smoke (canvas + /api/health)
│   ├── scripts/
│   │   └── gen-stars-fixture.ts # Regenerate __fixtures__/stars-dev-seed.json
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