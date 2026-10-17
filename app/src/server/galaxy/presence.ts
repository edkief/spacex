/**
 * Presence broadcast helpers (TASK-12).
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
 * state)`. The v1 router hard-codes `state: 'flying'` for every
 * connection; TASK-29 + TASK-31 refine the state from the player's
 * landing-pad / on-foot status without changing the wire schema.
 *
 * @see ./router.ts for the consumer.
 * @see ../../shared/protocol/schemas.ts for the wire schema.
 */
import type { PayloadFor } from "@shared/protocol/index.js";

import type { Shard } from "../shard/types.js";

/**
 * Broadcast hook the router calls every time the presence roster
 * changes (join, leave, reap). The WS layer wires this to its
 * outbound queue so the router doesn't take a transport dependency.
 */
export type PresenceBroadcaster = (systemId: string, payload: PayloadFor<"presence">) => void;

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
    state: "flying" as const,
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
