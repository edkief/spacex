/**
 * On-foot interaction system — TASK-33.
 *
 * The on-foot interaction model has three layers, each in its own
 * module so it stays under the AGENTS.md 200-300 line cap:
 *
 *   1. **Cone raycast math** — `pickInteractable(...)` walks the
 *      interactable list, projects each candidate onto the
 *      character's forward cone, and returns the nearest target in
 *      range. Cheap (the interactable list is bounded: ≤ 200 deposit
 *      seeds + a handful of ships + terminals), no spatial hash
 *      needed.
 *   2. **Registry** — `InteractableRegistry` maps an entity `kind`
 *      to a `{ prompt, action }` shape. The registry is the *only*
 *      place the `interact` dispatch reads from; the lint-style
 *      test in `interaction.test.ts` greps the codebase to make
 *      sure no other dispatch site exists.
 *   3. **Prompt state machine** — `promptForTarget(target)` returns
 *      the next prompt descriptor or `null` when nothing is in
 *      range. The React component (`<InteractionPrompt />`) wraps
 *      this so the prompt hides automatically on a target switch.
 *
 * ## Acceptance criteria (mirrors TASK-33 spec)
 *
 *   - Raycast cone: max 3 m, forward cone 30°, nearest wins.
 *   - Dispatch reads from the registry only (enforced by grep test).
 *   - Prompt is bottom-centre; hidden when nothing is in range;
 *     switches target atomically on the nearest-wins recomputation.
 *   - Client pre-filters invalid targets — the server only ever
 *     sees well-formed `(targetId, action)` pairs.
 *
 * @see ./interaction.test.ts for the math + state-machine coverage.
 * @see ../components/InteractionPrompt.tsx for the React UI.
 * @see ../../server/shard/interact.ts for the server validation.
 */

import type { Vec3 } from "@shared/physics/vec.js";
// ---------------------------------------------------------------------------
// Public constants — exported so the server validator can reuse them.
// ---------------------------------------------------------------------------

/** Max interaction distance (forward cone radius along the character's +X). */
export const INTERACT_RANGE_M = 3;

/** Half-angle of the forward interaction cone (degrees). */
export const INTERACT_CONE_HALF_ANGLE_DEG = 30;

/** Cosine of the cone half-angle. Pre-computed for the cone test. */
export const INTERACT_CONE_COS = Math.cos((INTERACT_CONE_HALF_ANGLE_DEG * Math.PI) / 180);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The kinds of entity that can be interacted with. Server-controlled:
 * adding a new kind here MUST be paired with a registry entry
 * otherwise the dispatch site will return `not-found`. The dispatch
 * test (`interaction.test.ts`) enforces a non-empty registry.
 */
export type InteractableKind = "deposit" | "ship" | "dock-terminal";

/**
 * The wire-stable action the client sends. Mirrors the enum in
 * `InteractSchema` (TASK-33).
 *
 *   - `'use'`   — generic activation (pick up a deposit, open a terminal).
 *   - `'enter'` — re-enter a docked ship (TASK-35).
 *   - `'mine'`  — long-running extraction (TASK-38 — registry routes to `'use'`).
 */
export type InteractAction = "use" | "enter" | "exit" | "inspect" | "mine";

/**
 * Minimal interactable descriptor — the client-side projection of a
 * `SimEntity` (TASK-32's character view provides the position;
 * deposits + ships come from the wire's `entity_update`). The
 * registry hands the descriptor back to the prompt so the player
 * sees *which* entity they're about to pick up.
 */
export interface Interactable {
  /** Wire-stable entity id (the same id the server registry uses). */
  readonly id: string;
  /** Entity kind — drives registry lookup. */
  readonly kind: InteractableKind;
  /** World position (same coordinate frame as the character's `pos`). */
  readonly pos: Vec3;
  /** Optional display label (e.g. the deposit's resource type). */
  readonly label?: string;
}

/**
 * Result of a single prompt-evaluation pass. `null` means nothing is
 * in range and the UI should hide. When set, the prompt mounts the
 * given text + the wire action the registry chose.
 */
export interface InteractionPrompt {
  readonly targetId: string;
  readonly prompt: string;
  readonly action: InteractAction;
}

/**
 * The minimal character context the cone-raycast needs. Pulled from
 * `ClientCharacterPredictor` (TASK-32) at sample time. The forward
 * vector is the character's local +X axis in world space (the same
 * convention used by the disembark offset).
 */
export interface Interactor {
  readonly pos: Vec3;
  /** Unit forward vector in world space (already normalised). */
  readonly forward: Vec3;
}

// ---------------------------------------------------------------------------
// Cone raycast
// ---------------------------------------------------------------------------

/**
 * Select the nearest interactable within `INTERACT_RANGE_M` of the
 * character whose direction lies inside the `INTERACT_CONE_HALF_ANGLE_DEG`
 * forward cone. Returns `null` if nothing matches — the prompt then
 * hides per the spec.
 *
 * Algorithm: O(n) over the interactable list; `n` is bounded by
 *   `≤ 200 deposit seeds + ships + terminals per system` so the
 *   per-frame cost is microseconds. No spatial hash needed in v1.
 *
 * The angle test uses the dot product against the unit forward
 * vector — `cos(θ) ≥ INTERACT_CONE_COS` → in cone. Distance is the
 * squared Euclidean; we compare squared deltas and only take the
 * `sqrt` if the caller wants the visible readout.
 */
export function pickInteractable<T extends Interactable>(
  interactor: Interactor,
  candidates: readonly T[],
): T | null {
  let best: T | null = null;
  let bestDistSq = Number.POSITIVE_INFINITY;
  for (const cand of candidates) {
    const offset = {
      x: cand.pos.x - interactor.pos.x,
      y: cand.pos.y - interactor.pos.y,
      z: cand.pos.z - interactor.pos.z,
    };
    const distSqVal = offset.x * offset.x + offset.y * offset.y + offset.z * offset.z;
    // Skip beyond-range targets up-front so we don't pay the angle
    // test on anything the cone would reject anyway.
    if (distSqVal > INTERACT_RANGE_M * INTERACT_RANGE_M) continue;
    // Inside range — check the angle. `offset` needs normalising, but
    // we can do the dot product directly against the un-normalised
    // offset and divide by `sqrt(distSq) * |forward|`. `forward` is
    // pre-normalised so |forward|=1; the per-target cost is one sqrt.
    const length = Math.sqrt(distSqVal);
    if (length <= 1e-9) continue;
    const cosTheta =
      (offset.x * interactor.forward.x +
        offset.y * interactor.forward.y +
        offset.z * interactor.forward.z) /
      length;
    if (cosTheta < INTERACT_CONE_COS) continue;
    if (distSqVal < bestDistSq) {
      best = cand;
      bestDistSq = distSqVal;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Registry — the only place `interact` dispatch reads from.
// ---------------------------------------------------------------------------

/**
 * A single registry entry: given an interactable descriptor, return
 * the prompt text + the wire action to send. Returning `null`
 * means the interactable is registered but currently inert (e.g.
 * a docked ship that the player already owns).
 *
 * The dispatch site (`InteractionPrompt` in `components/...`) only
 * looks at this map — the lint-style test ensures no other dispatch
 * path exists in the codebase.
 */
export interface RegistryEntry {
  /** Build the prompt text for the given interactable. */
  prompt(target: Interactable): InteractionPrompt | null;
}

/**
 * A handle wrapping the entries indexed by `InteractableKind`. Adding
 * a new interactable type is a one-line registration:
 *
 * ```ts
 * registry.register("deposit", { prompt: (t) => ... });
 * ```
 *
 * The registry is owned by the client singleton (lives across the
 * lifetime of the React tree). Tests construct a fresh one with
 * `createInteractableRegistry()`.
 */
export interface InteractableRegistry {
  register(kind: InteractableKind, entry: RegistryEntry): void;
  has(kind: InteractableKind): boolean;
  /** Look up the prompt descriptor for a target. */
  promptFor(target: Interactable): InteractionPrompt | null;
  /** Snapshot of every registered kind — useful for the lint-style test. */
  readonly kinds: readonly InteractableKind[];
}

/**
 * Create a registry. Used both for the production default and by
 * tests that want isolation.
 */
export function createInteractableRegistry(): InteractableRegistry {
  const lookup: Partial<Record<InteractableKind, RegistryEntry>> = {};
  const kinds: InteractableKind[] = [];
  return {
    register(kind, entry): void {
      lookup[kind] = entry;
      if (!kinds.includes(kind)) kinds.push(kind);
    },
    has(kind): boolean {
      return lookup[kind] !== undefined;
    },
    promptFor(target): InteractionPrompt | null {
      const entry = lookup[target.kind];
      if (entry === undefined) return null;
      return entry.prompt(target);
    },
    get kinds(): readonly InteractableKind[] {
      // Return a defensive copy so callers can't mutate the registry.
      return Object.freeze([...kinds]) as readonly InteractableKind[];
    },
  };
}

/**
 * Default registry, populated with the v1 entries described in the
 * spec. Exporting the instance (rather than a factory) so the React
 * component can share state across re-renders without prop-drilling
 * a registry instance.
 *
 * Tests construct their own via `createInteractableRegistry()` so
 * they don't share state with the production singleton.
 */
export const defaultInteractableRegistry: InteractableRegistry = createInteractableRegistry();
defaultInteractableRegistry.register("deposit", {
  prompt(target): InteractionPrompt | null {
    const label = target.label ? target.label : "ore";
    return {
      targetId: target.id,
      prompt: `[E] Take ${label}`,
      action: "use",
    };
  },
});
defaultInteractableRegistry.register("dock-terminal", {
  prompt(target): InteractionPrompt | null {
    return {
      targetId: target.id,
      prompt: `[E] Dock terminal`,
      action: "use",
    };
  },
});
defaultInteractableRegistry.register("ship", {
  prompt(target): InteractionPrompt | null {
    return {
      targetId: target.id,
      prompt: `[E] Enter ship`,
      action: "enter",
    };
  },
});

// ---------------------------------------------------------------------------
// Prompt state machine
// ---------------------------------------------------------------------------

/**
 * Compute the next prompt from the interactor + interactable list.
 * Returns `null` when no candidate is in range — the React component
 * hides on `null` so the prompt never renders an empty pill.
 *
 * Exported separately from the registry lookup so the React
 * component can be tested in isolation (`interaction.test.ts`'s
 * "prompt visibility state machine" block).
 */
export function promptForTarget(
  interactor: Interactor,
  candidates: readonly Interactable[],
  registry: InteractableRegistry = defaultInteractableRegistry,
): InteractionPrompt | null {
  const target = pickInteractable(interactor, candidates);
  if (target === null) return null;
  return registry.promptFor(target);
}
