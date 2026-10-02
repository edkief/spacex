/**
 * Client credit-float state (TASK-40) — the transient "+N cr" text that pops
 * at the terminal after a sale (the sell feedback AC: a floating "+240 cr").
 * Each float is an id-tagged entry; the CreditFloatLayer renders them with a
 * short rise-and-fade CSS animation and removes each after it settles.
 *
 * Follows the subscribe/emit idiom of src/client/state/*.ts (emit on change,
 * late subscribers catch up). UI-only, transient.
 */

import { canonicalJson } from '@shared/canonical';

/** One floating credit text. */
export interface CreditFloat {
  id: number;
  text: string;
}

type FloatListener = (floats: CreditFloat[]) => void;

const listeners = new Set<FloatListener>();
let current: CreditFloat[] = [];
let currentJson = canonicalJson(current);
let nextId = 1;

function emit(next: CreditFloat[]): void {
  const json = canonicalJson(next);
  if (json === currentJson) return;
  current = next;
  currentJson = json;
  for (const fn of [...listeners]) fn(next);
}

/** Push a new float (returns its id — the layer schedules its removal). */
export function pushCreditFloat(text: string): number {
  const id = nextId++;
  emit([...current, { id, text }]);
  return id;
}

/** Remove one float (the layer's animation-complete / timeout callback). */
export function removeCreditFloat(id: number): void {
  if (!current.some((f) => f.id === id)) return;
  emit(current.filter((f) => f.id !== id));
}

/** The current floats (empty = nothing to render). */
export function creditFloats(): CreditFloat[] {
  return current;
}

/** Subscribe to float changes. Calls fn(current) immediately; returns the unsubscribe. */
export function creditFloatsSubscribe(fn: FloatListener): () => void {
  listeners.add(fn);
  fn(current);
  return () => {
    listeners.delete(fn);
  };
}

/** Test helper: clear subscribers + reset. */
export function __resetCreditFloats(): void {
  listeners.clear();
  current = [];
  currentJson = canonicalJson(current);
  nextId = 1;
}
