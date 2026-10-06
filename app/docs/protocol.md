# Protocol

The complete wire contract: the WebSocket protocol (every message type, both
directions) and the REST API. This page is **written from the zod schemas** in
[schemas.ts](../src/shared/protocol/schemas.ts) — a single source of truth shared
by client and server. **Rule: if you change a schema, update this page in the
same PR** (enforced by the [contributing guide](contributing.md#perf-and-wire-contract)).

## Wire envelope

Every WebSocket frame is a JSON object:

```json
{ "v": 1, "type": "entity_update", "payload": { "entities": [/* … */] } }
```

- `v` — protocol version, currently **1** (`PROTOCOL_VERSION`). A `hello` with a
  different `v` is rejected with a `version-mismatch` error and a `1002` close.
- `type` — the message name (tables below).
- `payload` — schema-checked by [parseMessage](../src/shared/protocol.ts); every
  payload schema is `.strict()`, so unknown fields are rejected, not stripped.

`encodeMessage` / `decodeMessage` / `parseMessage` in
[protocol.ts](../src/shared/protocol.ts) are shared by both sides.

## Connection constants

| constant                         | value                     | meaning                               |
| -------------------------------- | ------------------------- | ------------------------------------- |
| `PROTOCOL_VERSION`               | `1`                       | envelope `v`                          |
| `PING_INTERVAL_MS`               | `15000`                   | server pings every 15 s               |
| `DROP_AFTER_MS`                  | `45000`                   | drop after 45 s of silence            |
| `UNKNOWN_TYPE_DROP_LIMIT`        | `10`                      | terminate after 10 unknown types      |
| `INVALID_MESSAGE_DROP_LIMIT`     | `50`                      | terminate after 50 invalid messages   |
| `MAX_MESSAGE_BYTES`              | `65536`                   | inbound frames over this are rejected |
| `MAX_PLAYERS_PER_SYSTEM`         | `16`                      | per-system occupancy cap              |
| `MESSAGE_RATE` / `MESSAGE_BURST` | `20 / 40`                 | per-connection token bucket           |
| chat limit                       | `200 chars`, `5 per 10 s` | per-connection chat window            |
| chat history                     | `100`                     | messages retained in the snapshot     |

## Handshake

```
client → hello { v: 1 }
client → auth  { token }            // token from POST /api/callsigns
server → (error if auth fails)
client → join_system { systemId }
server → enter_system { snapshot }  // full world state
```

Only an authenticated connection (a valid issued token) may join. System-scoped
messages (`input`, `interact`, `mine`, `sell`, `buy_ship`, `set_livery`,
`exit_ship`, `enter_ship`, `repair`, `chat`, `target_*`) require an active
`systemId`. The WS layer is [ws.ts](../src/server/ws.ts).

## Message types — client → server

| type             | payload                                                  | notes                                                                    |
| ---------------- | -------------------------------------------------------- | ------------------------------------------------------------------------ |
| `hello`          | `{ v: number }`                                          | must equal `PROTOCOL_VERSION`                                            |
| `auth`           | `{ token?: string } \| { callsign?: string }`            | at least one; `token` is the claim token                                 |
| `join_system`    | `{ systemId }`                                           | joins a system (16-cap → `system-full`)                                  |
| `warp`           | `{ destinationSystemId }`                                | inter-system warp; failure leaves you put                                |
| `logout`         | `{}`                                                     | revokes the token, closes `1000`                                         |
| `input`          | `{ seq, thrust, turn, pitch, yaw, fire, lock, action? }` | per-frame control; latest-wins, `seq <= applied` dropped                 |
| `chat`           | `{ text }`                                               | 1..200 chars after trim, sanitized server-side                           |
| `interact`       | `{ targetId, action? }`                                  | on-foot; `action` e.g. `mine-start`/`mine-tick`/`mine-stop`/`open-cargo` |
| `mine`           | `{ nodeId }`                                             | legacy mining start (still honored)                                      |
| `sell`           | `{ resourceId, amount, source: 'hold'\|'inv' }`          | dock sell (WS alias of `POST /api/ships/sell`)                           |
| `buy_ship`       | `{ classId }`                                            | docked purchase (also `POST /api/ships/buy`)                             |
| `set_livery`     | `{ livery }`                                             | 3-slot hex paint (also `POST /api/ships/livery`)                         |
| `drop`           | `{ resourceId, amount }`                                 | on foot → spawns a `groundItem` (300 s ttl)                              |
| `exit_ship`      | `{ shipId }`                                             | disembark (must be docked)                                               |
| `enter_ship`     | `{ shipId }`                                             | re-enter (ownership + range checked)                                     |
| `repair`         | `{}`                                                     | dock repair (also `POST /api/ships/repair`)                              |
| `cargo_transfer` | `{ resourceId, amount, from: 'inv'\|'hold' }`            | move units inv↔hold                                                      |
| `cargo_open`     | `{}`                                                     | open cargo panel → server answers `cargo`                                |
| `fire`           | `{ weapon: 'laser'\|'missile', targetId? }`              | fire **intent**; server re-validates                                     |
| `target_lock`    | `{ targetId }`                                           | request lock (server owns lock state)                                    |
| `target_release` | `{}`                                                     | release lock                                                             |
| `target_update`  | `{ targetId: string \| null }`                           | client target-marker state                                               |
| `ping`           | `{}`                                                     | keepalive (no reply required)                                            |
| `pong`           | `{}`                                                     | keepalive reply                                                          |

## Message types — server → client

| type             | payload                                                  | notes                                                |
| ---------------- | -------------------------------------------------------- | ---------------------------------------------------- |
| `enter_system`   | `{ snapshot }`                                           | full state after a successful join                   |
| `warp_arrived`   | `{ systemId, snapshot }`                                 | warp complete; the client swaps its world            |
| `state_snapshot` | `StateSnapshot`                                          | full world state                                     |
| `entity_update`  | `{ entities: Entity[] }`                                 | 10 Hz snapshot, encode-once for every in-system peer |
| `presence`       | `{ event: 'join'\|'leave', player }`                     | presence change                                      |
| `chat`           | `{ from, text, ts }`                                     | chat broadcast (`ts` server-assigned, monotonic)     |
| `combat_event`   | `{ kind, … }`                                            | combat broadcast (see below)                         |
| `mining`         | `{ phase: 'active'\|'ended', … }`                        | per-player mining channel (10 Hz)                    |
| `cargo`          | `{ hold, inventory? }`                                   | per-player cargo panel contents                      |
| `sell`           | `{ resourceId, sold, earned, balance, hold, inventory }` | sell result                                          |
| `ui-open`        | `{ ui, payload? }`                                       | server wants a panel open (`'dock'` in v1)           |
| `hazard`         | `{ exposure, inside?, recoveringUntil? }`                | per-player hazard frame (on foot)                    |
| `ack`            | `{ seq }`                                                | last applied input seq (reconciliation)              |
| `error`          | `{ code, message }`                                      | structured error                                     |
| `ping`           | `{}`                                                     | keepalive (15 s)                                     |
| `pong`           | `{}`                                                     | keepalive                                            |

`chat`, `sell`, `error`, `ping`, `pong` exist in both directions (the schema is
a union of the inbound and outbound shapes); only the inbound form is ever
dispatched to gameplay.

## Entity (`Entity` / `entityStateSchema`)

One shape for all snapshot traffic. `kind` is one of:
`ship`, `character`, `ai-ship`, `wreck`, `deposit`, `terminal`, `groundItem`,
`projectile`, `drone`.

| field          | type                      | notes                                                                  |
| -------------- | ------------------------- | ---------------------------------------------------------------------- |
| `id`           | string                    | wire id                                                                |
| `kind`         | enum                      | one of the entity kinds above                                          |
| `pos`          | `{ x, y, z }`             | world position                                                         |
| `vel`          | `{ x, y, z }`?            | omitted at rest → `{0,0,0}`                                            |
| `rot`          | `{ x, y, z, w }`?         | unit quaternion (scalar last); omitted when identity                   |
| `regime`       | enum?                     | `sublight`\|`cruise`\|`warp`\|`docked`; omitted for never-docked kinds |
| `flightRegime` | enum?                     | `space`\|`atmosphere`\|`surface`; authoritative, player entities only  |
| `padId`        | string?                   | set (with `regime:'docked'`) when docked on a pad                      |
| `hull`         | number?                   | 0..1; omitted at full → 1                                              |
| `shields`      | number?                   | 0..1; omitted at full → 1                                              |
| `targetId`     | string?\|null?            | omitted when nothing targeted → null                                   |
| `classId`      | string                    | ship class                                                             |
| `callsign`     | string?                   | player/AI callsign (≤24)                                               |
| `livery`       | record?                   | `{ hull, accent, trim }` hex colors                                    |
| `playerId`     | string?                   | `character` only — the owner                                           |
| `onFoot`       | boolean?                  | `character` only                                                       |
| `quantity`     | int?                      | `deposit` only — remaining units                                       |
| `resourceId`   | string?                   | `groundItem` only — the dropped resource                               |
| `killerId`     | string?                   | `wreck` only — the killing source                                      |
| `energy`       | number?                   | 0..100, player ships — the weapon HUD energy bar                       |
| `ai`           | `true`?                   | `ai-ship` only                                                         |
| `targetedBy`   | string[]?                 | player ids currently locking this ship                                 |
| `inventory`    | `{ stacks, weightUsed }`? | player entities; omitted while empty                                   |

**Wire compression (TASK-18):** the "omitted → default" fields are dropped on
the wire and re-applied by consumers through
[normalizeEntityState](../src/shared/protocol/schemas.ts) at the ingest boundary.
The frame stays a **full state** (no delta encoding) — every field is still sent
whenever it deviates from its default.

## `combat_event`

A discriminated union on `kind` (broadcast to the whole shard):

- `hit` — `{ target, source, weapon, damage, shieldHit, hullHit }`
- `destroyed` — `{ target, source, weapon }` (the killing hit; no damage fields)
- `kill` — `{ killer, victim, weapon }` (a PLAYER destroyed a player)
- `laser-fired` — `{ source, weapon, from, to }` (FX: ray endpoints)
- `missile-fired` — `{ source, weapon, projectile, from }` (FX: tracer spawn)
- `missile-impact` — `{ weapon, projectile, point }` (FX: splash)
- `ai-acquiring` — `{ source, target }` (FX: the 'ACQUIRING' grace toast)

`source` is a `damageSourceSchema`: `{ kind: 'player'\|'ai'\|'drone', id }`.

## Error codes (`error.payload.code`)

`version-mismatch`, `unauthenticated`, `system-full`, `system-not-found`,
`rate-limited`, `invalid-message`, `unknown-type`.

## Close codes

| code          | reason             | when                                                                    |
| ------------- | ------------------ | ----------------------------------------------------------------------- |
| `1000`        | `logged-out`       | clean close after `logout` (token already revoked)                      |
| `1002`        | `version-mismatch` | `hello` version differs from the server's                               |
| `1011`        | `internal error`   | a message handler threw                                                 |
| `4009`        | `flooded`          | 3 rate-limit violations within 10 s                                     |
| `terminate()` | (no code)          | 10 unknown types, 50 invalid messages, 45 s silence, or server shutdown |

## REST API

All endpoints take an `Authorization: Bearer <token>` header (the token from
`POST /api/callsigns`). Unauthenticated calls return `401 { code:
'unauthenticated', reason }` where `reason` ∈ `missing bearer token`,
`malformed-token`, `invalid-signature`, `expired-token`, `unknown-session`.

### Public

| method & path                     | body / query   | success                                                   | errors                                               |
| --------------------------------- | -------------- | --------------------------------------------------------- | ---------------------------------------------------- |
| `POST /api/callsigns`             | `{ callsign }` | `201 { callsign, token, playerId, homeSystemId, shipId }` | `400 invalid-callsign`, `409 callsign-taken`         |
| `GET /api/callsigns/availability` | `?callsign=`   | `{ available, reason? }`                                  | `400 invalid-callsign` (missing), `429 rate-limited` |

### Session & player (Bearer)

| method & path               | body             | success                                                                         | errors                        |
| --------------------------- | ---------------- | ------------------------------------------------------------------------------- | ----------------------------- |
| `GET /api/session`          | —                | `{ callsign, credits, playerId, homeSystemId, lastSystemId, shipId, settings }` | `401`                         |
| `POST /api/session/logout`  | —                | `200 { code: 'logged-out' }`                                                    | `401`                         |
| `GET /api/players/me`       | —                | `{ callsign, credits, homeSystemId, shipId }`                                   | `401`                         |
| `GET /api/players/settings` | —                | settings row                                                                    | `401`                         |
| `PUT /api/players/settings` | partial settings | settings row                                                                    | `400 invalid-settings`, `401` |

### Ships (Bearer)

| method & path            | body                                 | success                          | errors                                                                                                                                                                         |
| ------------------------ | ------------------------------------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/ships`         | —                                    | `{ ship, class }`                | `404 no-ship`, `401`                                                                                                                                                           |
| `POST /api/ships/buy`    | `{ classId }`                        | `201 { ship, class, balance }`   | `400 invalid-body`/`unknown-class`, `404 no-ship`, `409 already-owned`/`not-docked`, `422 insufficient-credits`                                                                |
| `POST /api/ships/livery` | `{ colors: { hull, accent, trim } }` | `{ ship, class }`                | `400 invalid-livery`, `404 no-ship`, `401`                                                                                                                                     |
| `POST /api/ships/repair` | —                                    | `{ ship, class, balance, cost }` | `404 no-ship`, `409 not-docked`, `422 insufficient-credits`, `401`                                                                                                             |
| `POST /api/ships/sell`   | `{ resourceId, amount, source }`     | `{ sold, earned, newBalance }`   | `400 invalid-body`/`unknown-resource`/`invalid-amount`/`invalid-resource`, `404 no-ship`/`unknown-ship`, `409 not-in-system`/`not-docked`/`not-at-station`, `422 insufficient` |

### Galaxy (Bearer)

| method & path              | query                                    | success                                               | errors |
| -------------------------- | ---------------------------------------- | ----------------------------------------------------- | ------ |
| `GET /api/galaxy/health`   | —                                        | `{ shards: [{ systemId, name, players, uptimeMs }] }` | `401`  |
| `GET /api/galaxy/overview` | `?home=` (16-hex, defaults to your home) | `{ seed, systems: […] }`                              | `401`  |

### Dev-only (registered only when `NODE_ENV !== 'production'`)

Test/e2e assists — no production surface, no persistence. All Bearer + in-system.

| method & path                  | body / query                          | success                                         | errors                                                      |
| ------------------------------ | ------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------- |
| `GET /api/dev/pad-target`      | `?systemId=`                          | `{ systemId, planetId, padId, pad }`            | `404 no-pad`                                                |
| `GET /api/dev/hazard-target`   | `?kind=storm\|radzone`                | `{ systemId, planetId, hazardId, pos, radius }` | `404 no-hazard`                                             |
| `GET /api/dev/terminal-target` | `?systemId=`                          | `{ systemId, terminalId, pos }`                 | `404 no-terminal`                                           |
| `POST /api/dev/teleport`       | `{ x, y, z }`                         | `{ ok, systemId }`                              | `400`, `404 no-ship`, `409 not-in-system`/`teleport-failed` |
| `POST /api/dev/teleport-char`  | `{ x, y, z }`                         | `{ ok, systemId }`                              | `400`, `404`, `409`                                         |
| `POST /api/dev/deposit`        | `{ x, y, z, quantity?, resourceId? }` | `{ ok, depositId, systemId }`                   | `400`, `404`, `409`                                         |
| `POST /api/dev/give`           | `{ resourceId, amount }`              | `{ ok, systemId }`                              | `400`, `404`, `409`                                         |
| `POST /api/dev/dummy-target`   | `{ distance? }`                       | `{ ok, targetId, systemId }`                    | `400`, `404`, `409`                                         |
| `POST /api/dev/combat-kill`    | `{ victim, weapon? }`                 | `{ ok, systemId }`                              | `400`, `404`, `409`                                         |

See [routes/index.ts](../src/server/routes/index.ts) for registration and the
per-file handlers under [routes/](../src/server/routes/).
