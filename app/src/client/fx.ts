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
 * - 'hit' on a known target → a small flash at the target (resolvePos feeds
 *   the last-known position; unknown → no effect);
 * - 'destroyed' (TASK-49) → the explosion FX (1 s flash + expanding
 *   shockwave quad + 8 tumbling tetrahedrons, 3 s fade) + the 1 s client-only
 *   slow-mo (the 'SHIP LOST' overlay is the main.tsx store, not FX).
 */
export interface FxWorld {
  addLaserFlash(from: Vec3, to: Vec3): void;
  addImpactFlash(point: Vec3): void;
  addExplosion(point: Vec3): void;
  screenShake(px: number): void;
}

/** The last-known world position resolver (the entity registry / snapshots). */
export type ResolvePos = (entityId: string) => Vec3 | null;

/** Dispatch one combat event to the FX world (no-op for unknown kinds). */
export function playCombatFx(world: FxWorld, event: CombatEvent, resolvePos: ResolvePos): void {
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
    case 'hit': {
      const pos = resolvePos(event.target);
      if (pos) world.addImpactFlash(pos);
      return;
    }
    case 'destroyed': {
      // TASK-49: the destruction sequence — explosion FX + the 1 s slow-mo
      // (the FX world arms it inside addExplosion). The 'SHIP LOST' overlay
      // is main.tsx's store (2 s), not an FX.
      const pos = resolvePos(event.target);
      if (pos) {
        world.addExplosion(pos);
        world.screenShake(6);
      }
      return;
    }
    case 'kill':
      return;
    case 'ai-acquiring':
      // The HUD toast lives in main.tsx (the presence store); no FX here.
      return;
  }
}
