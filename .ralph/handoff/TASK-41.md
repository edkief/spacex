# TASK-41 — Credits balance with persistence and spend rules

## Status
Implementation is essentially complete and **all 20 new tests pass**, plus all 590 prior tests still pass (610 total). Lint, typecheck, prettier all clean. Smoke-tested live via `npm run dev`: `POST /api/callsigns` + `GET /api/players/me` round-trip works against the real server. **Cannot set `passes: true` because the full `npm run test` suite is flaky** — ~7/30 runs fail in an unrelated pre-existing test in `src/server/auth/resolver.test.ts` that tampers tokens with a string-substitution pattern that does nothing if the token already ends with `'A'` (~5% of base64url-encoded HMAC signatures end in `A`). This is **not caused by my changes** (same failure rate with or without this branch), but the task spec says "All tests must pass" before flipping `passes`. The fix is a one-line change to that pre-existing test — see Next steps.

## Done

### Repository refactor (TASK-41 step 1)
- `app/src/server/db/repo.sqlite.world.ts` — `addCredits` and `withdrawCredits` now use **SQL-level atomic UPDATEs**:
  - `addCredits`: `UPDATE players SET credits = credits + ? WHERE id = ?` (uses `sql\`${col} + ${val}\``)
  - `withdrawCredits`: `UPDATE players SET credits = credits - ? WHERE id = ? AND credits >= ?` — the `credits >= ?` guard is the canonical compare-and-swap; `rowsAffected === 0` → disambiguate `NotFoundError` vs `InsufficientCreditsError` via a follow-up `findPlayerById`.
  - Renamed `getCredits` → `getBalance` on the SQLite world impl + `Repository` interface.
- `app/src/server/db/repo.pg.world.ts` — same atomic pattern via `sql\`${col} ± ${val}\``; same `getBalance` rename.
- `app/src/server/db/repo.sqlite.world.credits.ts` (NEW, 112 lines) — extracted `sqliteAddSync` / `sqliteWithdrawSync` helpers + `SqliteCreditHandle` interface so the world-binding file doesn't carry the SQL strings.
- `app/src/server/db/repo.ts` — added `getBalance` to `Repository`, added `PlayerCreditSlice` type + `SqliteRepositoryTransaction` (re-export of `SqliteCreditHandle`).
- `app/src/server/persist.ts` — switched the lone `getCredits(pid)` call site to `getBalance(pid)`.

### Transaction primitive (TASK-41 step 1, AC #6)
- `runInTransaction(fn)` exposed on the SQLite world impl. Uses Drizzle's `db.transaction(callback)` so a thrown callback automatically rolls back. Callback is **synchronous** because better-sqlite3 is sync. Returns `Promise<T>` to keep the surface uniform with the other async repo methods.
- The callback receives a `SqliteCreditHandle` with sync `addCredits` / `withdrawCredits` returning `{ id, credits }`.

### REST surface (TASK-41 step 2)
- `app/src/server/routes/players.ts` (NEW, 71 lines) — `GET /api/players/me` returns `{ callsign, credits, homeSystemId, shipId }`. Uses `loadSessionProfile()` from `auth/resolver.ts`. 401 on missing/malformed/tampered/revoked bearer token.
- `app/src/server/server.ts` — wired `registerPlayersRoutes(app, { repo, sessionSecret, nowMs })` inside the same `if (options.repo && options.sessionSecret && options.galaxySeed)` block that registers callsigns.

### Tests
- `app/src/server/db/repo.credits.test.ts` (rewritten, 265 lines, 12 tests):
  - `starts a fresh player at exactly 500 credits`
  - `credits is persisted as a non-negative integer`
  - `addCredits increments atomically and round-trips through getBalance`
  - `withdrawCredits decrements and rejects overdrafts` (unchanged from previous)
  - `addCredits/withdrawCredits reject non-positive amounts`
  - `withdrawCredits clamps to the zero floor (no debt)` — drains to 0 then refuses -1
  - **`100 concurrent withdrawals of 10 against 500 → 50 success, balance 0`** — TASK-41 AC #3 load-bearing test, passes deterministically
  - `100 concurrent mixed add+withdraw operations preserve balance arithmetic`
  - `runInTransaction commits when the callback resolves`
  - `runInTransaction rolls back every write when the callback throws` (over-withdraw inside txn rolls back prior writes)
  - `runInTransaction rolls back when a synthetic throw interrupts the callback`
  - `getBalance throws NotFoundError for an unknown player id`
- `app/src/server/routes/players.test.ts` (NEW, 193 lines, 8 tests): happy-path payload, reflected mutations, missing/malformed/tampered/revoked tokens all → 401, `/api/players/whatever-id` → 404 (no other-player endpoint), two players see only their own balances.

### Smoke test
- Live `npm run dev` server (port 3000): `POST /api/callsigns` with `"SMOKE-TASK-41"` returned a token; `GET /api/players/me` with that bearer returned `{callsign:"SMOKE-TASK-41", credits:500, homeSystemId:"cfd49a34bb6baf64", shipId:"..."}`. Missing-bearer → 401; bogus bearer → 401. Killed the dev server before handoff.

## Working tree

**Uncommitted** (in `/workspace/master`, branch `master`):

Modified:
- `app/src/server/db/repo.credits.test.ts` (rewritten)
- `app/src/server/db/repo.pg.world.ts` (atomic UPDATE pattern + `getBalance` rename)
- `app/src/server/db/repo.sqlite.world.ts` (atomic UPDATE pattern + `runInTransaction` + `getBalance` rename)
- `app/src/server/db/repo.ts` (interface updates)
- `app/src/server/persist.ts` (`getCredits` → `getBalance`)
- `app/src/server/server.ts` (registers new route)

New:
- `app/src/server/db/repo.sqlite.world.credits.ts`
- `app/src/server/routes/players.ts`
- `app/src/server/routes/players.test.ts`
- `.ralph/handoff/TASK-41.md` (this file)

Build state:
- `npm run typecheck` — clean
- `npm run lint` — clean
- `npm run lint:fix` — clean
- `npm run test` — **flaky** (see Status)

## Next steps

1. **Fix the pre-existing flaky test** in `app/src/server/auth/resolver.test.ts`. Three near-identical sites (`returns null for a tampered token` at line 138, `returns {revoked:false} for a token whose MAC is tampered` at line 250, and the analogous test in `app/src/server/routes/logout.test.ts`) all do:
   ```ts
   const tampered = `${claimed.token.slice(0, -1)}A`;
   ```
   This is a **no-op tampering** ~5% of the time (HMAC-SHA256 outputs that happen to end in `A` are unchanged). Fix: pick a deterministic non-matching char. E.g.:
   ```ts
   const lastChar = claimed.token[claimed.token.length - 1];
   const replacement = lastChar === "A" ? "B" : "A";
   const tampered = `${claimed.token.slice(0, -1)}${replacement}`;
   ```
   Or simpler — flip a *middle* byte: `claimed.token[10] === "A" ? claimed.token.slice(0,10) + "B" + claimed.token.slice(11) : claimed.token.slice(0,10) + "A" + claimed.token.slice(11)`. Once this is patched, run `npm run test` 5-10 times to confirm it's stable, then set `"passes": true` in `.ralph/tasks.json` for TASK-41 and commit.
2. Optionally add a Postgres `runInTransaction` parity in `app/src/server/db/repo.pg.world.ts` (not required by TASK-41; only the SQLite path is currently tested for AC #6). Future TASK-40 (dock selling) will need it.
3. Optional: extend the SQLite `players.credits` column with `CHECK (credits >= 0)` in `app/src/server/db/migrations/sqlite/0001_init.sql` for defence-in-depth (the atomic UPDATE pattern already enforces this, but a CHECK is cheap insurance). If you do, add a `0002_*.sql` migration; the existing `migrateSqlite()` runner picks up new files in lexical order.
4. Update `.ralph/STRUCTURE.md` to mention the new files under `app/src/server/db/` and `app/src/server/routes/`.
5. Append a `.ralph/logs/LOG.md` entry for TASK-41.

## Dead ends

- **Reaching for `db.$client.transaction()`**: I initially tried to use better-sqlite3's raw transaction handle via `(db as any).$client.transaction(callback)`. **Wrong** — `handle.transaction(fn)` returns a `[Function sqliteTransaction]` wrapper that must be *invoked* with `()` to actually execute. The correct path is Drizzle's own `db.transaction(callback)` which executes synchronously and returns the callback's result.
- **Async transaction callback**: better-sqlite3 is sync, so an `async fn` inside `db.transaction(() => …)` never yields between SQL statements. The callback must be sync; the wrapper exposes `runInTransaction(fn): Promise<T>` only to keep the signature uniform with the other repo methods.
- **Read-modify-write withdraw pattern**: the original `repo.sqlite.world.ts` did `findPlayerById → check → update → findPlayerById` (three SQL statements). This **breaks the atomicity test** because `await` boundaries allow other Promises to interleave, so two concurrent withdrawals can both read `balance=500` and both set credits=490. Fixed by collapsing to a single atomic UPDATE with the `credits >= ?` guard.

## How to verify

```bash
cd /workspace/master/app
npm run typecheck     # clean
npm run lint          # clean
npx vitest run src/server/db/repo.credits.test.ts src/server/routes/players.test.ts
                     # 20 tests, all deterministic pass
npm run test          # 610 tests; flaky pre-existing token-tamper test (see Next steps #1)
# Live smoke (after `rm -f data/drift.db && npm run dev`):
TOKEN=$(curl -sX POST localhost:3000/api/callsigns -H 'content-type: application/json' -d '{"callsign":"SMOKE-TASK-41"}' | jq -r .token)
curl -s localhost:3000/api/players/me -H "authorization: Bearer $TOKEN"
# → {"callsign":"SMOKE-TASK-41","credits":500,"homeSystemId":"…","shipId":"…"}
```

Files to focus on for review:
- `app/src/server/db/repo.sqlite.world.ts` (lines 1-110 = helpers, 130-200 = world binding, 256-267 = `runInTransaction`)
- `app/src/server/db/repo.sqlite.world.credits.ts` (new file, holds the atomic SQL helpers + the `SqliteCreditHandle` interface)
- `app/src/server/routes/players.ts` (new file, 71 lines, the REST endpoint)
- `app/src/server/db/repo.credits.test.ts` (atomicity + transaction tests)
- `app/src/server/routes/players.test.ts` (REST integration tests)