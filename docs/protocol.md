# Drift — protocol reference

Everything on the wire, both directions, plus the REST surface.

The authoritative source is the code, not this file: the message registry lives
in [`app/src/shared/protocol/schemas.ts`](../app/src/shared/protocol/schemas.ts)
(`PAYLOAD_SCHEMAS`) and the envelope in
[`app/src/shared/protocol/index.ts`](../app/src/shared/protocol/index.ts).
Both peers import the same module, so a schema change is a compile error on the
other side. **If you add or change a schema, update this document in the same
PR** (see [contributing.md](contributing.md#protocol-changes)).

---

## 1. Envelope

Every WebSocket frame — in both directions — is a JSON object:

```json
{ "v": 1, "type": "entity_update", "payload": { "...": "..." } }
```

| Field     | Type   | Rule                                                               |
| --------- | ------ | ------------------------------------------------------------------ |
| `v`       | number | Protocol version. Must equal `PROTOCOL_VERSION` (**1**).           |
| `type`    | string | One of the 46 keys in `PAYLOAD_SCHEMAS`. Unknown → `unknown-type`. |
| `payload` | any    | Validated by the per-type zod schema. Unknown keys are rejected.   |

Decoding rules:

- Envelope parse failure → error frame + (after 8 in a window) close `1008`.
- `v` mismatch → error frame `version-mismatch` + close `1002`.
- Unknown `type` → error frame `unknown-type` (counted toward the same
  invalid-message budget).
- Payload validation failure → error frame `invalid-message`.
- Oversize / non-JSON / deeply nested frames are rejected by the frame
  validator before dispatch (asserted in `tests/abuse/cheats.test.ts`).

**Connect sequence**

```
client                                   server
  │ ── hello {version, client, serverTickHz} ──►  │
  │                                            │ version check
  │ ◄── auth_ok {playerId, callsign, tokenExpiresAt} ──┘   (after auth)
  │ ── auth {token}   (or {callsign} to claim) ──►
  │ ── join_system {systemId} ─────────────────►
  │ ◄── enter_system {systemId, entities, nodes, chat, players, …} ──┘
  │ ── input {seq, thrust, turn, …} (seq-stamped) ──►
  │ ◄── entity_update {systemId, tick, entities, lastAppliedSeq} @10 Hz
  │ ◄─ ping / pong ─────────────────────────────────────────────
```

Source: [`server/ws.ts`](../app/src/server/ws.ts) (state machine),
[`server/ws.dispatch.ts`](../app/src/server/ws.dispatch.ts) (validation +
dispatch), [`server/ws.handlers.ts`](../app/src/server/ws.handlers.ts)
(handlers), [`client/net/wsClient.ts`](../app/src/client/net/wsClient.ts)
(client).

---

## 2. Client → server messages

| Type             | Payload fields                                                    | Notes                                                                                                                                                                             |
| ---------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hello`          | `version`, `client`, `serverTickHz`                               | First frame; version gate.                                                                                                                                                        |
| `auth`           | `{ callsign }` or `{ token }`                                     | Claim a callsign or resume a session. `auth` is a discriminated union — the WS schema is empty-looking because it is `z.union`.                                                   |
| `join_system`    | `systemId`                                                        | Requires an authenticated connection; enforces the 16-player cap (`system-full`).                                                                                                 |
| `input`          | `seq`, `thrust`, `turn`, `pitch`, `yaw`, `fire`, `lock`, `action` | Continuous. The server integrates the _latest_ input per connection per tick; `seq` is monotonic per connection and drives reconciliation against `entity_update.lastAppliedSeq`. |
| `fire`           | `weapon`, `targetId`                                              | `laser` or `missile`; denial codes come back on `fire_ok`.                                                                                                                        |
| `select_weapon`  | `weapon`                                                          |                                                                                                                                                                                   |
| `warp`           | `targetSystemId`                                                  | Moves the connection to the target shard; answered with `warp_arrived`.                                                                                                           |
| `interact`       | `targetId`, `action`                                              | Ship-registry verb: `enter`, `open-cargo`, …                                                                                                                                      |
| `pickup`         | `targetId`                                                        | Ground item → backpack.                                                                                                                                                           |
| `drop`           | `resourceType`, `amount`                                          | Backpack → ground.                                                                                                                                                                |
| `mine`           | `nodeId`, `duration`                                              | Starts the server-timed mining channel.                                                                                                                                           |
| `mine_stop`      | _(empty)_                                                         | Cancels the channel.                                                                                                                                                              |
| `sell`           | `resourceType`, `quantity`, `source`                              | `source` is `inv` (backpack) or `hold` (cargo).                                                                                                                                   |
| `cargo_transfer` | `resourceId`, `amount`, `from`                                    | Moves cargo between hold and backpack.                                                                                                                                            |
| `buy_ship`       | `classId`                                                         | Docked only.                                                                                                                                                                      |
| `set_livery`     | `primary`, `secondary`, `accent`                                  | Persisted, visible to every client.                                                                                                                                               |
| `exit_ship`      | _(empty)_                                                         | Disembark; the server mints the character entity.                                                                                                                                 |
| `enter_ship`     | _(empty)_                                                         | Board (server range-gated at 5 m and near-zero velocity).                                                                                                                         |
| `repair`         | `shipId`                                                          | Docked only.                                                                                                                                                                      |
| `logout`         | _(empty)_                                                         | Revokes the session; server closes `1000`.                                                                                                                                        |
| `target_lock`    | `targetId`                                                        | `null` = pick the nearest in-cone candidate; a duplicate `target_lock` on the already-locked target **releases** it (there is no separate `target_release` frame).                |
| `ping`           | `t`                                                               | Keepalive; answered with `pong {t}`.                                                                                                                                              |

Handlers: [`server/ws.dispatch.ts`](../app/src/server/ws.dispatch.ts) (state +
validation), [`server/shard/`](../app/src/server/shard) (the verbs themselves).

## 3. Server → client messages

| Type               | Payload fields                                                                                       | Notes                                                                                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth_ok`          | `playerId`, `callsign`, `tokenExpiresAt`                                                             | Connection moves to `joined`.                                                                                                               |
| `enter_system`     | `systemId`, `entities`, `nodes`, `chat`, `players`, `serverTickHz`, `snapshotTick`                   | Full first snapshot for a freshly joined shard.                                                                                             |
| `warp_arrived`     | `targetSystemId`, `systemId`, `entities`, `nodes`, `chat`, `players`, `serverTickHz`, `snapshotTick` | Same shape as `enter_system`; replaces it after a warp.                                                                                     |
| `state_snapshot`   | `systemId`, `tick`, `entities`, `nodes`, `chat`, `players`                                           | Full resync (used on reconnect).                                                                                                            |
| `entity_update`    | `systemId`, `tick`, `entities`, `lastAppliedSeq`                                                     | 10 Hz delta/snapshot broadcast.                                                                                                             |
| `presence`         | `systemId`, `players`                                                                                | Join/leave list for the star chart + player list.                                                                                           |
| `chat`             | `text`                                                                                               | System channel; last 100 messages restored in the snapshot.                                                                                 |
| `weapon_state`     | `activeWeapon`, `energy`, `locked`, `lockedUntilMs`                                                  | Weapon cooldown + energy.                                                                                                                   |
| `fire_ok`          | `weapon`, `kind`, `damage`, `projectileId`, `energy`, `denialCode`                                   | `denialCode` carries `low-energy`, `weapon-locked`, `weapon-not-equipped`, `no-target`, `invalid-target`.                                   |
| `target_update`    | `targetId`, `shields`, `hull`, `bearing`, `range`, `callsign`, `classId`                             | Drives the target box.                                                                                                                      |
| `target_locked`    | `targetId`, `callsign`, `range`, `bearing`, `lockedAt`                                               | Ack for a successful lock (also pushes the lock icon to everyone else).                                                                     |
| `target_released`  | `targetId`, `reason`                                                                                 | Auto-release (out of range, destroyed, 30 s) or manual.                                                                                     |
| `combat_event`     | _(union by `kind`)_                                                                                  | `hit` → `damaged` → `destroyed` → optional `kill`; `destroyed` may carry `respawn {wreckId, padId, planetId, callsign, killer, cargoLost}`. |
| `inventory_update` | `stacks`, `weightUsed`, `capacity`, `action`, `taken`, `remaining`                                   | `action` ∈ `pickup`, `drop`, `mine-progress`, `mine-paused-full`, `cap-reached`, `reset`.                                                   |
| `cargo_update`     | `cargo`, `inventory`, `direction`, `resourceId`, `transferred`, `remaining`, `action`                | Backpack ↔ hold moves.                                                                                                                      |
| `mining_update`    | `depositId`, `resourceId`, `progressMs`, `unitsSoFar`, `amount`, `state`                             | Drives the radial progress ring.                                                                                                            |
| `hazard_update`    | `exposure`, `recoveringUntilMs`, `inHazard`, `recentDamage`, `currentHazard`, `cells`, `anchor`      | Exposure meter + hazard scope.                                                                                                              |
| `sell_ok`          | `resourceType`, `quantity`, `sold`, `earned`, `newBalance`, `source`                                 |                                                                                                                                             |
| `enter_ship_ok`    | `shipId`                                                                                             |                                                                                                                                             |
| `interact_ok`      | `targetId`, `action`                                                                                 |                                                                                                                                             |
| `ui_open`          | `ui`, `payload`                                                                                      | Server-directed panel open (`dock`, `cargo`, `menu`, …).                                                                                    |
| `logout_ok`        | `callsign`                                                                                           |                                                                                                                                             |
| `pong`             | `t`                                                                                                  | Echo of `ping`.                                                                                                                             |
| `error`            | `code`, `message`                                                                                    | Structured failure — see the error-code table below.                                                                                        |

## 4. Entity kinds

`entity.kind` ∈ `ship`, `character`, `ai-ship`, `wreck`, `deposit`, `terminal`,
`groundItem`, `missile`, `drone` (`EntityKindSchema`).

## 5. Error codes

`error.code` is one of the 21 values in `ErrorCodeSchema`:

| Code                  | Meaning                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------- |
| `version-mismatch`    | Envelope `v` differs from `PROTOCOL_VERSION`. Socket is closed `1002`.                       |
| `unauthenticated`     | Missing/invalid/expired session token, or callsign already claimed. Socket is closed `1008`. |
| `system-full`         | The target shard already holds 16 real players.                                              |
| `system-not-found`    | Unknown `systemId`.                                                                          |
| `rate-limited`        | Token bucket exhausted (general bucket or per-verb).                                         |
| `invalid-message`     | Payload failed zod validation / frame limits.                                                |
| `unknown-type`        | `type` is not a registered message type.                                                     |
| `not-docked`          | Action requires being on a landing pad.                                                      |
| `out-of-range`        | Target beyond the verb's range (mine, interact, …).                                          |
| `wrong-regime`        | Verb is invalid in the current regime (e.g. mining in space).                                |
| `not-found`           | Referenced entity/row does not exist.                                                        |
| `not-owner`           | The ship belongs to another player.                                                          |
| `ship-moving`         | Boarding refused — the ship is not stationary.                                               |
| `already-in-ship`     | `enter_ship` while already aboard.                                                           |
| `not-at-station`      | Selling outside a station's terminal range.                                                  |
| `insufficient`        | Not enough of the resource / capacity.                                                       |
| `low-energy`          | Weapon fire with insufficient energy.                                                        |
| `weapon-locked`       | Weapon is still in cooldown.                                                                 |
| `weapon-not-equipped` | The active weapon is not in the loadout.                                                     |
| `no-target`           | Missile fired with nothing in the pick cone.                                                 |
| `invalid-target`      | Target failed the lock validator (range, cone, kind).                                        |

## 6. Close codes

| Code   | Reason string               | Raised when                                                                                                                                                                                                        |
| ------ | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `1000` | `logged-out`                | The client sent `logout` and the session was revoked.                                                                                                                                                              |
| `1002` | `version-mismatch`          | Protocol version mismatch — refused rather than guessed at.                                                                                                                                                        |
| `1008` | `unauthenticated`           | `auth` failed (bad/expired token, callsign taken).                                                                                                                                                                 |
| `1008` | `logout-failed`             | Session revocation failed mid-handshake.                                                                                                                                                                           |
| `1008` | `too-many-invalid-messages` | 8 invalid frames in one window — the connection is presumed hostile.                                                                                                                                               |
| `4009` | `flooded`                   | Chat/general flood limit exceeded (`FLOOD_CLOSE_CODE` in [`server/ratelimit.ts`](../app/src/server/ratelimit.ts)).                                                                                                 |
| `4001` | —                           | **Never sent by the server.** The PRD's load criteria reserve it as the "spurious kick" code; the load harness treats a `4001` close as a failed gate ([`app/tests/load/client.ts`](../app/tests/load/client.ts)). |

## 7. Rate limits

| Bucket                           | Limit                                                           | Source                                                                      |
| -------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------- |
| General messages                 | 20/s, burst 40, per connection                                  | `GENERAL_BUCKET` in [`server/ratelimit.ts`](../app/src/server/ratelimit.ts) |
| Chat                             | stricter per-connection bucket, enforced before the general one | `src/server/chat.ts`                                                        |
| Fire / mine / sell / warp / join | per-verb buckets on top of the general one                      | `src/server/ws.ratelimit.ts`                                                |
| Flood                            | exceeding the chat bucket → close `4009`                        | `FLOOD_CLOSE_CODE`                                                          |

The coverage of every stateful handler by a rate limiter is asserted by
`tests/abuse/audit.test.ts`.

---

## 8. REST API

Base URL in development: `http://localhost:3001` (proxied through Vite on
`http://localhost:3000/api/…`).

All authenticated endpoints take `Authorization: Bearer <token>` where the
token is the one returned by `POST /api/callsigns`. Errors are
`{ "error": { "code": "<kebab-code>", "message": "<human text>" } }`.

| Method | Path                          | Auth | Body / query                                              | Success                                                                                                                   | Errors                                                                                                                                                  |
| ------ | ----------------------------- | ---- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/api/health`                 | no   | —                                                         | `200 {ok, galaxySeed}`                                                                                                    | —                                                                                                                                                       |
| `GET`  | `/api/callsigns/availability` | no   | `?callsign=`                                              | `200 {callsign, normalized, available, reason}` where reason ∈ `available \| taken \| invalid-format`                     | always `200` by design (a dumb probe)                                                                                                                   |
| `POST` | `/api/callsigns`              | no   | `{callsign}`                                              | `200 {callsign, token, playerId, homeSystemId, shipId, tokenExpiresAt}`                                                   | `409 callsign-taken`, `422 invalid-callsign`                                                                                                            |
| `GET`  | `/api/session`                | yes  | —                                                         | `200 {playerId, callsign, credits, homeSystemId, shipId, tokenExpiresAt, lastSystemId, settings}`                         | `401 unauthenticated`                                                                                                                                   |
| `POST` | `/api/session/logout`         | yes  | —                                                         | `200 {revoked, callsign}`                                                                                                 | `401 unauthenticated`                                                                                                                                   |
| `GET`  | `/api/players/me`             | yes  | —                                                         | `200 {callsign, credits, homeSystemId, shipId}`                                                                           | `401 unauthenticated`                                                                                                                                   |
| `GET`  | `/api/players/settings`       | yes  | —                                                         | `200 {settings}` (`{quality, sensitivity, reducedMotion, deviceProfile}`)                                                 | `401 unauthenticated`                                                                                                                                   |
| `PUT`  | `/api/players/settings`       | yes  | partial settings record (merged)                          | `200 {settings}`                                                                                                          | `400 invalid-settings`, `401 unauthenticated`                                                                                                           |
| `GET`  | `/api/ships`                  | yes  | —                                                         | `200 {ship, class}` (class = full catalog entry + stats)                                                                  | `401 unauthenticated`, `500 no-ship`                                                                                                                    |
| `POST` | `/api/ships/buy`              | yes  | `{classId}`                                               | `200 {ship, class}`                                                                                                       | `400 unknown-class`, `401`, `404 no-ship`, `409 not-docked`, `409 already-owned`, `409 insufficient-credits`                                            |
| `POST` | `/api/ships/livery`           | yes  | `{colors: {primary, secondary, accent}}` (hex `#rrggbb`)  | `200 {ship, class}`                                                                                                       | `400 invalid-payload`, `401`, `404 no-ship`, `422 must-be-docked`                                                                                       |
| `POST` | `/api/ships/repair`           | yes  | `{shipId}`                                                | `200 {ship, class, cost, newBalance}`                                                                                     | `401`, `404 ship-not-found`, `409 not-docked`, `409 insufficient-credits`                                                                               |
| `POST` | `/api/ships/sell`             | yes  | `{resourceId, amount, source}` (`source` ∈ `inv \| hold`) | `200 {sold, earned, newBalance, resourceType, source}`                                                                    | `400 invalid-amount`, `400 invalid-payload`, `400 unknown-resource`, `401`, `404 not-found`, `409 not-at-station`, `409 not-docked`, `422 insufficient` |
| `GET`  | `/api/galaxy/overview`        | yes  | —                                                         | `200 {ok, overview: {galaxySeed, viewBoxWidth, viewBoxHeight, systems: [{systemId, name, starClass, pos2D, neighbors}]}}` | `401 unauthenticated`                                                                                                                                   |
| `GET`  | `/api/galaxy/health`          | yes  | —                                                         | `200 {ok, galaxySeed, shards, shardCount, totalPlayers, routerStartedAt}` (occupancy for the chart)                       | `401 unauthenticated`                                                                                                                                   |

Verified live against a dev server on `http://localhost:3001` (claim → session →
players/me → settings → ships → galaxy/health → galaxy/overview), including the
`401` (no token) and `409` (duplicate claim) paths.

Route sources: [`routes/callsigns.ts`](../app/src/server/routes/callsigns.ts),
[`routes/players.ts`](../app/src/server/routes/players.ts),
[`routes/settings.ts`](../app/src/server/routes/settings.ts),
[`routes/ships.ts`](../app/src/server/routes/ships.ts),
[`routes/repair.ts`](../app/src/server/routes/repair.ts),
[`routes/sell.ts`](../app/src/server/routes/sell.ts),
[`routes/galaxy-overview.ts`](../app/src/server/routes/galaxy-overview.ts),
[`routes/galaxy-health.ts`](../app/src/server/routes/galaxy-health.ts),
[`server.ts`](../app/src/server/server.ts) (`/api/health`).
