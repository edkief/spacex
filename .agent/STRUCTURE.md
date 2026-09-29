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
│   │   └── gen-galaxy-snapshots.ts # npm run snapshot:update — regenerates the 6 TASK-6 snapshot fixtures
│   ├── smoke-task1.mjs       # TASK-1 Playwright smoke script (chromium screenshot)
│   └── src/
│       ├── client/
│       │   └── main.tsx      # React shell + #game-canvas placeholder
│       ├── server/
│       │   ├── env.ts        # zod-validated env (PROJECT_ROOT/.env.local)
│       │   ├── index.ts      # process entry: Fastify + ws, listens on PORT
│       │   └── server.ts     # buildServer() for tests/inject()
│       └── shared/
│           ├── canonical.ts  # canonicalJson: stable key-sorted JSON for checksums
│           ├── health.ts     # HealthPayload type
│           ├── random.ts     # Deterministic PRNG (xoshiro128**) + FNV-1a/splitmix hashing
│           └── galaxy/
│               ├── types.ts  # Star, SystemSummary, Planet, SurfaceChunk, Biome interfaces
│               ├── config.ts # GALAXY_STAR_COUNT, spectral weights, name word lists, disk params
│               ├── noise.ts  # deterministic 2D value noise + fBm (world-space lattice)
│               ├── stars.ts  # generateStars(seed, count) — seeded thin-disk galaxy layout
│               ├── system.ts # generateSystem(seed, starId) — planets, docks, deposits, AI roster
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
