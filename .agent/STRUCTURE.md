# Project Structure

Excludes dotfiles, tests, and config.

```
/workspace/master
├── app/
│   ├── data/
│   │   └── drift.db          # local SQLite db (git-ignored)
│   ├── index.html            # Vite entry
│   └── smoke-task1.mjs       # TASK-1 Playwright smoke script (chromium screenshot)
├── ralph/                    # Ralph loop implementation (TypeScript)
│   └── src/
└── scripts/
    └── assets/
```

Notes:
- `app` is the Vite + React dev app (`npm run dev` → http://localhost:3000).
- `ralph/` is the standalone Ralph loop project driving opencode.
- Monorepo scaffolding (client/server/shared) is pending TASK-68.
