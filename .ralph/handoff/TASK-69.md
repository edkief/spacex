# TASK-69 handoff

## Status
Documentation set is written and verified; only the close-out bookkeeping remains. The five docs
(README + architecture/protocol/ops/contributing) are committed-ready in the working tree, every
acceptance criterion was exercised this session, and the full test suite is green — the task just
needs its `passes` flags flipped, a LOG entry, and a final commit.

## Done
All four task steps were executed this session:

- **Step 1 — README + quick-start dry run.** Wrote `/workspace/master/README.md` (game pitch,
  feature list, quick start, control list, tech stack, doc links). Key finding baked in: **the
  server runs on built-in defaults, so a fresh clone needs no `.env.local`** (the file is
  git-ignored and not in a clone). Dry run verified: `git clone /workspace/master
  /tmp/drift-clone` → `cd app && npm install` (288 pkgs) → `npm run dev` → log shows
  `injected env (0)` → `:3000` returns 200 → Playwright (chromium) claims screen renders
  (`#callsign-input`, `#claim-button`, `#claims-status` present, live availability probe returns
  "available", **zero console errors**) → `POST /api/callsigns {"callsign":"drift-alpha"}` →
  **201** with token → `GET /api/session` with the bearer token → **200**. Screenshot saved to
  `.ralph/screenshots/TASK-69-1-claims.png`. (An overlong callsign "drift-dryrun-alpha" (18 chars)
  correctly returned `400 invalid-callsign "must be 3-16 characters"`, and an empty-token auth
  correctly returned `401 malformed-token`.)
- **Step 2 — architecture + protocol.** Wrote `app/docs/architecture.md` (ASCII system diagram,
  determinism model, seamless-transition design [regimes/streaming/prediction-reconciliation/
  camera handoff], one-path combat pipeline, single-instance + `GalaxyRouter` scaling seam; each
  section links to owning source) and `app/docs/protocol.md` (written from the zod schemas in
  `src/shared/protocol/schemas.ts`: full client→server + server→client message tables, the entity
  shape + TASK-18 wire-compression defaults, `combat_event` variants, all 7 `error` codes, the real
  WS close codes, and the complete REST table incl. dev-only). Every message type in the code was
  checked against the doc.
- **Step 3 — ops + contribution.** Wrote `app/docs/ops.md` (every env var with defaults; the
  SQLite→Postgres switch + the honest proceed-gap note [no live PG in sandbox, dual-driver unit
  tests only, auto-migrator is SQLite-only]; backups; graceful restart; the load-bearing
  known-gaps section) and `app/docs/contributing.md` (Ralph task workflow, test gates incl.
  `load:smoke` required for combat/economy changes, perf/wire contract, AGENTS.md quality bar).
- **Step 4 — accuracy pass (all run this session, all green):**
  - `npm run perf:report desktop` → **overall PASS**.
  - Backups verified: online `db.backup()` **and** `wal_checkpoint(TRUNCATE)` + `cp` both read
    back 8 tables / 56 players, `PRAGMA integrity_check` = `ok`. (NOTE: a bare `cp` of `drift.db`
    while running is NOT complete — WAL holds live data; that is why ops.md documents the two
    correct methods.)
  - Graceful shutdown: `kill -TERM` on the tsx server → exited **code 0**.
  - Env-var cross-check: all 13 documented vars (PORT, SESSION_SECRET, GALAXY_SEED, DB_DRIVER,
    DB_PATH, DATABASE_URL, SYSTEM_INSTANCE_COUNT, WS_PATH, SHARD_FLUSH_INTERVAL_MS, STATIC_DIR,
    VITE_PORT, DEV_API_PORT, NODE_ENV) are read by `env.ts` / `vite.config.ts` / `routes/index.ts`.
  - Every internal doc link + in-page anchor resolves (checked programmatically).
  - `npm run typecheck` clean; full `npm test` green — **182 files, 1638 passed / 1 skipped**.
  - eslint + prettier clean over all new files.

## Working tree
- **Not committed (this is the work):** `README.md` (root, new), `app/docs/architecture.md`,
  `app/docs/protocol.md`, `app/docs/ops.md`, `app/docs/contributing.md` (all new),
  `.ralph/screenshots/TASK-69-1-claims.png` (new), and `.ralph/STRUCTURE.md` (modified — adds the
  four new `app/docs/*.md` entries; keep this, it is accurate).
- **Reverted deliberately (do NOT re-apply as "done"):** `.ralph/tasks.json` (`passes` back to
  `false`), `.ralph/tasks/TASK-69.json` (all 4 step `pass` back to `false`), `.ralph/logs/LOG.md`
  (status back to 87 / "next: TASK-69"). These were flipped to done mid-session and reverted so the
  next iteration re-verifies and closes. `.ralph/bench/TASK-58.json` was touched by the background
  `perf:report` run and has been reverted (not this task's scope).
- **Builds clean:** `tsc --noEmit` green, full vitest suite green, no background processes left
  running (dev server + clone server + perf report all killed).

## Next steps
1. Re-verify once (fast): `cd app && npm test` (~2 min) and `npm run typecheck`.
2. Flip `.ralph/tasks/TASK-69.json` — set all 4 step `pass` to `true`.
3. Set `"passes": true` for `TASK-69` in `.ralph/tasks.json` (currently the last entry, `"passes": false`).
4. Add a newest-at-top entry to `.ralph/logs/LOG.md` (date 2026-10-06, summary, screenshot path
   `.ralph/screenshots/TASK-69-1-claims.png`) and bump `Tasks Completed` 87 → 88 + update the
   `Current Task` line. The full verified-detail text was drafted this session — see `git log` /
   the draft in the reverted LOG for wording.
5. Commit with a conventional message, e.g. `docs(TASK-69): README, architecture, protocol, ops,
   contribution`.

## Dead ends
- **`npm run perf:report desktop` refreshed `.ralph/bench/TASK-58.json`** as a side effect (it is
  owned by TASK-58). Not a doc problem — reverted; don't commit that change as part of TASK-69.
- **Spec vs. code discrepancy (documented as-is, not a blocker):** the TASK-69 spec mentions
  "close codes incl. 4001", but the shipped code uses **1000 / 1002 / 1011 / 4009** (see
  `src/server/ws.ts`) — there is no 4001. `protocol.md` documents the real codes. Also
  `SYSTEM_INSTANCE_COUNT` is parsed (env.ts) but does **not** currently gate the in-process shard
  count (it's reserved for the future shard-manager seam); ops.md states this honestly. Flagging
  here in case a human wants the spec or code to change rather than the doc.
- A bare `cp data/drift.db` while the server runs produced an unreadable backup (empty main file,
  data in WAL) — switched to `db.backup()` / `wal_checkpoint(TRUNCATE)`+`cp`, both verified.

## How to verify
```bash
cd /workspace/master
# docs don't break the build
cd app && npm run typecheck && npm test        # expect: 182 files, 1638 passed / 1 skipped
cd /workspace/master
# every doc link + anchor resolves, every command in the docs runs
grep -n "ops.md#known-gaps-v1-scope-lines" README.md          # anchor present
```
The quick-start claim flow was already proven end-to-end on a clean clone (201 → 200 session
round-trip, screenshot at `.ralph/screenshots/TASK-69-1-claims.png`).
