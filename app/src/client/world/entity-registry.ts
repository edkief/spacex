/**
 * TASK-57: the client entity registry — the set of world entities
 * currently rendered (ships + characters + wrecks). The render layer
 * registers/unregisters as entities enter and leave the view; the frame
 * monitor (src/client/perf/frameMonitor.ts) reads the count for its stats.
 *
 * Deliberately tiny: rendering of the entities themselves (prediction,
 * streaming, LODs) lands in later tasks — this registry just tracks the
 * ids the render layer holds.
 */

export type EntityKind = 'ship' | 'character' | 'wreck' | 'drone';

const entities = new Map<string, EntityKind>();

/** Register a rendered entity (idempotent; re-registering updates kind). */
export function registerEntity(id: string, kind: EntityKind): void {
  entities.set(id, kind);
}

/** Remove an entity from the rendered set (no-op if absent). */
export function unregisterEntity(id: string): void {
  entities.delete(id);
}

/** Per-kind counts of the rendered set. */
export function entityCounts(): Record<EntityKind, number> & { total: number } {
  const counts: Record<EntityKind, number> & { total: number } = {
    ship: 0,
    character: 0,
    wreck: 0,
    drone: 0,
    total: 0,
  };
  for (const kind of entities.values()) counts[kind] += 1;
  counts.total = entities.size;
  return counts;
}

/** Total entities currently rendered (ships + characters + wrecks). */
export function renderedEntityCount(): number {
  return entities.size;
}

/** Test-only: clear the registry between cases. */
export function resetEntityRegistry(): void {
  entities.clear();
}
