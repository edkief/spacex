# Drift — architecture

This document describes how the shipped system is put together: the process and
module layout, the determinism model that makes a seeded galaxy shareable, the
seamless-transition design, the single combat path, and the seam that a future
multi-instance deployment would cut along.

Every section links the source files that own the behaviour, so this document
can be checked against the code rather than trusted.

---

## 1. System diagram

```
                    ┌───────────────────────────────────────────────┐
                    │  Browser client (app/src/client)             │
                    │                                               │
                    │  three.js scene  ──  world/ (chunks, hazards) │
                    │        │                    ▲                 │
                    │        ▼                    │ streams        │
                    │  camera/ (CameraRig, handoffPath)             │
                    │        ▲                                      │
                    │  DOM/CSS HUD  ──  ui/ + components/          │
                    │                                               │
                    │  net/wsClient.ts  ◄──►  net/prediction.ts   │
                    └───────▲──────────────────────▲───────────────┘
              JSON frames (v1)│                      │ input frames (seq-stamped)
                    ┌────────┴──────────────────────┴───────────────┐
                    │  Fastify 5 + ws (app/src/server)             │
                    │                                               │
                    │  routes/  REST: callsigns, session, players,  │
                    │            ships, repair, sell, settings,     │
                    │            galaxy (overview + health)        │
                    │                                               │
                    │  ws.dispatch → ws.handlers (handshake + verbs)│
                    │            │                                  │
                    │  galaxy/router.ts ─ GalaxyRouter              │
                    │     ├── join-resolver / warp-resolver         │
                    │     ├── router-lifecycle (load / reap)        │
                    │     └── per-system Shard (src/server/shard)   │
                    │            sim.ts 20 Hz tick                   │
                    │            combat, weapons, mining, hazards,  │
                    │            cargo, sell, targeting, destroy     │
                    └───────────────┬───────────────────────────────┘
                                    │ Drizzle repository
                    ┌───────────────┴───────────────────────────────┐
                    │  SQLite (better-sqlite3, default)             │
                    │  or Postgres (pg) when DB_DRIVER=postgres     │
                    │  mutable state only — never geometry          │
                    └───────────────────────────────────────────────┘
```

Entry points:

| Concern          | File                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| Server CLI       | [`app/src/server/index.ts`](../app/src/server/index.ts)                                          |
| Boot / shutdown  | [`app/src/server/runtime.ts`](../app/src/server/runtime.ts)                                      |
| HTTP app         | [`app/src/server/server.ts`](../app/src/server/server.ts)                                        |
| WS attachment    | [`app/src/server/ws.ts`](../app/src/server/ws.ts)                                                |
| Frame dispatch   | [`app/src/server/ws.dispatch.ts`](../app/src/server/ws.dispatch.ts)                              |
| Config           | [`app/src/server/config.ts`](../app/src/server/config.ts)                                        |
| Client bootstrap | [`app/src/client/main.tsx`](../app/src/client/main.tsx) → [`App.tsx`](../app/src/client/App.tsx) |
| Client transport | [`app/src/client/net/wsClient.ts`](../app/src/client/net/wsClient.ts)                            |

In development Vite serves the client on `PORT` (3000) and proxies `/api` and
`/ws` to the Fastify process on `API_PORT` (3001) — see
[`app/vite.config.ts`](../app/vite.config.ts). In production a single process
serves both, with `STATIC_DIR` pointing at the built client
([`app/src/server/static.ts`](../app/src/server/static.ts)).

---

## 2. Determinism: the seed is the world

The whole galaxy is a **pure function of `GALAXY_SEED`**:

```
seed ──► stars ──► systems ──► planets ──► surface chunks ──► entities
```

- Primitives: [`app/src/shared/random.ts`](../app/src/shared/random.ts)
  (seeded PRNG + hash; no `Math.random` on any generation path) and
  [`app/src/shared/galaxy/canonical.ts`](../app/src/shared/galaxy/canonical.ts)
  (canonical JSON + star-list checksum).
- Stars → [`shared/galaxy/stars.ts`](../app/src/shared/galaxy/stars.ts),
  systems → [`system.ts`](../app/src/shared/galaxy/system.ts), planets →
  [`planet.ts`](../app/src/shared/galaxy/planet.ts), terrain →
  [`surface.ts`](../app/src/shared/galaxy/surface.ts) with the value-noise /
  fBm stack in [`surface-noise.ts`](../app/src/shared/galaxy/surface-noise.ts).
- System-level content: AI rosters
  ([`galaxy/ai-hydrate.ts`](../app/src/server/galaxy/ai-hydrate.ts)), resource
  deposits ([`shared/world/deposits.ts`](../app/src/shared/world/deposits.ts) +
  [`galaxy/deposit-hydrate.ts`](../app/src/server/galaxy/deposit-hydrate.ts))
  and hazard cells ([`shared/world/hazards.ts`](../app/src/shared/world/hazards.ts)
  - [`galaxy/hazard-hydrate.ts`](../app/src/server/galaxy/hazard-hydrate.ts)).
- Landing pads: [`shared/world/pads.ts`](../app/src/shared/world/pads.ts)
  (derivation + entry/exit hysteresis).

**Only mutable state is persisted** (PRD §8). The database holds `players`,
`ships`, `cargo_items`, `sessions`, `deposits`, `resource_node_state` and
`system_registry` — never a star, planet or terrain sample. That is why
restarting the server, or joining from another machine, cannot change what the
universe looks like.

Determinism is enforced, not hoped for:

- Snapshot suites pin full galaxy / system / surface outputs
  ([`shared/galaxy/snapshots.test.ts`](../app/src/shared/galaxy/snapshots.test.ts)),
  and mutation tests prove the snapshots would catch a regression.
- Parity suites run the same fixtures under `happy-dom` and node
  (`*.parity.test.ts`) so browser and server cannot drift.
- Property tests sweep 10 seeds × 10 stars plus 200 random (planet, chunk)
  pairs ([`properties.test.ts`](../app/src/shared/galaxy/properties.test.ts)).

---

## 3. Seamless transitions

The product promise is _space → atmosphere → surface with no loading screen_.
Three mechanisms deliver it.

**a. Regimes.** Every position resolves to exactly one regime through the pure
resolver [`shared/regime.ts`](../app/src/shared/regime.ts):
`space → atmosphere → surface`, with an explicit hysteresis factor and a
surface-proximity band so a hovering ship cannot flap between regimes. The
client and the server run the same resolver
([`shared/regime-planets.ts`](../app/src/shared/regime-planets.ts) supplies the
per-planet context). Transitions are asserted in
[`shard/sim.regime-transitions.test.ts`](../app/src/server/shard/sim.regime-transitions.test.ts).

**b. Streaming.** Terrain is generated client-side per chunk, never shipped:

- [`client/world/chunks.ts`](../app/src/client/world/chunks.ts) — LOD rings and
  the active-chunk set (`computeActiveSet`, `lodFor`).
- [`client/world/pipeline.ts`](../app/src/client/world/pipeline.ts) — the
  generation queue, so chunk work is amortised across frames instead of
  blocking one.
- [`client/world/settingsBridge.ts`](../app/src/client/world/settingsBridge.ts) —
  a live ref the pipeline reads per chunk, so a quality preset re-tunes the
  world without a reload.
- [`shared/perf.ts`](../app/src/shared/perf.ts) + [`client/render/drawPlan.ts`](../app/src/client/render/drawPlan.ts) —
  the draw-call/triangle budgets per preset.

**c. Prediction, reconciliation, camera handoff.** The client runs the _same_
physics module as the server and reconciles on snapshot:

- [`client/net/prediction.ts`](../app/src/client/net/prediction.ts) — local
  input applied immediately, corrected when `entity_update` disagrees, with
  smoothing so corrections never visibly snap.
- [`shared/physics/`](../app/src/shared/physics) — the shared flight model used
  by [`shard/sim.ts`](../app/src/server/shard/sim.ts) and the client.
- [`client/camera/CameraRig.ts`](../app/src/client/camera/CameraRig.ts) +
  [`handoffPath.ts`](../app/src/client/camera/handoffPath.ts) — the camera
  blends across regimes instead of cutting; `handoffPath` builds the path the
  rig follows when a ship becomes a character or vice-versa.
- [`client/world/frameScheduler.ts`](../app/src/client/world/frameScheduler.ts)
  — the frame budget the streaming work must fit into.

The cost of a transition is a **gate, not a hope**: the scripted-cycle
benchmark ([`client/test/transitionCycle.ts`](../app/src/client/test/transitionCycle.ts),
`npm run bench:transitions`) measures per-frame transition cost against a 4 ms
budget and fails the run on a miss. See
[performance.md](performance.md) for the recorded numbers.

---

## 4. Combat: one path for PvP and PvE

There is a single authoritative damage pipeline — a shot against another player
and a shot against an AI drone take exactly the same route:

```
fire (client) ─► ws.dispatch ─► shard/weapons.ts
      └─► input.thrust/fire ─► shard/sim.ts (20 Hz)
              └─► combat.resolve.ts resolveHit()
                    ├─ validate: target alive · in range · terrain LOS
                    ├─ applyCombatDamage()  (shield → hull, combat.ts)
                    ├─ entity destroy → destruction.ts (wreck, cargo loss,
                    │  respawn on the nearest pad)
                    └─ broadcast combat_event {hit, damaged, destroyed, kill}
                         └─► client fx/ + CombatHUD + kill feed
```

- Hit resolution and line of sight: [`shard/combat.resolve.ts`](../app/src/server/shard/combat.resolve.ts).
- Damage maths (shields absorb before hull): [`shard/combat.ts`](../app/src/server/shard/combat.ts).
- Destruction transaction (cargo loss, wreck, respawn):
  [`shard/destruction.ts`](../app/src/server/shard/destruction.ts).
- Targeting state (lock range/cone, auto-release, missile preference):
  [`shard/targeting.ts`](../app/src/server/shard/targeting.ts) and
  [`shared/targeting.ts`](../app/src/shared/targeting.ts).
- PvE comes from the same calls: drone aggro lives in
  [`shard/hazards.ts`](../app/src/server/shard/hazards.ts), drones are ordinary
  entities with a `drone` kind, and AI ships are ordinary `ai-ship` entities
  ([`shared/ai/`](../app/src/shared/ai)). Parity between the two is asserted in
  [`shard/pvp-parity.test.ts`](../app/src/server/shard/pvp-parity.test.ts).

---

## 5. One instance, many shards — and the scaling seam

A single Fastify process hosts every loaded star system as an **in-process
shard**:

- [`galaxy/router.ts`](../app/src/server/galaxy/router.ts) — `GalaxyRouter`:
  `joinSystem`, `leaveSystem`, `warp`, `stats`, `shutdown`.
- [`galaxy/router-lifecycle.ts`](../app/src/server/galaxy/router-lifecycle.ts) —
  spawn on first join, idle reap after `SYSTEM_INSTANCE_COUNT` (default 3)
  concurrent systems.
- [`galaxy/router-connection.ts`](../app/src/server/galaxy/router-connection.ts) —
  connection registration plus the 16-real-player cap (AI ghosts are counted
  separately).
- [`galaxy/router-load.ts`](../app/src/server/galaxy/router-load.ts) /
  [`router-reap.ts`](../app/src/server/galaxy/router-reap.ts) — hydration on
  load, flush on reap.
- [`galaxy/warp-resolver.ts`](../app/src/server/galaxy/warp-resolver.ts) —
  moves a connection from one shard to another and emits `warp_arrived`.

A shard owns its own `SimLoop` at a fixed 20 Hz
([`shard/sim.ts`](../app/src/server/shard/sim.ts)), broadcasts entity snapshots
at 10 Hz, and flushes mutable state to the repository at defined save points
([`shard/persist.ts`](../app/src/server/shard/persist.ts) +
[`ShardFlushService`](../app/src/server/shard/persist.ts)).

**Why in-process shards (v1):** the PRD makes horizontal scale-out a non-goal
for day one. An in-process shard is synchronous, allocation-free to hand
between systems, and needs no network hop for a warp — the transition stays
inside one event loop, which is what keeps the warp seam free of a loading
screen.

**The scaling seam:** everything above the shard talks to the router through
the `GalaxyRouter` public API declared in
[`galaxy/router-types.ts`](../app/src/server/galaxy/router-types.ts)
(`RouterConnectionContext`, `JoinResult`, `LeaveArgs`, `WarpOutcome`, …), and
the WS layer only ever sees `ConnSender` frames. A future deployment can put a
remote router in front of N shard processes by reimplementing that API — the
call sites that must change are
[`galaxy/ws-router-bridge.ts`](../app/src/server/galaxy/ws-router-bridge.ts)
and the four `galaxy/router-*.ts` lifecycle modules. Nothing inside
`src/server/shard/` knows whether its neighbours are in the same process.

---

## 6. Persistence

- Repository interface: [`server/db/repo.ts`](../app/src/server/db/repo.ts);
  SQLite implementation [`repo.sqlite.ts`](../app/src/server/db/repo.sqlite.ts)
  (+ `repo.sqlite.world.ts`, `repo.sqlite.identity.ts`), Postgres twin
  [`repo.pg.ts`](../app/src/server/db/repo.pg.ts) — same interface, so the rest
  of the server is driver-agnostic.
- Schemas: [`db/schema.sqlite.ts`](../app/src/server/db/schema.sqlite.ts) and
  [`db/schema.pg.ts`](../app/src/server/db/schema.pg.ts); migrations in
  [`db/migrations/`](../app/src/server/db/migrations).
- The client is a prediction layer only; every durable mutation goes through the
  shard handler first and is persisted from there.

---

## 7. Where to read next

| Question                             | Go to                              |
| ------------------------------------ | ---------------------------------- |
| "What exactly does this frame mean?" | [protocol.md](protocol.md)         |
| "How do I run/operate this?"         | [ops.md](ops.md)                   |
| "How do I change it safely?"         | [contributing.md](contributing.md) |
| "Is it fast enough?"                 | [performance.md](performance.md)   |
