# Architecture

Drift is a single Node process that hosts a browser 3D multiplayer space sim.
This page is the map: the system diagram, the determinism model, the seamless
transition design, the combat pipeline, and the single-instance decision with
its scaling seam. Every section links to the owning source files.

## System diagram

```
        Browser (one per player)
 ┌───────────────────────────────────────────────────────────────────┐
 │  React shell (claims screen, HUD, menus)          three.js canvas │
 │        └─ DOM UI ────────────────────┐        └─ WebGL2 world      │
 │                                      │                            │
 │   net/ClientSession (WS) ────────────┼──→  world/WorldManager       │
 │   net/prediction ── reconcile ────────┼──→  world/chunks (stream)  │
 │   camera/CameraRig (handoff) ─────────┘                             │
 └──────────────────────────────────────┬─────────────────────────────┘
                                        │  WebSocket (typed, versioned)
                                        ▼
        Fastify server  (Node, single process)
 ┌───────────────────────────────────────────────────────────────────┐
 │  REST /api/* ── token auth ── callsigns / session / players /     │
 │                  ships / galaxy / dev                             │
 │                                                                   │
 │  ws.ts ── handshake (hello→auth→join) ── keepalive ── rate limits │
 │         │                                                         │
 │         ▼                                                         │
 │  galaxy/router.ts  ── Map<systemId, Shard>, spawn-on-join,        │
 │         │                60 s reap, 16-player cap, flush-on-stop  │
 │         ▼                                                         │
 │  shard/SystemShard ── 20 Hz sim (shard/sim.ts) + 10 Hz snapshot   │
 │         │                   shared physics (src/shared/physics)   │
 │         ▼                                                         │
 │  db/ (Drizzle) ── repo ── migrations ── better-sqlite3 | pg       │
 └───────────────────────────────────────────────────────────────────┘
```

- **Client** — React owns the DOM (claims screen, HUD, menus); three.js owns
  the canvas. [WorldManager](../src/client/world/WorldManager.ts) builds and
  swaps the per-system scene; [chunks.ts](../src/client/world/chunks.ts) streams
  terrain. The [ClientSession](../src/client/net/session.ts) holds the socket and
  the reconnect/resync state machine.
- **Server** — one Fastify process. REST is token-authenticated; the WebSocket
  layer ([ws.ts](../src/server/ws.ts)) runs the handshake and routes gameplay
  frames to a shard. The [galaxy router](../src/server/galaxy/router.ts) owns the
  in-process shard map. [Process entry](../src/server/index.ts) wires it all
  together and handles graceful shutdown.

## Determinism model: seed → world, only state persists

The core invariant is that **no geometry is ever stored**. Stars, systems,
planets, terrain, landing pads, deposit positions, station terminals, hazards,
and the rogue-AI roster are all pure functions of `GALAXY_SEED` (+ the owning
star/system id). Two clients that share the seed reconstruct an identical
galaxy with zero server round-trip for the world data.

- **PRNG + hashing** — a deterministic xoshiro128** PRNG and FNV-1a/splitmix
  hashing, with no `Math.random` in any generation path
  ([random.ts](../src/shared/random.ts)).
- **Stars** — a seeded thin-disk layout ([galaxy/stars.ts](../src/shared/galaxy/stars.ts)).
- **Systems** — planets, docks, deposits, AI roster per star
  ([galaxy/system.ts](../src/shared/galaxy/system.ts)).
- **Terrain** — 2D value noise + fBm on a world-space lattice
  ([galaxy/noise.ts](../src/shared/galaxy/noise.ts)).

Only **mutable state** is persisted to the database: player credits, the ship
(class, hull/shields, position, velocity, livery, cargo), the on-foot
inventory, deposit depletion, and sessions. On shard spawn the DB rehydrates
ships into the freshly regenerated system; on shutdown/flush it writes them
back. The [repository](../src/server/db/repo.ts) is the single read/write
surface, and [schema.ts](../src/server/db/schema.ts) defines one Drizzle schema
that compiles against both the SQLite and Postgres drivers.

Determinism applies to **generation, not to the sim**: the sim is
server-authoritative, not lockstep. (PRD §12.)

## Seamless-transition design

There are no loading screens after first load. Four mechanisms make it work:

**Regimes.** A flight-regime state machine — `space` → `atmosphere` →
`surface` (and reverses), plus a `docked` overlay — is shared verbatim by the
server (authority) and the client (prediction) via
[regime.ts](../src/shared/regime.ts). The server sends the authoritative
`flightRegime` on the self entity every snapshot; the client runs a local
prediction and snaps after 500 ms of divergence
([client regime tracker](../src/client/state/regime.ts)).

**Streaming.** The surface is a chunk grid streamed around the player with
three LOD rings (near/mid/far) and far impostors, a bounded per-frame build
budget, and a far-then-near queue under backlog
([chunks.ts](../src/client/world/chunks.ts),
[chunk-geometry.ts](../src/client/world/chunk-geometry.ts),
[chunk-scene.ts](../src/client/world/chunk-scene.ts)). Distant terrain is a
cheap impostor that upgrades to a full chunk on approach — so dropping from
space to ground never stalls on a load.

**Prediction / reconciliation.** The same physics module drives both the sim
and the client. [ClientShipPredictor](../src/client/net/prediction.ts) integrates
the local ship every frame from the player's input and reconciles against the
server's 10 Hz snapshot (blend / rewind / snap, with a bounded queue); the
`ack` frame carries the last applied input seq so the client knows exactly what
the server integrated. On-foot uses the same machinery in
[CharacterPredictor](../src/client/net/character-prediction.ts). Remote entities
lerp/slerp on a 200 ms buffer
([interpolation.ts](../src/client/net/interpolation.ts)).

**Camera handoff.** One continuous `PerspectiveCamera` across cockpit →
on-foot → back. [CameraRig](../src/client/camera/CameraRig.ts) eases between
poses over a short, terrain-nudged path (no cut, no reset), and the shared
[pose-math](../src/client/camera/pose-math.ts) keeps the handoff clear of
geometry.

## Combat pipeline: one path for PvP and PvE

There is a single damage pipeline — there is no separate "PvP" toggle. A
client sends a fire **intent** (weapon + optional aim target); the server
re-derives everything — loadout, rate, energy, range, line of sight, target
validity — and either resolves the hit or denies it (a denied fire produces no
event and no client FX).

- **Resolution** — [shard/combat.ts](../src/server/shard/combat.ts) runs the
  laser raycast and missile homing; damage is shield-first then hull via the
  pure [applyDamage](../src/shared/physics/damage.ts).
- **Events** — every accepted fire / hit / destruction / player-kill is
  broadcast as a `combat_event`; the HUD and kill feed read only these.
- **Targeting** — shared lock-on math ([targeting.ts](../src/shared/targeting.ts))
  is used by the server's lock validation and the client's T-key selection.
- **AI** — the rogue roster is seed-derived; AI ships patrol → aggro → engage
  through the same `combat_event` pipeline as players
  ([shared/world/ai.ts](../src/shared/world/ai.ts)).

## Single-instance + in-process shards (and the scaling seam)

v1 runs **one** Node process. The [galaxy router](../src/server/galaxy/router.ts)
holds a `Map<systemId, Shard>`: a shard is spawned when the first player joins a
system (system regenerated from the seed, ships rehydrated), reaped 60 s after it
empties (ships flushed first), and capped at 16 players. Concurrent joiners
collapse onto one load (pending-promise dedup), and a periodic + chained flush
keeps the DB current so a hard crash loses at most one flush interval.

The **`GalaxyRouter` interface is the scaling seam**: everything above it (the WS
layer, REST routes, the process entry) speaks only to the interface, not to the
in-process implementation. A future process-level shard manager — multiple app
instances behind sticky routing keyed by system id — would implement the same
`enterSystem` / `leaveSystem` / `warpSystem` contract and replace the in-process
map with a remote dispatch. Nothing else changes. (PRD §11/§12: designed for
horizontal scale-out, not required day 1.)
