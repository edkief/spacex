# Drift — operations runbook

For whoever runs the thing: environment, database, backups, restarts, and an
honest list of what v1 does **not** do.

- [1. Environment variables](#1-environment-variables)
- [2. Database: SQLite and the Postgres switch](#2-database-sqlite-and-the-postgres-switch)
- [3. Backups and restore](#3-backups-and-restore)
- [4. Restart procedure](#4-restart-procedure)
- [5. Health and observability](#5-health-and-observability)
- [6. Known gaps (v1 scope)](#6-known-gaps-v1-scope)

---

## 1. Environment variables

The server reads `<PROJECT_ROOT>/.env.local` through `dotenv` (existing process env
wins, so a per-shell override always beats the file) — see
[`app/src/server/config.ts`](../app/src/server/config.ts). `PROJECT_ROOT`
defaults to the repository root (two levels above `app/`) and decides where
`.env.local` is looked up; override it in tests and containers.

The file is git-ignored. The template in the
[README quick start](../README.md#quick-start) is the minimum set.

### Production env contract

The Docker image (and the new TASK-77 prod gate) boot the server with **no
`.env.local` present at all** — `app/.dockerignore` excludes it from the build
context by design, the same way the prod gate sets `PROJECT_ROOT` to an empty
tmp dir. That makes the env contract the source of truth: every variable has
to be passed with `-e FOO=bar` (or `-e FOO` with a host-exported value) and
the server only knows what it can read from `process.env`. The full list:

| Variable          | Required in prod | What breaks if missing                                              |
| ----------------- | :--------------: | ------------------------------------------------------------------- |
| `SESSION_SECRET`  | **yes**          | `assertValidSecret` refuses to boot on an empty / short value.      |
| `GALAXY_SEED`     | no (default `DRIFT-SEED-0001`) | A different seed = a brand-new galaxy; don't change it on a live world. |
| `DB_DRIVER`       | no (default `sqlite`)           | Any value other than `sqlite` / `postgres` is a hard boot error.   |
| `DB_PATH`         | no (default `./data/drift.db`)  | The server creates the SQLite file on first boot; missing parent dirs do **not** fail. |
| `STATIC_DIR`      | **yes**          | Without it the server boots as API-only — the browser gets a 404 for `/`. |
| `PORT` / `API_PORT` | no (defaults `3000` and `3001`; the image sets both to `3000`) | The server binds to whatever `API_PORT` says; `PORT` only affects the static client's browser-facing port on a multi-process dev setup. |
| `PROJECT_ROOT`    | no (default = workspace root)    | Empty `PROJECT_ROOT` ≡ no `.env.local` ≡ env-only config. This is what the image uses. |

The Dockerfile already sets `STATIC_DIR=/app/dist/client`,
`PORT=3000`, `API_PORT=3000`, and `PROJECT_ROOT=/app`. Operators
just need to pass `SESSION_SECRET`, `GALAXY_SEED`, and the database
choice (`DB_DRIVER` + `DB_PATH` for SQLite, or `DB_DRIVER=postgres` +
`DATABASE_URL`). The TASK-77 prod gate reproduces this exact line
locally so CI fails loudly when the contract drifts:

```text
STATIC_DIR=<app>/dist/client \
PORT=<port> API_PORT=<port> \
DB_DRIVER=sqlite DB_PATH=<tmp>/drift.db \
GALAXY_SEED=PROD-E2E-<n> \
SESSION_SECRET=<64 hex chars> \
PROJECT_ROOT=<empty tmp dir> \
LOG_LEVEL=warn \
node dist-server/index.js
```

### Runtime — server

| Variable                  | Default               | Read by                           | Meaning                                                                                                                                                                                                             |
| ------------------------- | --------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SESSION_SECRET`          | _(none — boot fails)_ | `config.ts` + `auth/token.ts`     | 64+ char hex used to HMAC-sign session tokens and hash tokens at rest. **Required**: `assertValidSecret` refuses to boot on a missing/short value. Changing it invalidates every issued token (everyone re-claims). |
| `PORT`                    | `3000`                | `config.ts`, `vite.config.ts`     | User-facing client port (Vite in dev; the served client in prod).                                                                                                                                                   |
| `API_PORT`                | `PORT + 1` → `3001`   | `config.ts`, `vite.config.ts`     | Fastify + WS port. In the production image both are `3000`.                                                                                                                                                         |
| `WS_PATH`                 | `/ws`                 | `config.ts`                       | Path the WS upgrade is mounted on.                                                                                                                                                                                  |
| `GALAXY_SEED`             | `DRIFT-SEED-0001`     | `config.ts`                       | **The universe.** Changing it changes every star, planet, deposit and hazard for every player. Never change it on a live world without telling players.                                                             |
| `DB_DRIVER`               | `sqlite`              | `config.ts`                       | `sqlite` or `postgres`; any other value is a hard boot error.                                                                                                                                                       |
| `DB_PATH`                 | `./data/drift.db`     | `config.ts`, `db/client.ts`       | SQLite file path (relative paths resolve under `app/`), or the Postgres URL if `DB_DRIVER=postgres` and `DATABASE_URL` is unset.                                                                                    |
| `DATABASE_URL`            | _(unset)_             | `db/client.ts`                    | Postgres connection string. **Required** when `DB_DRIVER=postgres` — the factory throws otherwise.                                                                                                                  |
| `SYSTEM_INSTANCE_COUNT`   | `3`                   | `config.ts` → router              | Max concurrently loaded system shards before the least-used one is reaped.                                                                                                                                          |
| `STATIC_DIR`              | _(empty)_             | `config.ts` → `static.ts`         | Directory of the built client to serve. Empty in dev; `/app/dist/client` in the container.                                                                                                                          |
| `LOG_LEVEL`               | `info`                | `server.ts` (Fastify/pino)        | `trace \| debug \| info \| warn \| error \| fatal`.                                                                                                                                                                 |
| `SHARD_FLUSH_INTERVAL_MS` | `30000`               | `runtime.ts` → `shard/persist.ts` | Interval of the background safety-net flush. Lower = less to lose on a crash, more DB writes.                                                                                                                       |
| `PROJECT_ROOT`            | repo root             | `config.ts`                       | Where `.env.local` is loaded from.                                                                                                                                                                                  |

### Runtime — benchmarks, load and reports (not needed to play)

| Variable                                 | Default                           | Read by                         | Meaning                                                                                                      |
| ---------------------------------------- | --------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `BENCH_RENDER_MS`                        | `60000`                           | `scripts/bench-render.ts`       | Modelled scene time per render run.                                                                          |
| `BENCH_TICK_MS` / `BENCH_TICK_WARMUP_MS` | `120000` / `5000`                 | `scripts/bench-tick.ts`         | Tick measurement window / warmup.                                                                            |
| `LOAD_MS`                                | `300000` (`30000` with `--smoke`) | `scripts/load.ts`               | Load-scenario duration.                                                                                      |
| `LOAD_REPORT`                            | `data/load-report.json`           | `scripts/load.ts`               | Where the load report is written.                                                                            |
| `LOAD_CHECKS`                            | unset                             | `scripts/load.ts`               | Set to `snapshot-rate,cap-enforcement` to run only those gates.                                              |
| `LOAD_TEST_MS`                           | `12000`                           | `tests/load/load.test.ts`       | Duration of the 16-client CI load test.                                                                      |
| `PERF_RENDER_MS`                         | `60000`                           | `scripts/perf-report.ts`        | Render window inside a perf report.                                                                          |
| `PERF_TICK_MS`                           | `120000`                          | `scripts/perf-report.ts`        | Tick window inside a perf report.                                                                            |
| `PERF_LOAD_MS`                           | `30000`                           | `scripts/perf-report.ts`        | Load window inside a perf report (the TASK-18 acceptance run is `300000`).                                   |
| `PERF_PHONE_CDP`                         | unset                             | `scripts/perf-report.ts`        | Chrome remote-debugging endpoint of an attached phone; without it the mobile loop row is reported `BLOCKED`. |
| `SHIP_CLASS_ID`                          | `scout`                           | `scripts/shard-crash-runner.ts` | Ship class used by the crash-recovery harness.                                                               |

Every variable above is read by the code path named; there are no unread
entries in `.env.local`.

---

## 2. Database: SQLite and the Postgres switch

**Default (and what v1 runs on): SQLite.** `better-sqlite3`, WAL journal mode,
foreign keys on, migrations applied from
[`app/src/server/db/migrations/sqlite/`](../app/src/server/db/migrations/sqlite)
at boot. The file lands at `app/data/drift.db` (git-ignored, created on first
run).

**Switching to Postgres** is two variables in `.env.local`:

```bash
DB_DRIVER=postgres
DATABASE_URL=postgres://user:pass@host:5432/drift
```

Then apply the Postgres migrations as an operator step
(`drizzle-kit migrate --config drizzle.config.ts`, or `psql -f` the generated
SQL) and restart. Two honest caveats, both from TASK-62:

1. **What was verified.** The Postgres schema is a true twin of the SQLite one —
   same logical tables, same columns, same JSON shapes — and this is asserted by
   [`app/src/server/db/pg.parity.test.ts`](../app/src/server/db/pg.parity.test.ts),
   which imports both schemas, compares table/column structure, and round-trips
   the Postgres schema through `drizzle-kit generate --dialect postgresql` to
   emit real DDL. The repository layer is written against one interface
   ([`repo.ts`](../app/src/server/db/repo.ts)) with two implementations.
2. **The proceed gap.** No live Postgres instance has ever been booted in this
   environment: `createPostgresClient()` returns a **no-op `migrate()`**
   ([`db/client.ts`](../app/src/server/db/client.ts)) because running migrations
   is operator-driven, and no end-to-end gameplay run has been executed against
   a real PG server. Treat the switch as _code-complete, migration-manual,
   runtime-unproven_. If you are deploying on Postgres, run the load smoke
   (`npm run load:smoke`) against it before you trust it — that is exactly the
   kind of thing this note exists for.

---

## 3. Backups and restore

### SQLite

The database runs in **WAL mode**, so `cp`ing only `drift.db` while the server is
running can miss recent commits in `drift.db-wal`. Two supported procedures:

**a. Hot backup (no downtime) — `VACUUM INTO`.** Produces a consistent,
compacted snapshot in one statement:

```bash
cd app
node -e "
const Database = require('better-sqlite3');
const db = new Database('data/drift.db', { readonly: true });
db.exec(\"VACUUM INTO 'data/drift-backup.db'\");
db.close();
"
```

**b. Cold backup (server stopped).** Stop the process first — the clean
shutdown checkpoints the WAL — then copy the file:

```bash
# with the server stopped
cp app/data/drift.db /var/backups/drift-$(date +%F-%H%M).db
```

Keep the `.db-wal`/`.db-shm` files too if you copy while running, and restore
them alongside, or use (a).

**Restore:** stop the server, replace `app/data/drift.db` with the backup,
remove the stale `-wal`/`-shm` files, start the server. Players come back with
their ships, cargo, credits and deposit depletion exactly as backed up.

The background flush (`SHARD_FLUSH_INTERVAL_MS`, default 30 s) bounds how much
in-memory shard state exists at any moment; the explicit flush points (dock,
damage milestone, warp, interval, shutdown) bound it further. A `kill -9` loses
at most one flush interval of movement — verified by the crash-recovery suites
[`shard/persist.crash.test.ts`](../app/src/server/shard/persist.crash.test.ts)
and [`persist.crash.test.ts`](../app/src/server/persist.crash.test.ts).

### Postgres

```bash
pg_dump --format=custom --file=drift-$(date +%F-%H%M).dump "$DATABASE_URL"
# restore
pg_restore --clean --if-exists --dbname="$DATABASE_URL" drift-2026-10-21-0518.dump
```

---

## 4. Restart procedure

`app/src/server/index.ts` installs `SIGINT` and `SIGTERM` handlers. On either
signal the process:

1. logs the signal and starts a **10 s shutdown watchdog**
   (`DEFAULT_SHUTDOWN_WATCHDOG_MS`),
2. calls `runtime.close()`, which **flushes every loaded shard** through the
   repository (this is the save-on-shutdown guarantee, TASK-12),
3. disposes the flush service, closes the WS server and the Fastify app,
4. closes the database handle, and exits `0`. If the watchdog fires first it
   logs an error and force-exits `1` so an orchestrator restarts it.

So the operator procedure is the ordinary one:

```bash
# graceful: prefer this
kill -TERM <pid>          # or Ctrl-C in the foreground
# verify in the log:
#   {"msg":"shutting down"} {"msg":"flushing shards before shutdown"} → process exits 0

# only if the process is wedged
kill -KILL <pid>          # worst case: one SHARD_FLUSH_INTERVAL_MS of movement
```

In a container the same applies — `docker stop` sends `SIGTERM` and waits; give
it more than 10 s of grace so the watchdog never has to fire. After any restart
the galaxy is identical (it is seed-derived), players resume their last system
via `GET /api/session`'s `lastSystemId`, and in-flight mining rows are dropped
cleanly (the mining cadence is the only authority for awards, so a crash cannot
double-pay).

Rolling restarts behind a load balancer will drop WS connections; clients
re-auth automatically and receive a full `state_snapshot` resync
(`ws.reconnect.test.ts` covers the 5 s-drop scenario).

---

## 5. Health and observability

| What               | Where                                                                                                                              |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Liveness + seed    | `GET /api/health` → `{ok, galaxySeed}` ([`server.ts`](../app/src/server/server.ts))                                                |
| Shard occupancy    | `GET /api/galaxy/health` → `{shards, shardCount, totalPlayers, routerStartedAt}` (bearer token; drives the chart's occupancy dots) |
| Star-chart payload | `GET /api/galaxy/overview`                                                                                                         |
| Structured logs    | pino via Fastify, level from `LOG_LEVEL`                                                                                           |
| Frame monitor      | in-game `F3` overlay (dev builds)                                                                                                  |
| Load gates         | `npm run load:smoke` writes `app/data/load-report.json`                                                                            |
| Perf sign-off      | `npm run perf:report desktop` writes `app/data/perf-report-desktop.json`                                                           |
| Production gate    | `npm run test:e2e:prod` rebuilds the client + server and exercises the same `STATIC_DIR=dist/client node dist-server/index.js` command line the image ships (TASK-77) |

---

## 6. Known gaps (v1 scope)

These are deliberate PRD v1 scope lines, listed so operators and players are not
surprised. None of them is a hidden bug.

1. **Session expiry has no recovery path.** Tokens are HMAC-signed with an
   expiry; when one lapses the server answers `unauthenticated` and closes the
   socket. The client returns you to the claims screen — but a callsign can only
   ever be claimed **once**, so an expired token is effectively a lost ship and
   credits. There is no password reset, no email recovery, no "log in again"
   flow. Set `SESSION_SECRET` to something you can keep, and if you need a
   longer-lived world, extend the token TTL in
   [`app/src/server/auth/resolver.ts`](../app/src/server/auth/resolver.ts) and
   revoke by `logout`.
2. **Mobile support is a rendering floor, not touch controls.** The mobile
   performance profile and the 30 fps floor are real
   (see [performance.md](performance.md)), but there are **no touch
   controls**, no virtual stick, no on-screen fire button. Mobile is a viewer /
   low-spec path; flight needs a keyboard and a mouse.
3. **No audio.** The game is silent by design in v1 — no engine hum, no weapons,
   no UI clicks. Nothing to mute, nothing to configure.
4. **No key rebinding.** The bindings in the [README](../README.md#controls)
   are fixed in [`app/src/shared/settings.ts`](../app/src/shared/settings.ts)
   (`KEYBINDS`) and
   [`app/src/client/input/controls.ts`](../app/src/client/input/controls.ts).
   The settings record already persists quality, sensitivity and reduced
   motion; binds were cut from v1 scope.
5. **One process, one galaxy seed.** No horizontal scale-out, no multi-region,
   no cross-process shards (the seam is described in
   [architecture.md](architecture.md#5-one-instance-many-shards--and-the-scaling-seam)).
6. **No player trading, crafting, mods, stations as social hubs, or voice
   chat** — all explicit PRD non-goals for v1.
