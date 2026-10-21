# Drift

**A server-authoritative, deterministic open-galaxy space sim that runs in a browser tab.**

Drift is a 3D WebGL multiplayer world where every player owns a persistent ship
and explores one shared galaxy. The galaxy is not streamed from a database — it
is _derived from a seed_, so two players who connect an hour apart, from
different entry points, in different star systems, see byte-identical stars,
planets, terrain, resource fields and docks. Only mutable state (your ship,
your cargo, your credits, which deposits you have emptied) is ever stored.

The differentiator is the transition. You fly from open space into a planet's
atmosphere and down onto its surface **without a loading screen, without a black
frame, and without a hitch** — the terrain streams in around you while the
flight model keeps running, and the same client-side code that predicts your
ship's motion also predicts your character's footsteps. Then you press `E`,
step out onto the ground, walk to a deposit, mine ore into a weight-capped
backpack, climb back in, and sell it at a dock for credits.

---

## Features

- **Deterministic procedural galaxy** — 32 seeded stars, each with planets,
  atmospheres, landing pads, resource fields and rogue AI, all reproducible
  from `GALAXY_SEED` and verified by cross-runtime snapshot tests (node vs
  browser).
- **Seamless space ↔ atmosphere ↔ surface** — regime changes stream terrain in
  and out continuously; every transition frame is benchmarked against a 4 ms
  budget (`npm run bench:transitions`).
- **On-foot mode with re-entry** — disembark, walk, jump, run, mine with a
  server-timed 1.5 s channel, and board again in under a second.
- **Server-authoritative multiplayer** — one Fastify process hosts unlimited
  star systems as in-process _shards_, capped at 16 real players per system,
  at a fixed 20 Hz tick with 10 Hz entity snapshots.
- **Prediction + reconciliation** — the client runs the same physics module the
  server does and reconciles against snapshots without visible snapping.
- **Ship combat & PvE** — lock-on targeting, lasers and missiles, shields and
  hull, drone hazards, wreck markers, ship destruction with cargo loss and an
  automatic respawn on the nearest dock.
- **Economy loop** — mine → backpack → cargo hold → dock → credits; buy better
  ships, repair hulls, paint liveries that every other player sees.
- **Cheat resistance** — an audited abuse suite fires teleports, hit claims,
  frame floods and oversize payloads at the real server and asserts the
  invariants that matter (no negative balances, no free credits, no unbounded
  cargo).
- **Live quality settings** — High/Medium/Low presets re-tune chunk detail,
  draw distance, star count and FX caps without a reload.

---

## Quick start

Requires **Node.js >= 22** and npm. No database server is needed for local
play — the default driver is SQLite and the file is created for you.

```bash
# 1. Clone
git clone <this-repo> drift && cd drift

# 2. Create the environment file (it is git-ignored, by design)
cat > .env.local <<'EOF'
PORT=3000
SESSION_SECRET=change-me-to-64-plus-random-hex-characters-0000000000000000000000000000
GALAXY_SEED=DRIFT-SEED-0001
DB_DRIVER=sqlite
DB_PATH=./data/drift.db
SYSTEM_INSTANCE_COUNT=3
WS_PATH=/ws
EOF

# 3. Install and run (from the app/ sub-project)
cd app && npm install && npm run dev
```

Then open **<http://localhost:3000>**.

`npm run dev` starts two processes: the Vite dev server on `PORT` (3000) and
the Fastify + WebSocket game server on `API_PORT` (3001 by default, proxied by
Vite). The first screen you see is the **claims screen** — type a callsign
(3–16 characters, letters, digits and dashes), wait for the green _available_
chip, press
**Claim**, and you are dropped into a docked scout at the first system's
station. `?autoclaim=1` skips the claims screen with a random callsign (used by
the e2e suite).

To play on the production build instead:

```bash
cd app
npm run build         # vite build -> dist/client
npm run build:server  # esbuild bundle -> dist-server/
STATIC_DIR=dist/client node dist-server/index.js
```

That `STATIC_DIR=dist/client node dist-server/index.js` command is the same
command line the Docker image ships (TASK-69) and the same one the new
production-gate e2e exercises end-to-end (`npm run test:e2e:prod`, see
[TASK-77](../../.ralph/tasks/TASK-77.json)). No `.env.local` is loaded — the
container's `.dockerignore` excludes it — so every value below has to be
passed as an environment variable (`SESSION_SECRET`, `GALAXY_SEED`,
`DB_DRIVER`, `DB_PATH`, `PORT`/`API_PORT`, `STATIC_DIR`, `PROJECT_ROOT`).
See **[docs/ops.md](docs/ops.md#1-environment-variables)**.

### What the production build supports today

- **Fly your ship** with `W A S D` (thrust / yaw), `Q E` (roll),
  `Space` (up), `Shift` (boost), `1` / `2` to switch between laser and
  missiles, `T` to lock onto the nearest target in a 30° cone. The
  client-side predictor (`__driftClient.predictor`) reconciles your
  inputs against the 10 Hz server snapshots so the loop stays smooth
  even on a 80 ms RTT.
- **See other players and AI ships** — the renderer's pooled mesh
  layer mirrors every entity the server ticks (other players, rogue
  AI, wrecks, drones). Live list in the right-hand rail.
- **See the star and its planets** — the system body layer derives
  the star + planets from the same galaxy seed the server uses
  (`__driftSystemBodyLayer`), so two players in the same system
  agree down to the wire.
- **Warp to another star** — `M` to open the chart, click a different
  star, click Warp. The server runs the canonical 2 s in + 2 s out
  transition and your `currentSystemId` flips on the next
  `state_snapshot`.
- **Claims screen + dock spawning** — type a callsign (3–16
  characters, letters, digits and dashes) on the home screen,
  wait for the green _available_ chip, press Claim. The image is
  backed by SQLite by default (`DB_DRIVER=sqlite`); switch to
  Postgres via `DB_DRIVER=postgres` + `DATABASE_URL` (see
  [docs/ops.md](docs/ops.md#2-database-sqlite-and-the-postgres-switch)).

### Known gaps (production v1)

- **On-foot characters render as placeholders.** You can exit the
  ship and walk around a docked pad, but the character model is
  not yet drawn — the scene shows a placeholder shape. The
  physics, regime transition and inventory are wired end-to-end.
- **Terrain / chunk streaming is not drawn yet.** The earth /
  surface chunks the streaming pipeline produces are present
  server-side, but the client-side terrain renderer is not yet
  wired into the scene tree.
- **No key rebinding.** The flight / foot / menu bindings in the
  controls table below are fixed in
  `app/src/shared/settings.ts` and `app/src/client/input/controls.ts`.

Full environment reference, Postgres switch, backups and the restart
procedure: **[docs/ops.md](docs/ops.md)**.

---

## Controls

| Context  | Keys               | Action                                                                |
| -------- | ------------------ | --------------------------------------------------------------------- |
| Flight   | `W` / `S`          | Thrust / reverse                                                      |
| Flight   | `A` / `D`          | Yaw left / right                                                      |
| Flight   | `Q` / `E`          | Roll left / right                                                     |
| Flight   | `Space`            | Thrust up                                                             |
| Flight   | `Shift`            | Boost                                                                 |
| Flight   | Mouse              | Look                                                                  |
| Flight   | `1` / `2`          | Select laser / missile                                                |
| Flight   | `T`                | Lock the nearest target in a 30° cone, 500 m (press again to release) |
| Docked   | `E`                | Disembark — step out onto the pad                                     |
| On foot  | `W A S D`, `Space` | Move / jump                                                           |
| On foot  | `Shift`            | Run                                                                   |
| On foot  | `E` (hold)         | Interact — mine a deposit, board the ship                             |
| Anywhere | `M`                | Star chart → select a system → warp                                   |
| Anywhere | `Esc`              | Menu (systems / ships / settings)                                     |
| Anywhere | `Enter`            | Chat (last 100 messages are restored)                                 |
| Anywhere | `F3`               | Frame-monitor debug overlay                                           |

v1 has **no key rebinding** (see [docs/ops.md](docs/ops.md#known-gaps)).

---

## Tech stack

| Layer      | Choice                                                              |
| ---------- | ------------------------------------------------------------------- |
| Client     | TypeScript, React 19, three.js 0.186, Vite 8, DOM/CSS HUD           |
| Transport  | JSON WebSocket frames (`ws`), versioned envelope `{v,type,payload}` |
| Server     | Node 22, Fastify 5, `ws`, TypeScript run through `tsx`              |
| Simulation | Fixed 20 Hz authoritative tick, 10 Hz entity snapshots              |
| Data       | Drizzle ORM over SQLite (`better-sqlite3`) or Postgres (`pg`)       |
| Validation | zod schemas shared by client and server                             |
| Tests      | Vitest (unit + integration), Playwright (e2e), custom harnesses     |

---

## Documentation

| Doc                                          | What it covers                                                                               |
| -------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [docs/architecture.md](docs/architecture.md) | System diagram, determinism model, seamless-transition design, combat pipeline, scaling seam |
| [docs/protocol.md](docs/protocol.md)         | Every WebSocket message type both directions, error codes, close codes, the REST API         |
| [docs/ops.md](docs/ops.md)                   | Environment variables, SQLite → Postgres switch, backups, restart procedure, known gaps      |
| [docs/contributing.md](docs/contributing.md) | Task workflow, test gates, performance contract, code-quality bar                            |
| [docs/performance.md](docs/performance.md)   | The v1 reference-hardware performance sign-off (TASK-61)                                     |

---

## Commands

Run from `app/`:

| Command                       | What it does                                                                                       |
| ----------------------------- | -------------------------------------------------------------------------------------------------- |
| `npm run dev`                 | Vite + game server in watch mode                                                                   |
| `npm test`                    | Full Vitest suite (unit + integration + abuse)                                                     |
| `npm run test:e2e`            | Playwright end-to-end suite (dev mode, Vite + tsx). Does **not** include the prod gate.            |
| `npm run test:e2e:prod`       | Production-build gate (TASK-77): builds the client + server, boots `node dist-server/index.js`, runs the gate spec |
| `npm run typecheck`           | `tsc --noEmit`                                                                                     |
| `npm run lint`                | ESLint + Prettier check                                                                            |
| `npm run lint:fix`            | ESLint `--fix` + Prettier write                                                                    |
| `npm run build`               | Client build (vite → `dist/client/`)                                                               |
| `npm run build:server`        | Server bundle (esbuild → `dist-server/index.js`)                                                   |
| `npm run bench:transitions`   | Regime-transition frame budget benchmark (TASK-30)                                                 |
| `npm run bench:render`        | Worst-case render budget benchmark (TASK-58)                                                       |
| `npm run bench:tick`          | 20 Hz tick cost benchmark (TASK-61)                                                                |
| `npm run load:smoke`          | 30 s / 16-client load acceptance run (TASK-18)                                                     |
| `npm run perf:report desktop` | Full reference-hardware report + JSON output (TASK-61)                                             |

## License

Internal project — no license granted.
