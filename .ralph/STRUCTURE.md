# Project Directory Structure

Snapshot taken 2026-10-17, immediately after **TASK-1** (prerequisites verified).
The application code itself is not yet scaffolded — that lands in **TASK-68** —
so this file lists the supporting files and the empty `app/` skeleton.

## Conventions
- Dotfiles (`.env*`, `.git*`, `.mcp.json`, `.eslintrc*`, …) are excluded.
- Test files (`*.test.ts(x)`) are excluded.
- Configuration/build output (`dist/`, `node_modules/`) is excluded.
- Generated artefacts under `.ralph/history` and `.ralph/screenshots/*.png`
  are excluded by `.gitignore`.

## Top-level layout
```
PROJECT_ROOT
├── AGENTS.md                    # Agent conventions (read first)
├── CLAUDE.md                    # Stub pointer to AGENTS.md
├── app/                         # TS monorepo (scaffolded in TASK-68)
│   ├── data/                    # Runtime SQLite DB lives here (gitignored)
│   ├── dist/                    # Build output (gitignored)
│   ├── node_modules/            # Installed deps (gitignored)
│   ├── package-lock.json
│   ├── package.json             # Tooling: vite, vitest, playwright, react plugin
│   ├── playwright.config.ts     # Playwright e2e config (base URL :3000)
│   └── vitest.config.ts         # Vitest config (includes app/**/*.test.ts)
├── node_modules/                # Top-level runtime deps (gitignored)
├── opencode.json                # opencode provider/model registry (repo-local)
├── ralph/                       # Vendored ralph runtime
├── ralph.config.json            # Ralph loop config (timeouts, retries, etc.)
└── scripts/                     # Auxiliary scripts (placeholder)
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
