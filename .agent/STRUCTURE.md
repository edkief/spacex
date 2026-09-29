# Project Structure

Excludes dotfiles, tests, and config.

```
/workspace/master
├── app/
│   ├── data/
│   │   └── drift.db          # local SQLite db (git-ignored)
│   ├── index.html            # Vite entry
│   ├── smoke-task1.mjs       # TASK-1 Playwright smoke script (chromium screenshot)
│   └── src/
│       ├── client/
│       │   └── main.tsx      # React shell + #game-canvas placeholder
│       ├── server/
│       │   ├── env.ts        # zod-validated env (PROJECT_ROOT/.env.local)
│       │   ├── index.ts      # process entry: Fastify + ws, listens on PORT
│       │   └── server.ts     # buildServer() for tests/inject()
│       └── shared/
│           └── health.ts     # HealthPayload type
├── ralph/                    # Ralph loop implementation (TypeScript)
│   └── src/
└── scripts/
    └── assets/
```

Notes:
- `app` is the Vite + React client (port 3000); the Node server (Fastify + ws) runs on port 3001 in dev; Vite proxies `/api` and `/ws` so the browser stays same-origin.
- Path aliases: `@shared/*` → `src/shared/*`, `@client/*` → `src/client/*`, `@server/*` → `src/server/*` (tsconfig, vite, vitest).
- `ralph/` is the standalone Ralph loop project driving opencode.
