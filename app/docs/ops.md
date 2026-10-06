# Operations

How to configure, switch databases, back up, and restart Drift — plus the
explicit v1 scope lines. Every command below was run during TASK-69 on the
checked-in stack.

## Environment variables

All are read by [env.ts](../src/server/env.ts) (a zod-validated schema that
applies the defaults). The file lives at **`PROJECT_ROOT/.env.local`** (the repo
root, one level above `app/`) — the server resolves it from the app directory
three levels up. Variables already set in the process always win over the file
(dotenv never overrides), which is how the dev scripts override `PORT`.

| variable                  | default                       | required        | meaning                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------- | ----------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                    | `3000`                        | no              | server listen port (REST + WS upgrade)                                                                                                                                                                                                                                                                                                                                                         |
| `SESSION_SECRET`          | `insecure-dev-session-secret` | **yes in prod** | HMAC key for session tokens. Any 64+ char random string. **Never commit a real value.**                                                                                                                                                                                                                                                                                                        |
| `GALAXY_SEED`             | `DRIFT-SEED-0001`             | no              | deterministic galaxy seed — same seed ⇒ identical world for every client                                                                                                                                                                                                                                                                                                                       |
| `DB_DRIVER`               | `sqlite`                      | no              | `sqlite` \| `postgres`                                                                                                                                                                                                                                                                                                                                                                         |
| `DB_PATH`                 | `./data/drift.db`             | sqlite only     | SQLite file path (created, WAL mode, parent dir auto-mkdir)                                                                                                                                                                                                                                                                                                                                    |
| `DATABASE_URL`            | `''`                          | postgres only   | Postgres connection string. Startup fails if `DB_DRIVER=postgres` and this is unset/placeholder                                                                                                                                                                                                                                                                                                |
| `SYSTEM_INSTANCE_COUNT`   | `3`                           | no              | parsed and defaulted; the test-child harness pins it to `1`. In the shipped single-instance design the router spawns shards on demand and this value does **not** currently gate the in-process shard count — it is reserved for the future process-level shard manager (the `GalaxyRouter` seam, see [architecture](architecture.md#single-instance--in-process-shards-and-the-scaling-seam)) |
| `WS_PATH`                 | `/ws`                         | no              | WebSocket upgrade path                                                                                                                                                                                                                                                                                                                                                                         |
| `SHARD_FLUSH_INTERVAL_MS` | `30000`                       | no              | periodic shard → DB flush cadence; a hard crash loses at most one interval                                                                                                                                                                                                                                                                                                                     |
| `STATIC_DIR`              | _(unset)_                     | no              | built client dir to serve from the API process (production single-image mode). Unset in dev, where Vite serves the client                                                                                                                                                                                                                                                                      |

Dev-only (not in `.env.local`, set by tooling):

- `VITE_PORT` / `DEV_API_PORT` (defaults `3000` / `3001`) — the Vite
  [proxy config](../vite.config.ts) targets; the e2e harness
  (`scripts/dev-test.mjs`) sets these to random free ports for an isolated boot.
- `NODE_ENV` — when not `production`, the dev-only `/api/dev/*` test routes are
  registered ([routes/index.ts](../src/server/routes/index.ts)).

A ready-to-run `.env.local` ships with the repo (git-ignored, but committed as a
placeholder with a safe default seed). Regenerate a fresh dev secret with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

## SQLite → Postgres switch

The data layer is one Drizzle schema compiled against **both** drivers
([schema.ts](../src/server/db/schema.ts)). To run against Postgres, set two
variables and nothing else:

```
DB_DRIVER=postgres
DATABASE_URL=postgres://<user>:<password>@<host>:5432/<db>
```

[createDb](../src/server/db/client.ts) opens a `pg` pool from `DATABASE_URL` in
this mode (and refuses to start if the URL is unset or the `TODO_FILL_MANUALLY`
placeholder). **Proceed-gap (honest):** there is no live Postgres in the dev
sandbox, so PG parity is verified by the Drizzle dual-driver unit tests, not by a
live run — live Postgres validation (including applying the schema against a
real PG) is a documented post-v1 gap. Note the auto-migrator
([migrate.ts](../src/server/db/migrate.ts)) applies `migrations/*.sql` to
**SQLite** at boot only; for Postgres the schema is created out-of-band (the
`.sql` files are dual-dialect).

## Backups

The database is a single SQLite file in WAL mode. A WAL file can hold the live
data, so **never copy `drift.db` alone while the server is running** — use one of
the two verified methods below.

**No-downtime (recommended)** — SQLite's online backup API, WAL-safe:

```bash
cd app
node -e "require('better-sqlite3')('./data/drift.db').backup('./backups/drift-$(date +%Y%m%d-%H%M%S).db').then(()=>console.log('ok'))"
```

**Stop-then-copy** — graceful stop folds the WAL into the main file, so a single
`cp` is complete:

```bash
cd app
kill -TERM <server-pid>          # graceful: flushes shards, exits 0
node -e "require('better-sqlite3')('./data/drift.db').pragma('wal_checkpoint(TRUNCATE)')"
cp data/drift.db backups/drift-$(date +%Y%m%d-%H%M%S).db
```

Verify any backup by opening it read-only and checking integrity
(`PRAGMA integrity_check` should return `ok`):

```bash
cd app
node -e "const db=require('better-sqlite3')('./backups/<file>.db',{readonly:true});console.log(db.prepare('PRAGMA integrity_check').get())"
```

**Postgres** — standard `pg_dump` (requires a live PG; see the proceed-gap above):

```bash
pg_dump "postgres://<user>:<password>@<host>:5432/<db>" --format=custom --file=drift-$(date +%Y%m%d-%H%M%S).dump
```

## Restart procedure

The server shuts down **gracefully** on `SIGTERM` / `SIGINT`
([index.ts](../src/server/index.ts)): it stops the reaper and flush timers, stops

- flushes every active shard (so nothing is lost), closes the WebSocket layer and
  Fastify, and exits `0`. A 10 s watchdog force-exits `1` if the flushes hang, so a
  wedge cannot hold the process (and its DB writes) open forever.

```bash
# Stop (graceful)
kill -TERM <server-pid>          # dev: the `PORT=3001 tsx src/server/index.ts` process

# Start
cd app && npm run dev            # dev (Vite :3000 + Node server :3001)
# or, production single image:
cd app && npm run build && npm run build:server
STATIC_DIR=dist node dist-server/index.js
```

On restart, in-process shards are re-spawned from the DB (ships rehydrated) and
clients reconnect + resync (TASK-17). Because state is flushed at a 30 s interval
and on graceful stop, a hard `kill -9` loses at most one flush interval.

## Known gaps (v1 scope lines)

These are deliberate v1 boundaries, not bugs. They live here for operators and
players alike.

- **Session expiry has no recovery.** Sessions live 7 days. When a token
  expires, the claims screen re-appears with the old callsign shown disabled —
  the player must claim a new callsign. There is no "recover my account" path.
- **Mobile = a rendering floor, not touch play.** A Mobile performance profile
  (auto-detected, 30 fps floor, reduced draw distance, no atmosphere dome) exists
  (TASK-59), but there are **no touch controls** — keyboard/mouse only.
- **No audio.** There is no sound of any kind in v1.
- **No key rebinding.** The control schemes are fixed per regime (see the
  [README](../../README.md#controls)). The Settings panel covers quality,
  sensitivity, and reduced motion — not key remap.
- **No crafting / trading market / voice / NPCs / ballistics** (PRD non-goals).
- **Single instance.** One Node process hosts all systems in-process; horizontal
  scale-out is designed for (the `GalaxyRouter` seam) but not shipped (see
  [architecture](architecture.md#single-instance--in-process-shards-and-the-scaling-seam)).
