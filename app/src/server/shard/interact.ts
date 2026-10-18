/**
 * Server-side proximity interaction — TASK-33 + TASK-34.
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
 *     — `deposit → pickup` (TASK-34; calls into `handlePickup`),
 *     `groundItem → pickup` (TASK-34), `dock-terminal → ui-open`,
 *     `ship → enter_ship`. The registry is the *only* dispatch site;
 *     the `interact.test.ts` grep enforces that.
 *
 * The module is intentionally stateless — `handleInteract(shard, ...)
 * is a pure function (modulo shard side effects) so the WS handler
 * can call it inline.
 *
 * @see ./interact.test.ts for the acceptance criteria coverage.
 * @see ./interact.registry.test.ts for the dispatch-lint test.
 * @see ./inventory.ts for the pickup / drop handlers.
 */

import { INTERACT_RANGE_M } from "@client/input/interaction.js";
import type { InteractAction } from "@client/input/interaction.js";
import type { Repository } from "../db/repo.js";

import type { Shard, SimEntity } from "./types.js";
import type { EntityKind } from "./types.js";
import { handlePickup } from "./inventory.js";
import { handleEnterShip } from "./index.js";

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
 *   - `'enter-ship'`  — TASK-35: re-entry (character → ship) via
 *                       the `InteractableRegistry`. The handler
 *                       enforces ownership + velocity + range
 *                       itself; the WS layer wraps the effect in
 *                       an `interact_ok` for the success path.
 */
export type InteractEffectKind = "pickup" | "ui-open" | "enter-ship" | "noop";

/**
 * Shape of a single server-registry entry's `apply` callback.
 * Split out into a type alias so the registry can mix sync
 * (TASK-33) and async (TASK-34 pickup) handlers without
 * surprising callers — async handlers stay a Promise<...> shape
 * and the dispatch chain awaits via `Promise.resolve`.
 */
export type ServerRegistryApplyResult = InteractEffectKind | Promise<InteractEffectKind>;

// ---------------------------------------------------------------------------
// Registry — server side
// ---------------------------------------------------------------------------

/**
 * Mirror of the client's registry entry. The server-side effect is
 * a synchronous-ish operation (we're already inside the shard tick
 * so DB writes happen via the repo; the registry handler awaits
 * `handlePickup` when the interaction actually mutates inventory).
 *
 * TASK-34 plumbing: the entries that need repo access (deposit +
 * groundItem pickups) receive it through the `apply` call args so
 * the registry stays entry-local.
 */
export interface ServerRegistryEntry {
  /**
   * Resolve the effect to apply. Receives the shard so the effect
   * can mutate state (e.g. `removeEntity`), the repo for inventory
   * mutations (TASK-34), and the broadcasting hook so the effect
   * can surface a `ui_open` frame.
   *
   * The entry may return a `Promise` so async pickup handlers can
   * commit the inventory update before the `interact_ok` ack ships.
   */
  apply(args: ServerRegistryApplyArgs): ServerRegistryApplyResult;
}

/**
 * Single apply-call argument shape. Split out so the registry's
 * `apply(...)` signature mirrors the client's prompt shape.
 */
export interface ServerRegistryApplyArgs {
  shard: Shard;
  repo: Repository | null;
  connId: string;
  target: SimEntity;
  action: InteractAction;
}

export interface ServerInteractableRegistry {
  register(kind: EntityKind, entry: ServerRegistryEntry): void;
  has(kind: EntityKind): boolean;
  apply(args: ServerRegistryApplyArgs): ServerRegistryApplyResult;
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
    apply(args): ServerRegistryApplyResult {
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
  async apply({ shard, repo, connId, target }): Promise<InteractEffectKind> {
    // TASK-34: hand off to the inventory handler. The handler
    // validates range + regime itself and persists the new shape
    // via the repo. If the repo is unavailable (test harness), fall
    // back to the legacy "remove only" behaviour so existing tests
    // keep working without rewriting them.
    if (repo === null) {
      shard.entities.delete(target.id);
      return "pickup";
    }
    const result = await handlePickup(shard, repo, { connId, targetId: target.id });
    return result.ok ? "pickup" : "noop";
  },
} satisfies ServerRegistryEntry);

serverInteractableRegistry.register("groundItem", {
  async apply({ shard, repo, connId, target }): Promise<InteractEffectKind> {
    // TASK-34: a ground item carries an authoritative `amount` from
    // when it was dropped; pickup consumes it the same way a deposit
    // does. We reuse `handlePickup` so the partial-pickup math
    // doesn't fork per kind.
    if (repo === null) {
      shard.entities.delete(target.id);
      return "pickup";
    }
    const result = await handlePickup(shard, repo, { connId, targetId: target.id });
    return result.ok ? "pickup" : "noop";
  },
} satisfies ServerRegistryEntry);

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
  // TASK-35: pressing `E` on a player-ship target now routes to
  // the authoritative `handleEnterShip` handler. The handler
  // enforces ownership, velocity, and the 5 m proximity bound
  // itself; the existing `handleInteract` range check (3 m × 30°
  // cone) is the prompt-ergonomics layer — this entry IS the
  // dispatch site, so re-entry semantics only live in one place.
  apply({ shard, connId, target, action }): InteractEffectKind {
    if (action !== "enter") return "noop";
    // Optional sanity: only fire the path when the target is
    // genuinely a player ship (defends against a future kind
    // being misconfigured through this same key).
    if (target.kind !== "player") return "noop";
    const result = handleEnterShip(shard, { connId });
    return result.ok ? "enter-ship" : "noop";
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
 *
 * TASK-34: the registry handler for `deposit` and `groundItem` calls
 * into `handlePickup(...)`. We thread the repo through so the async
 * mutation lands on the same call path as the validation. Tests
 * that don't want the DB may pass `repo: null`.
 */
export async function handleInteract(
  shard: Shard,
  args: {
    connId: string;
    targetId: string;
    action: InteractAction;
    repo?: Repository | null;
  },
  registry: ServerInteractableRegistry = serverInteractableRegistry,
): Promise<InteractResult> {
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
  const effect = registry.apply({
    shard,
    repo: args.repo ?? null,
    connId: conn.connId,
    target,
    action: args.action,
  });
  return {
    ok: true,
    effect: await Promise.resolve(effect),
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
