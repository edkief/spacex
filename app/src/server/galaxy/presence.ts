/**
 * Presence broadcast helpers (TASK-12 + TASK-36).
 *
 * Centralised so the router can build a canonical presence payload
 * from a `Shard`'s connections without duplicating the logic across
 * join + leave + reap. The router invokes the broadcaster hook from
 * `RouterOptions.presenceBroadcaster`; this module owns the wire
 * shape so a future protocol bump (e.g. adding `activity` /
 * `lastSeenAt`) only changes one file.
 *
 * Wire shape: matches `PresenceSchema` in
 * `@shared/protocol/schemas.ts`:
 *
 *   { systemId: string, players: PresenceEntry[] }
 *
 * Each `PresenceEntry` carries `(playerId, callsign, shipId,
 * state)`. TASK-36 derives `state` from the player's bound entity:
 *
 *   - `character` entity → `"onfoot"`   (TASK-31 disembark flow)
 *   - ship `onPad` non-null → `"docked"` (TASK-29 pad detection)
 *   - otherwise          → `"flying"`
 *
 * The router invokes `buildPresencePayload` after every join,
 * leave, disembark, re-entry, and dock event so the `PlayerList`
 * icon switches on the same frame the server-side state flips.
 *
 * @see ./router.ts for the consumer.
 * @see ../../shared/protocol/schemas.ts for the wire schema.
 */
import type { PayloadFor, ProtocolPlayerActivity } from "@shared/protocol/index.js";

import { makeCharacterId } from "../shard/entity.js";
import type { Shard } from "../shard/types.js";

/**
 * Broadcast hook the router calls every time the presence roster
 * changes (join, leave, reap). The WS layer wires this to its
 * outbound queue so the router doesn't take a transport dependency.
 */
export type PresenceBroadcaster = (systemId: string, payload: PayloadFor<"presence">) => void;

/**
 * Derive the `PlayerActivity` tag for one connection based on its
 * currently-bound entity in the shard. Returns `"onfoot"` for a
 * character entity, `"docked"` for a ship sitting on a landing
 * pad, and `"flying"` for everything else.
 *
 * The order matters: a disembarked player owns *no* ship entity,
 * so the entity lookup walks the character's id (`char:<playerId>`)
 * first; if no character exists we fall back to the connection's
 * ship entity. The fallback handles the "just-re-entered" race
 * where the re-entry has fired but the disembark has not yet
 * released the character.
 */
export function derivePlayerActivity(shard: Shard, connPlayerId: string): ProtocolPlayerActivity {
  const charId = makeCharacterId(connPlayerId);
  const character = shard.entities.get(charId);
  if (character && character.kind === "character") {
    return "onfoot";
  }
  // Fall back to the connection's ship (TASK-12 stores the id in
  // `conn.shipId`); check the registry for docked state. The
  // connection's `entityId` is only set after the first input, so
  // we walk the shipId directly through the registry instead.
  const conn = Array.from(shard.connections.values()).find((c) => c.playerId === connPlayerId);
  if (!conn) return "flying";
  const shipEntityId = `entity:${conn.shipId}`;
  const ship = shard.entities.get(shipEntityId);
  if (ship && ship.onPad !== null) return "docked";
  return "flying";
}

/**
 * Build the canonical presence payload for the shard.
 *
 * Returns the current roster regardless of size. Callers that want
 * to short-circuit "no listeners" can check the length; we
 * deliberately keep this helper pure so the reap path can use it
 * to construct an explicit empty-roster frame.
 */
export function buildPresencePayload(shard: Shard): PayloadFor<"presence"> {
  const players = Array.from(shard.connections.values()).map((c) => ({
    playerId: c.playerId,
    callsign: c.callsign,
    shipId: c.shipId,
    state: derivePlayerActivity(shard, c.playerId),
  }));
  return { systemId: shard.systemId, players };
}

/**
 * Fire the presence broadcaster if one is wired. Always invokes
 * the hook (even for an empty roster) so any subscriber watching
 * the bus can observe the change — the broadcaster is responsible
 * for choosing whether to forward the empty roster to its own
 * downstream (the WS layer's `buildPresenceBroadcaster` skips
 * sockets with no systemId, which is the practical "no listener"
 * case for the live wire).
 *
 * Centralised so the router has one line per event site instead of
 * repeating the null-check.
 */
export function firePresenceBroadcast(
  broadcaster: PresenceBroadcaster | undefined,
  shard: Shard,
): void {
  if (!broadcaster) return;
  const payload = buildPresencePayload(shard);
  broadcaster(shard.systemId, payload);
}
