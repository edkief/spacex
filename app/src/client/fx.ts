import type { PayloadSchemas } from '@shared/protocol/schemas';
import type { Vec3 } from '@shared/physics/vec';

export type CombatEvent = PayloadSchemas['combat_event'];

/**
 * Combat FX dispatcher (TASK-43 step 3): the ONE place a server
 * combat_event becomes a client effect. Events NEVER originate from the
 * local fire intent — a denied fire produces no combat_event and therefore
 * no FX (spec). The effect map:
 *
 * - 'laser-fired'   → 60 ms additive line flash nose→to (+ muzzle spark);
 * - 'missile-fired' → nothing (the tracer rides the 10 Hz snapshots);
 * - 'missile-impact'→ small flash at the point + a 2 px screen shake;
 * - 'hit' / 'destroyed' on a known target → a small flash at the target
 *   (resolvePos feeds the last-known position; unknown → no effect).
 */
export interface FxWorld {
  addLaserFlash(from: Vec3, to: Vec3): void;
  addImpactFlash(point: Vec3): void;
  screenShake(px: number): void;
}

/** The last-known world position resolver (the entity registry / snapshots). */
export type ResolvePos = (entityId: string) => Vec3 | null;

/** Dispatch one combat event to the FX world (no-op for unknown kinds). */
export function playCombatFx(
  world: FxWorld,
  event: CombatEvent,
  resolvePos: ResolvePos,
): void {
  switch (event.kind) {
    case 'laser-fired':
      world.addLaserFlash(event.from, event.to);
      return;
    case 'missile-fired':
      // The tracer is a snapshot entity — nothing to play on launch.
      return;
    case 'missile-impact':
      world.addImpactFlash(event.point);
      world.screenShake(2);
      return;
    case 'hit':
    case 'destroyed': {
      const pos = resolvePos(event.target);
      if (pos) world.addImpactFlash(pos);
      return;
    }
    case 'kill':
      return;
  }
}
