/**
 * Server-side proximity interaction — TASK-33.
 *
 * Mirrors the client's `interaction.ts` so the validation rules
 * stay symmetric:
 *
 *   - Range: ≤ `INTERACT_RANGE_M` (3 m) of the player's current
 *     controlled entity. Measured against the entity's authoritative
 *     `pos`, not the local predictor (cheat-resistance).
 *   - Regime: the connection's `entityId` must point at a `character`
 *     entity. Pilot-in-ship frames go through `wrong-regime` even
 *     if a target is in range.
 *   - Target existence: the `targetId` must resolve to an entity in
 *     the same shard. Missing targets surface as `not-found`.
 *   - Action dispatch: routed by the server's `InteractableRegistry`
 *     — `deposit → pickup`, `dock-terminal → ui-open`, `ship →
 *     enter_ship`. The registry is the *only* dispatch site; the
 *     `interact.test.ts` grep enforces that.
 *
 * The module is intentionally stateless — `handleInteract(shard, ...)
 * is a pure function (modulo shard side effects) so the WS handler
 * can call it inline.
 *
 * @see ./interact.test.ts for the acceptance criteria coverage.
 * @see ./interact.registry.test.ts for the dispatch-lint test.
 */

import { INTERACT_RANGE_M } from "@client/input/interaction.js";
import type { InteractAction } from "@client/input/interaction.js";

import type { Shard, SimEntity } from "./types.js";
import type { EntityKind } from "./types.js";

// ---------------------------------------------------------------------------
// Wire codes (TASK-33 acceptance).
// ---------------------------------------------------------------------------

/**
 * The error codes the handler can surface. Mirrors the schema-side
 * union so the WS dispatcher can convert without any string juggling.
 */
export type InteractErrorCode = "out-of-range" | "wrong-regime" | "not-found";

export interface InteractError {
  ok: false;
  code: InteractErrorCode;
  message: string;
}

export interface InteractSuccess {
  ok: true;
  effect: InteractEffectKind;
  /** Echoed so the WS handler can build an `interact_ok` frame. */
  targetId: string;
  action: InteractAction;
}

export type InteractResult = InteractSuccess | InteractError;

/**
 * The effect names the registry can dispatch. Each maps onto a
 * server-side subsystem:
 *
 *   - `'pickup'`      — TASK-38 lands this; for v1 the stub just
 *                       removes the entity so the snapshot carries
 *                       the change to every client. Inventory
 *                       bookkeeping lands in TASK-34.
 *   - `'ui-open'`     — server pushes a `ui_open` frame so the
 *                       client renders the dock modal (TASK-40
 *                       drives the actual sell UI).
 *   - `'enter-ship'`  — TASK-35 wires the actual enter; here we
 *                       return a typed `NotImplemented` so the
 *                       handler can still reply with a clean
 *                       `code:'not-found'` rather than crashing.
 */
export type InteractEffectKind = "pickup" | "ui-open" | "enter-ship" | "noop";

// ---------------------------------------------------------------------------
// Registry — server side
// ---------------------------------------------------------------------------

/**
 * Mirror of the client's registry entry. The server-side effect is
 * a synchronous operation (we're already inside the shard tick so
 * any DB writes need to be deferred — TASK-34 / TASK-38 land that
 * plumbing).
 */
export interface ServerRegistryEntry {
  /**
   * Resolve the effect to apply. Receives the shard so the effect
   * can mutate state (e.g. `removeEntity`) and the broadcasting
   * hook so the effect can surface a `ui_open` frame.
   */
  apply(args: {
    shard: Shard;
    connId: string;
    target: SimEntity;
    action: InteractAction;
  }): InteractEffectKind;
}

export interface ServerInteractableRegistry {
  register(kind: EntityKind, entry: ServerRegistryEntry): void;
  has(kind: EntityKind): boolean;
  apply(args: {
    shard: Shard;
    connId: string;
    target: SimEntity;
    action: InteractAction;
  }): InteractEffectKind;
}

/**
 * Factory for a server-side registry. The default uses the populate
 * function below to seed the v1 handlers; tests construct their own.
 */
export function createServerInteractableRegistry(): ServerInteractableRegistry {
  const lookup: Partial<Record<EntityKind, ServerRegistryEntry>> = {};
  return {
    register(kind, entry): void {
      lookup[kind] = entry;
    },
    has(kind): boolean {
      return lookup[kind] !== undefined;
    },
    apply(args): InteractEffectKind {
      const entry = lookup[args.target.kind];
      if (entry === undefined) return "noop";
      return entry.apply(args);
    },
  };
}

/**
 * The shared registry used by `handleInteract`. Exported as a
 * singleton so the WS handler and any future consumers share the
 * same dispatch table. Tests inject their own when needed.
 */
export const serverInteractableRegistry: ServerInteractableRegistry =
  createServerInteractableRegistry();

// ---------------------------------------------------------------------------
// Default entries (registered at module load).
// ---------------------------------------------------------------------------

serverInteractableRegistry.register("deposit", {
  apply({ shard, connId: _connId, target, action: _action }): InteractEffectKind {
    // Stub for TASK-38: remove the deposit so every client (owning
    // + remote) sees the entity vanish in the next snapshot. The
    // inventory credit lands with TASK-34; for now the wire frame
    // just teaches the renderer "this entity is gone".
    shard.entities.delete(target.id);
    return "pickup";
  },
});

serverInteractableRegistry.register("terminal", {
  apply({ shard, connId, target, action }): InteractEffectKind {
    // Push a `ui_open` frame to the requesting connection so the
    // client can mount the dock UI (TASK-40/53). The server treats
    // it as presentation: the modal opens client-side and the dock
    // selling flow is its own server route (POST /api/.../sell).
    shard.send(connId, {
      type: "ui_open",
      payload: {
        ui: "dock",
        payload: {
          terminalId: target.id,
          // Echo so the client can correlate the open with the press.
          action,
        },
      },
    });
    return "ui-open";
  },
});

serverInteractableRegistry.register("player", {
  apply(): InteractEffectKind {
    // TASK-35 will route re-entry here. For now we surface the
    // prompt (the client uses it) but tell the WS handler this is
    // a no-op so it can decide whether to fail loudly or just
    // acknowledge. The acceptance criterion is "out of scope for
    // TASK-33" so we return `noop` and the handler replies
    // `interact_ok` anyway.
    return "noop";
  },
});

serverInteractableRegistry.register("character", {
  apply(): InteractEffectKind {
    // Future: trade, party invite, etc. v1 has no character-
    // character interactions, so this is a no-op with a clear
    // error code so the client doesn't think the press failed.
    return "noop";
  },
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const INTERACT_RANGE_SQ_M = INTERACT_RANGE_M * INTERACT_RANGE_M;

/**
 * Squared distance between two 3-component points.
 */
function distSq(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Handle an `interact` frame from a `joined`-state connection.
 *
 * Steps (mirrors TASK-33 acceptance criteria):
 *
 *   1. Locate the connection's controlled entity. Reject
 *      `wrong-regime` if it's not a character (the player must be
 *      on foot for proximity interaction in v1).
 *   2. Locate the targeted entity in the shard's registry. Reject
 *      `not-found` if it's missing.
 *   3. Range check vs the character's authoritative pos. Reject
 *      `out-of-range` if the squared distance exceeds 9 m².
 *   4. Dispatch via the registry; surface `not-found` if the kind
 *      is unknown (the client pre-filters, so this only fires for a
 *      cheat-frame).
 *
 * Returns a discriminated result so the WS handler can convert
 * cleanly into either an `interact_ok` frame or an `error` frame.
 */
export function handleInteract(
  shard: Shard,
  args: { connId: string; targetId: string; action: InteractAction },
  registry: ServerInteractableRegistry = serverInteractableRegistry,
): InteractResult {
  const conn = shard.connections.get(args.connId);
  if (!conn) {
    return { ok: false, code: "not-found", message: "Connection not bound to shard" };
  }
  if (conn.entityId === null) {
    return { ok: false, code: "wrong-regime", message: "Player has no active entity" };
  }
  const interactor = shard.entities.get(conn.entityId);
  if (!interactor) {
    return { ok: false, code: "not-found", message: "Active entity missing from registry" };
  }
  if (interactor.kind !== "character") {
    // Players inside a ship can't proximity-interact. The check
    // happens before the target lookup so the error code reflects
    // the real reason (a player in a ship has no business picking
    // up deposits).
    return {
      ok: false,
      code: "wrong-regime",
      message: "Proximity interaction requires on-foot (character) mode",
    };
  }
  const target = shard.entities.get(args.targetId);
  if (!target) {
    return { ok: false, code: "not-found", message: "Target not in registry" };
  }
  const d2 = distSq(interactor.pos, target.pos);
  if (d2 > INTERACT_RANGE_SQ_M) {
    return {
      ok: false,
      code: "out-of-range",
      message: `Target ${args.targetId} is ${Math.sqrt(d2).toFixed(2)} m away (max ${INTERACT_RANGE_M})`,
    };
  }
  if (!registry.has(target.kind)) {
    return {
      ok: false,
      code: "not-found",
      message: `Unknown interactable kind: ${target.kind}`,
    };
  }
  const effect = registry.apply({ shard, connId: conn.connId, target, action: args.action });
  return {
    ok: true,
    effect,
    targetId: args.targetId,
    action: args.action,
  };
}

/**
 * Convenience: build a server-side interactable from a plain
 * `SimEntity`. Lives here (rather than on `entity.ts`) so the
 * server-side interaction code stays self-contained. The wire
 * serializer (`entityToWire`) is still the source of truth for the
 * client; this helper just narrows the typed projection.
 */
export function makeInteractableFromEntity(e: SimEntity): {
  id: string;
  kind: EntityKind;
  pos: { x: number; y: number; z: number };
} {
  return { id: e.id, kind: e.kind, pos: e.pos };
}
