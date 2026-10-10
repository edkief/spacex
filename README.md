# Drift

Drift is a browser-based 3D multiplayer space sim. You own a persistent ship,
claim a callsign, and explore a shared galaxy that every client generates
identically from a single seed — no install, no account, just a URL. The
headline is a **seamless transition from deep space down to a planet surface
with no loading screens**, and the ability to **step out of your ship** and
walk the ground on foot. One server process hosts every system in-process;
the world is server-authoritative and only mutable state is ever stored —
all geometry is derived from the seed.

The loop is deliberately small: warp to a planet, drop through the atmosphere,
land on a pad, exit the ship, mine a resource node into your pack, haul it
home in the ship's hold, and sell it at a dock for credits. Rogue AI ships
patrol every system, and combat uses one pipeline for players and AI alike —
shields absorb first, then hull. It is a v1: no crafting, no trading market,
no voice. See [ops.md](app/docs/ops.md#known-gaps-v1-scope-lines) for the
explicit scope lines.

## Features

- **Deterministic galaxy.** Same `GALAXY_SEED` → identical stars, systems,
  terrain, and node placement on every client (verified by snapshot + two-client
  e2e tests).
- **Seamless regimes.** Space → orbit → atmosphere → surface → on-foot, with a
  streamed terrain pipeline, LOD/impostor rings, and a continuous camera
  handoff. Zero loading screens after first load.
- **On-foot mode.** Exit and re-enter your ship, walk, mine, and drop cargo;
  your character syncs to other players in the system.
- **Persistent multiplayer.** Server-authoritative 20 Hz sim, 10 Hz snapshots,
  client prediction + reconciliation, reconnect/resync, 16-player per-system cap.
- **Economy.** Mine → inventory → ship hold → dock sale, with credits, ship
  purchases, and dock repair.
- **Combat.** Laser + guided missiles, server-side targeting, one damage
  pipeline for PvP and PvE, rogue AI that patrols/aggros/engages.
- **Survivability.** Hull 0 → ship lost, immediate dock respawn in a starter
  ship, static wreck left behind; surface hazards (storms, rad zones) on foot.
- **Accessibility.** Keyboard + touch play, WCAG-AA contrast, scalable text,
  screen-reader live region, reduced-motion setting.

## Quick start

Prerequisites: **Node.js 22+** and npm. No external service is required for a
local run (SQLite is a file).

```bash
# 1. Clone the repo and open the app directory
git clone <repo-url> drift && cd drift/app
npm install

# 2. (Optional) Provide an environment file at <repo-root>/.env.local.
#    It is git-ignored and not in the clone, but you do NOT need one: the server
#    runs on built-in defaults (SQLite at ./data/drift.db, the safe default
#    GALAXY_SEED, an insecure dev SESSION_SECRET). Create one to override, e.g.
#    a real SESSION_SECRET for anything beyond local play:
#      PORT=3000
#      SESSION_SECRET=<any 64+ char random string>   # never commit a real value
#      GALAXY_SEED=DRIFT-SEED-0001
#      DB_DRIVER=sqlite
#      DB_PATH=./data/drift.db
#      DATABASE_URL=TODO_FILL_MANUALLY   # only used when DB_DRIVER=postgres
#      SYSTEM_INSTANCE_COUNT=3
#      WS_PATH=/ws
#    See the full list with defaults in app/docs/ops.md#environment-variables.

# 3. Run the dev server (Vite on :3000 proxying /api + /ws to the Node server on :3001)
npm run dev
```

Open **http://localhost:3000**. You land on the **claims screen**: type a
callsign (3–16 letters, digits, or dashes), wait for the live "available"
check, and click **Claim**. That creates your player, docks a starter ship in
your home system, and drops you straight into the game with a first-launch
guidance overlay. Your session token is stored locally, so a reload takes you
back in.

To verify the stack from a clean clone (what CI-style checks do):

```bash
cd app
npm test          # unit + integration (vitest)
npm run typecheck # tsc --noEmit
npm run test:e2e  # Playwright, headless chromium (boots its own isolated server)
```

> `npm run dev:test` boots an isolated server + Vite on random free ports with a
> throwaway DB — the harness the e2e suite drives.

## Controls

| Input       | Space / Atmosphere            | On foot                                          |
| ----------- | ----------------------------- | ------------------------------------------------ |
| `W` / `S`   | Thrust forward / back         | Move forward / back                              |
| `A` / `D`   | Yaw                           | Strafe left / right                              |
| `R` / `F`   | Pitch                         | —                                                |
| `Q` / `E`   | Roll                          | — / interact                                     |
| `Space`     | VTOL lift (atmosphere)        | Jump                                             |
| `Shift`     | —                             | Run                                              |
| `E`         | —                             | Interact (take ore / enter ship / dock terminal) |
| `Q`         | —                             | Drop one unit of held resource                   |
| `T`         | Lock / release target         | —                                                |
| `1` / `2`   | Select laser / missile        | —                                                |
| Mouse click | Fire (canvas)                 | —                                                |
| `M`         | Star chart (warp)             | Star chart                                       |
| `Esc`       | Open menu / close top surface | Open menu / close top surface                    |

Controls remap automatically as the flight regime changes (the server is
authoritative about which regime you are in).

**Touch controls.** On a touch device the same play is driven by a virtual
control overlay: in the ship, dual sticks (left = thrust + yaw, right =
pitch + roll) plus the per-regime buttons — VTOL in the atmosphere, BOOST in
space, and the FIRE / LASER / MISSILE / TARGET combat cluster; on foot, a move
stick plus RUN / JUMP / DROP / INTERACT. A MENU button opens the chart (warp),
ships, chat, and settings. **Settings → Touch controls** has an Auto / On /
Off toggle — Auto enables the overlay when the device reports touch points.

## Tech stack

- **Client:** Vite + React (DOM UI/HUD) + TypeScript; three.js owns the canvas.
- **Server:** Node.js + Fastify (REST) + ws (WebSocket) + TypeScript.
- **Sim:** fixed 20 Hz server tick, 10 Hz snapshots, one shared physics module
  used by both the sim and client prediction.
- **Data:** Drizzle ORM over better-sqlite3 (local) or Postgres (prod) from one schema.
- **Validation:** zod (every WS message + REST body).
- **Tests:** Vitest (unit/integration) + Playwright (e2e, headless).
- **Env:** `dotenv` loads `PROJECT_ROOT/.env.local`.

## Documentation

- [Architecture](app/docs/architecture.md) — system diagram, determinism model,
  the seamless-transition design, combat pipeline, and the single-instance
  scaling seam.
- [Protocol](app/docs/protocol.md) — the complete WebSocket protocol (every
  message type, both directions) + the REST API, written from the zod schemas.
- [Operations](app/docs/ops.md) — every env variable, the SQLite → Postgres
  switch, backups, restart, and the known v1 gaps.
- [Contributing](app/docs/contributing.md) — the Ralph task workflow, test
  gates, the perf contract, and the code-quality bar.
- [Performance](app/docs/performance.md) — the reference-hardware report
  (TASK-61): the numbers and the SC-3/SC-4 verdicts.
