/**
 * Chart target store (TASK-51) — the star chart's current SELECTION, so
 * the nav readout can point at it. The chart's selection is otherwise
 * component-local (TASK-7); this is the one-line bridge the HUD needs.
 *
 * Set while a system node is selected in an open chart, cleared on close
 * and on warp start. The nav readout shows '→ <name>' (interstellar — no
 * in-system bearing exists for another star) while set, and falls back to
 * the implicit dock target (the nearest station) otherwise.
 */

export interface ChartTarget {
  systemId: string;
  name: string;
}

let current: ChartTarget | null = null;
let currentKey = '';
const listeners = new Set<(t: ChartTarget | null) => void>();

/** Publish the chart selection (null clears it). Emit-on-change. */
export function setChartTarget(next: ChartTarget | null): void {
  const key = next ? `${next.systemId}\u0000${next.name}` : 'null';
  if (key === currentKey) return;
  currentKey = key;
  current = next;
  for (const l of listeners) l(next);
}

export function chartTarget(): ChartTarget | null {
  return current;
}

export function chartTargetSubscribe(listener: (t: ChartTarget | null) => void): () => void {
  listeners.add(listener);
  listener(current);
  return () => listeners.delete(listener);
}

/** Test seam. */
export function __resetChartTarget(): void {
  current = null;
  currentKey = '';
}
