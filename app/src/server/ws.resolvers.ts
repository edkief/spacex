/**
 * Default auth + join resolvers for the Drift WebSocket server (TASK-9).
 *
 * These are deliberately stub implementations: TASK-9 establishes the
 * protocol + state machine, and the stubs return deterministic enough
 * values for integration tests to assert against. Later tasks replace
 * them with real implementations:
 *
 *   - TASK-10 — `authResolver` is replaced with the callsign-uniqueness
 *     + HMAC session-token flow.
 *   - TASK-11 — `joinResolver` is replaced with the in-process system
 *     router + 16-player occupancy check.
 *
 * Keeping the stubs in their own module makes that swap a one-line
 * change in `attachWs` without churning the rest of the protocol.
 */
import type { AuthResolver, JoinResolver, JoinResolverResult } from "./ws.js";

/**
 * Default auth resolver. Accepts any well-formed `auth` payload and
 * synthesises a stable playerId/callsign. TASK-10 will replace this
 * with real callsign-uniqueness + HMAC signing.
 */
export function defaultAuthResolver(payload: unknown): ReturnType<AuthResolver> {
  if (typeof payload !== "object" || payload === null) {
    return Promise.reject(new Error("auth payload must be an object"));
  }
  const p = payload as { token?: unknown; callsign?: unknown };
  const callsign = typeof p.callsign === "string" ? p.callsign : "GUEST";
  // Derive a stable playerId from the callsign. TASK-10 will use a real
  // HMAC-backed session token; for now the id is deterministic so tests
  // can assert on it.
  let hash = 0;
  for (let i = 0; i < callsign.length; i++) {
    hash = ((hash << 5) - hash + callsign.charCodeAt(i)) | 0;
  }
  const playerId = `p-${(hash >>> 0).toString(16).padStart(8, "0")}`;
  return Promise.resolve({
    playerId,
    callsign,
    tokenExpiresAt: Date.now() + 60 * 60 * 1000,
  });
}

/**
 * Default join resolver. Accepts any `systemId` and echoes back an empty
 * snapshot. The real system router (TASK-11) will replace this with a
 * shard-load + occupancy check.
 */
export function defaultJoinResolver(systemId: string): ReturnType<JoinResolver> {
  const result: JoinResolverResult = {
    systemId,
    entities: [],
    nodes: [],
    chat: [],
    players: [],
    serverTickHz: 20,
    snapshotTick: 0,
  };
  return Promise.resolve(result);
}
