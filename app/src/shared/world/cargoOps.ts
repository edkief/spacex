/**
 * Cargo hold operations — pure functions for the ship hold (TASK-39).
 *
 * Lives next to `cargo.ts` (the type catalogue) so the operations
 * stay under the AGENTS.md line cap and the tests + server handler
 * share the same math.
 *
 * ## Pure-function contract
 *
 *   - `addToCargo(hold, id, amount)` returns a NEW hold — never
 *     mutates the input. Returns `{ taken, remaining }` where
 *     `taken + remaining === amount` and `taken` is bounded by
 *     remaining capacity.
 *   - `removeFromCargo(hold, id, amount)` validates ownership and
 *     returns a NEW hold. Returns `{ taken, remaining }`; a
 *     non-zero `remaining` indicates the caller tried to take
 *     more than the hold carries (the WS handler surfaces it as a
 *     structured error).
 *   - `recomputeCargoWeight(stacks)` — pure derivation used by the
 *     persistence loader on boot.
 *   - `validateCargoHold(hold)` — debug-time sanity check the
 *     loader runs before accepting a persisted row.
 *
 * All operations are pure — no mutation, no I/O. The server
 * validates every call against the in-memory authoritative copy and
 * persists the new shape via `repo.saveShipState` (which now carries
 * the `cargo` JSON field per the TASK-24 flush extension).
 */
import {
  CARGO_RESOURCE_TYPES,
  CARGO_WEIGHT_PER_UNIT,
  cargoCapacityFor,
  type CargoHold,
  type CargoResourceType,
} from "./cargo.js";
import type { ShipClassId } from "../ships.js";

/** Defensive: clamp total weight to the carry cap. */
function clampWeight(weight: number, capacity: number): number {
  if (weight < 0) return 0;
  if (weight > capacity) return capacity;
  return weight;
}

/**
 * Recompute the total `weightUsed` for a given stack map. The
 * caller (e.g. persistence loader) supplies the `capacity` so the
 * function can clamp to it.
 */
export function recomputeCargoWeight(
  stacks: Readonly<Partial<Record<CargoResourceType, number>>>,
  capacity: number,
): number {
  let total = 0;
  for (const id of Object.keys(stacks) as CargoResourceType[]) {
    const amount = stacks[id] ?? 0;
    const perUnit = CARGO_WEIGHT_PER_UNIT[id];
    if (perUnit === undefined) continue; // defensive: unknown id
    total += amount * perUnit;
  }
  return clampWeight(total, capacity);
}

/**
 * Add `amount` units of `id` to the hold, respecting the
 * weight cap. Returns a new hold + the `{taken, remaining}` tuple.
 *
 * Algorithm:
 *   1. Defensive: if amount <= 0 / id unknown, return the input
 *      hold unchanged with `{taken: 0, remaining: amount}`.
 *   2. Capacity = (capacity - weightUsed) / weightPerUnit. The
 *      hold can carry at most that many units; remainder stays in
 *      the source (the spec's "partial transfer at the boundary").
 *   3. New stack = existing + taken. Strip zero entries before
 *      returning so the persisted shape stays dense.
 */
export function addToCargo(
  hold: CargoHold,
  id: CargoResourceType,
  amount: number,
): { hold: CargoHold; taken: number; remaining: number } {
  if (amount <= 0 || !Number.isInteger(amount)) {
    return { hold, taken: 0, remaining: amount };
  }
  const perUnit = CARGO_WEIGHT_PER_UNIT[id];
  if (perUnit === undefined) {
    return { hold, taken: 0, remaining: amount };
  }
  const available = hold.weightUsed ?? 0;
  const capInUnits = Math.floor((hold.capacity - available) / perUnit);
  if (capInUnits <= 0) {
    return { hold, taken: 0, remaining: amount };
  }
  const taken = Math.min(amount, capInUnits);
  const remaining = amount - taken;
  const existingAmount = hold.stacks[id] ?? 0;
  const nextStacks: Record<CargoResourceType, number> = { ...hold.stacks } as Record<
    CargoResourceType,
    number
  >;
  const newAmount = existingAmount + taken;
  if (newAmount <= 0) {
    delete nextStacks[id];
  } else {
    nextStacks[id] = newAmount;
  }
  const nextWeight = clampWeight((hold.weightUsed ?? 0) + taken * perUnit, hold.capacity);
  return {
    hold: { stacks: nextStacks, weightUsed: nextWeight, capacity: hold.capacity },
    taken,
    remaining,
  };
}

/**
 * Remove `amount` units of `id` from the hold. Returns a new hold
 * + the `{taken, remaining}` tuple. If the hold doesn't carry
 * `amount` of `id`, `taken` is capped at what's available and
 * `remaining` is non-zero — the caller MUST reject in that case.
 */
export function removeFromCargo(
  hold: CargoHold,
  id: CargoResourceType,
  amount: number,
): { hold: CargoHold; taken: number; remaining: number } {
  if (amount <= 0 || !Number.isInteger(amount)) {
    return { hold, taken: 0, remaining: amount };
  }
  const perUnit = CARGO_WEIGHT_PER_UNIT[id];
  if (perUnit === undefined) {
    return { hold, taken: 0, remaining: amount };
  }
  const owned = hold.stacks[id] ?? 0;
  const taken = Math.min(amount, owned);
  const remaining = amount - taken;
  if (taken <= 0) {
    return { hold, taken: 0, remaining };
  }
  const nextStacks: Record<CargoResourceType, number> = { ...hold.stacks } as Record<
    CargoResourceType,
    number
  >;
  const newAmount = owned - taken;
  if (newAmount <= 0) {
    delete nextStacks[id];
  } else {
    nextStacks[id] = newAmount;
  }
  const nextWeight = clampWeight((hold.weightUsed ?? 0) - taken * perUnit, hold.capacity);
  return {
    hold: { stacks: nextStacks, weightUsed: nextWeight, capacity: hold.capacity },
    taken,
    remaining,
  };
}

/**
 * Set the hold's `capacity` to the class-derived value. Used by
 * the sim tick after a ship class change (TASK-20 purchase flow)
 * so the wire / persisted shape always carries the right cap.
 */
export function resizeCargoCapacity(hold: CargoHold, classId: ShipClassId): CargoHold {
  const capacity = cargoCapacityFor(classId);
  // Clamp weight to the new cap so a freighter→scout downgrade
  // doesn't leave the shape in a state where `weightUsed > capacity`.
  const nextWeight = clampWeight(hold.weightUsed ?? 0, capacity);
  return {
    stacks: hold.stacks,
    weightUsed: nextWeight,
    capacity,
  };
}

/**
 * Defensive validator used by the persistence layer when
 * deserialising. Returns `null` for malformed shapes; the caller
 * should treat that as "discard the persisted row + start fresh"
 * rather than crash.
 */
export function validateCargoHold(value: unknown): value is CargoHold {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { stacks?: unknown; weightUsed?: unknown; capacity?: unknown };
  if (typeof v.weightUsed !== "number" || !Number.isFinite(v.weightUsed)) return false;
  if (typeof v.capacity !== "number" || !Number.isInteger(v.capacity) || v.capacity <= 0) {
    return false;
  }
  if (typeof v.stacks !== "object" || v.stacks === null) return false;
  if (v.weightUsed < 0 || v.weightUsed > v.capacity) return false;
  const s = v.stacks as Record<string, unknown>;
  for (const key of Object.keys(s)) {
    if (!CARGO_RESOURCE_TYPES.includes(key as CargoResourceType)) return false;
    const amt = s[key];
    if (typeof amt !== "number" || !Number.isInteger(amt) || amt < 0) return false;
  }
  // Verify the persisted weight agrees with the derived weight.
  if (
    v.weightUsed !==
    recomputeCargoWeight(s as Partial<Record<CargoResourceType, number>>, v.capacity)
  ) {
    return false;
  }
  return true;
}
