# Project Directory Structure

Snapshot taken 2026-10-17 after **TASK-6** (galaxy determinism verification).

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
