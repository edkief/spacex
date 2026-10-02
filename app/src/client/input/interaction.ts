/**
 * On-foot interaction (TASK-33) — the client half: the per-frame raycast
 * against the sparse interactable list and the ONE InteractableRegistry that
 * maps kind → {prompt, eligible, onInteract}.
 *
 * The registry is the ONLY place an interaction is dispatched: a new
 * interactable type = one entry (no scattered if-chains — the lint-style
 * test in interaction.test.ts asserts no other file in src/client sends the
 * 'interact' message).
 *
 * Pure + DOM-free: resolving the target (the shared nearestInteractable over
 * the last snapshot's target list) and the prompt visibility state machine
 * are unit tested; main.tsx wires them to the rAF loop, the E key, and the
 * bottom-center prompt (ui/interact-prompt.tsx).
 */

import {
  INTERACT_CONE_DEG,
  interactForward,
  nearestInteractable,
  type InteractableKind,
  type InteractableTarget,
} from '@shared/interaction';
import type { EntityState, MessageType, PayloadSchemas } from '@shared/protocol/schemas';
import type { Quat, Vec3 } from '@shared/physics/vec';

/** A validated outbound frame (ClientSession.send's shape). */
export type InteractSend = <T extends MessageType>(type: T, payload: PayloadSchemas[T]) => void;

/** What a client pre-filter may key on (the player's identity). */
export interface InteractContext {
  callsign: string;
}

export interface InteractableEntry {
  kind: InteractableKind;
  /** The prompt text (rendered bottom-center, e.g. '[E] Take ore'). */
  prompt: (target: InteractableTarget) => string;
  /**
   * Client pre-filter: the prompt ONLY ever shows valid targets (v1: the
   * ship prompt is for the player's OWN ship — no boarding others).
   */
  eligible: (target: InteractableTarget, ctx: InteractContext) => boolean;
  /** THE dispatch site for this kind: send the interaction message. */
  onInteract: (target: InteractableTarget, send: InteractSend) => void;
}

/** The central client registry: one entry per interactable kind. */
export class InteractableRegistry {
  private readonly byKind = new Map<InteractableKind, InteractableEntry>();

  register(entry: InteractableEntry): this {
    this.byKind.set(entry.kind, entry);
    return this;
  }

  get(kind: InteractableKind): InteractableEntry | undefined {
    return this.byKind.get(kind);
  }

  /** Every registered entry (the raycast pre-filter iterates these). */
  entries(): InteractableEntry[] {
    return [...this.byKind.values()];
  }

  /**
   * THE ONLY interact dispatch (AC): look up the target's kind and run the
   * entry's onInteract. Unknown kinds are ignored (the pre-filter never
   * presents them, and the server re-validates either way).
   */
  dispatch(target: InteractableTarget, send: InteractSend): void {
    const entry = this.byKind.get(target.kind);
    if (!entry) return;
    entry.onInteract(target, send);
  }
}

/**
 * The v1 registry (AC): resource deposits (pick up — the TASK-38 channel
 * replaces this entry's hold-to-mine flow), the player's own ship (re-enter
 * via the 'enter_ship' message, TASK-35), dock terminals (open the dock UI
 * via the server's 'ui-open').
 */
export function createInteractableRegistry(): InteractableRegistry {
  return new InteractableRegistry()
    .register({
      kind: 'deposit',
      prompt: () => '[E] Take ore',
      eligible: () => true,
      // 'pickup' = the v1 one-unit take; TASK-38 extends with the
      // 'mine-start' / 'mine-stop' hold-channel (same message, this entry).
      onInteract: (target, send) => send('interact', { targetId: target.id, action: 'pickup' }),
    })
    .register({
      kind: 'groundItem',
      // TASK-34: dropped inventory — 'Take iron x3' (resource + units).
      prompt: (target) => `[E] Take ${target.resourceId ?? 'items'} x${target.quantity ?? 1}`,
      eligible: () => true,
      // Partial pickup: the server takes what fits in the weight cap and
      // leaves the remainder on the ground item (same 'interact' message).
      onInteract: (target, send) => send('interact', { targetId: target.id, action: 'pickup' }),
    })
    .register({
      kind: 'ship',
      prompt: () => '[E] Enter ship',
      // v1: ONLY the player's own ship (no boarding others — the server
      // re-validates ownership either way, {code:'not-owner'}).
      eligible: (target, ctx) => target.callsign === ctx.callsign,
      // TASK-35: re-entry is its own message — the server switches the
      // player's active entity character → ship (5 m radius, < 1 u/s speed
      // cap, idempotent 'already-in-ship').
      onInteract: (target, send) => send('enter_ship', { shipId: target.id }),
    })
    .register({
      kind: 'terminal',
      prompt: () => '[E] Dock terminal',
      eligible: () => true,
      // The server answers with the 'ui-open' {ui:'dock'} frame (TASK-40/53).
      onInteract: (target, send) => send('interact', { targetId: target.id }),
    });
}

/** The raycast result for one frame (the prompt's target, or nothing). */
export interface ResolvedInteract {
  target: InteractableTarget;
  text: string;
  /** Character ↔ target distance (m). */
  distance: number;
}

/**
 * One frame of the interaction raycast (AC): pre-filter the target list
 * (registered kind + the entry's eligibility — the prompt only ever shows
 * VALID targets), then the shared nearestInteractable (per-kind reach —
 * 3 m default, the ship's 5 m enter radius (TASK-35) — 30° cone).
 * Pure — the caller feeds it the last snapshot's target list each frame.
 */
export function resolveInteract(
  targets: readonly InteractableTarget[],
  feet: Vec3,
  facing: Quat | undefined,
  ctx: InteractContext,
  registry: InteractableRegistry,
  range?: number,
  coneDeg: number = INTERACT_CONE_DEG,
): ResolvedInteract | null {
  const eligible = targets.filter((t) => registry.get(t.kind)?.eligible(t, ctx));
  const hit = nearestInteractable(feet, interactForward(facing), eligible, range, coneDeg);
  if (!hit) return null;
  const entry = registry.get(hit.target.kind);
  if (!entry) return null;
  return { target: hit.target, text: entry.prompt(hit.target), distance: hit.distance };
}

/**
 * The sparse interactable list out of a snapshot batch (the raycast NEVER
 * touches the scene graph — interactables are the bounded seed entities:
 * deposits, ships, terminals).
 */
export function interactableTargetsFrom(entities: readonly EntityState[]): InteractableTarget[] {
  const out: InteractableTarget[] = [];
  for (const e of entities) {
    if (
      e.kind !== 'deposit' &&
      e.kind !== 'ship' &&
      e.kind !== 'terminal' &&
      e.kind !== 'groundItem'
    )
      continue;
    out.push({
      id: e.id,
      kind: e.kind,
      pos: e.pos,
      ...(e.callsign !== undefined ? { callsign: e.callsign } : {}),
      // TASK-34: ground items carry resource + units for the prompt text.
      ...(e.resourceId !== undefined ? { resourceId: e.resourceId } : {}),
      ...(e.quantity !== undefined ? { quantity: e.quantity } : {}),
    });
  }
  return out;
}

/** The bottom-center prompt's visibility (the state machine's state). */
export type PromptState = { kind: 'hidden' } | { kind: 'visible'; targetId: string; text: string };

const HIDDEN: PromptState = { kind: 'hidden' };

/**
 * The prompt visibility state machine (AC: show / hide / switch between two
 * targets): pure and emit-on-change — the SAME state object is returned when
 * nothing changed, so the rAF loop can compare by reference and re-render
 * React only on a real show/hide/switch.
 */
export function nextPromptState(prev: PromptState, resolved: ResolvedInteract | null): PromptState {
  if (!resolved) {
    return prev.kind === 'hidden' ? prev : HIDDEN;
  }
  if (
    prev.kind === 'visible' &&
    prev.targetId === resolved.target.id &&
    prev.text === resolved.text
  ) {
    return prev;
  }
  return { kind: 'visible', targetId: resolved.target.id, text: resolved.text };
}
