/**
 * WebSocket ↔ Router bridge (TASK-12).
 *
 * Wires the `GalaxyRouter` into the WebSocket lifecycle so that:
 *
 *   1. **Presence broadcasts** flow from the router to every active
 *      connection in a shard. The router holds a `PresenceBroadcaster`
 *      hook; this module wraps a real connection registry into the
 *      hook so the router can push frames without taking a transport
 *      dependency.
 *
 *   2. **Disconnect → leaveSystem.** When a WS connection drops (or
 *      is closed by the server for any reason), the bridge calls
 *      `router.leaveSystem(systemId, connId)` so the connection is
 *      dropped from the shard and the reap grace timer starts.
 *
 *   3. **Connection close hook.** The bridge exposes
 *      `createConnectionCloseHook(...)` — a function the WS layer
 *      calls on every socket close. The hook looks up the
 *      connection's current `systemId` and forwards it to the router.
 *
 * The bridge is intentionally minimal: it does not own the WS
 * registry, the router, or the broadcast hook — it just threads them
 * together. Tests can construct a bridge against a stub registry +
 * a real router to exercise the lifecycle end-to-end.
 *
 * @see ./router.ts for the router API.
 * @see ../ws.connection.ts for the connection shape.
 */
import {
  encodeEnvelope,
  PROTOCOL_VERSION,
  type MessageType,
  type PayloadFor,
} from "@shared/protocol/index.js";

import type { Connection, ConnectionRegistry } from "../ws.connection.js";

import type { GalaxyRouter } from "./router.js";
import type { PresenceBroadcaster } from "./presence.js";
import type { Shard } from "../shard/types.js";

/**
 * Wire a real WS connection registry into the router as a presence
 * broadcaster. The returned function is the hook the router calls
 * whenever the shard's presence roster changes.
 *
 * On every call:
 *   1. Encode the frame once outside the loop so a 16-connection
 *      shard pays one JSON.stringify instead of 16.
 *   2. For every connection in the registry whose `systemId` matches
 *      the broadcast, send the frame. The originator of the change
 *      is included — the spec leaves the choice up to the
 *      implementation, and broadcasting to everyone keeps the
 *      client-side state machine simple.
 *   3. Drop the broadcast if the connection's socket is no longer
 *      open (defensive — a WS that's mid-close shouldn't error).
 *
 * The returned broadcaster is meant to be passed to the router via
 * `new GalaxyRouter({ presenceBroadcaster, … })` — the router holds
 * it as a `readonly` field so it's wired exactly once at boot.
 */
export function buildPresenceBroadcaster(args: {
  registry: ConnectionRegistry;
}): PresenceBroadcaster {
  const { registry } = args;
  return (systemId, payload) => {
    // Encode once outside the loop so a 16-connection shard pays
    // one JSON.stringify instead of 16.
    const frame = encodeEnvelope("presence", payload);
    for (const conn of registry.values()) {
      if (conn.systemId !== systemId) continue;
      if (conn.ws.readyState !== conn.ws.OPEN) continue;
      try {
        conn.ws.send(frame);
      } catch {
        // Socket torn down between the readyState check and the
        // send. Swallowed — the close handler will clean up.
      }
    }
  };
}

/**
 * TASK-16: per-connection frame sender wired into every shard via
 * `RouterOptions.connSender`. Walks the live `ConnectionRegistry`
 * to find the target socket for the requested `connId` and writes
 * the supplied frame verbatim. Used by `broadcastChat()` /
 * `sendEntityUpdate()` / `broadcastCombatEvent()` — the shard
 * delegates the transport step to this closure so the shard itself
 * stays transport-agnostic.
 *
 * The closure is type-narrowed to the union of frame types the
 * shard produces (entity_update / chat / combat_event); the WS
 * layer passes the frame through `JSON.stringify` because the
 * shard callers already build the typed wire shape.
 */
export function buildConnSender(args: {
  registry: ConnectionRegistry;
}): (connId: string, frame: { type: string; payload: unknown }) => void {
  const { registry } = args;
  return (connId, frame) => {
    // The frame is already a typed wire shape — callers build
    // `{v: PROTOCOL_VERSION, ...frame}` then stringify. We do the
    // stringify here so the shard callers stay free of any
    // transport detail.
    for (const conn of registry.values()) {
      if (conn.connId !== connId) continue;
      if (conn.ws.readyState !== conn.ws.OPEN) return;
      try {
        conn.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, ...frame }));
      } catch {
        // Socket torn down between the readyState check and the
        // send. Swallowed — the close handler will clean up.
      }
      return;
    }
  };
}

/**
 * Build the WS-layer "connection close" hook that drops the player
 * from their shard + fires the router's leave path.
 *
 * The hook is invoked once per socket close (normal, error,
 * keepalive-timeout, or task-66 logout). The router's `leaveSystem`
 * is a no-op when the connection never joined a system, so we
 * don't need to gate on `conn.systemId !== null`.
 */
export function createConnectionCloseHook(args: {
  router: GalaxyRouter;
}): (conn: Connection) => void {
  const { router } = args;
  return (conn: Connection) => {
    // TASK-38: drop any in-flight mining state for the
    // disconnecting connection so a reconnecting player starts
    // fresh. Best-effort — the router may have already reaped
    // the shard by the time we get here, in which case there's
    // nothing to clear.
    if (conn.systemId !== null) {
      const shard = router.get(conn.systemId);
      if (shard) {
        const mining = (shard as Shard & { mining?: Map<string, unknown> }).mining;
        mining?.delete(conn.connId);
      }
    }
    if (conn.systemId === null) return;
    const removed = router.leaveSystem(conn.systemId, conn.connId);
    if (removed) {
      // Clear the connection's systemId so a double-close (e.g. the
      // graceful-shutdown path running right after a hard disconnect)
      // doesn't re-enter the router's leave path and double-broadcast
      // presence_leave.
      conn.systemId = null;
    }
  };
}

// ---------------------------------------------------------------------------
// Frame helpers — re-exported here so the consumer doesn't need a
// second import line for the (un)typed envelopes.
// ---------------------------------------------------------------------------

/**
 * Encode a typed frame using the canonical protocol version + JSON
 * envelope shape. The router / bridge doesn't construct any frame
 * directly today, but exposing the helper keeps the WS-integration
 * tests from having to import the protocol module separately.
 */
export function encodeWsFrame<T extends MessageType>(type: T, payload: PayloadFor<T>): string {
  return encodeEnvelope(type, payload);
}
