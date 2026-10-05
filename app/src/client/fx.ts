import type { PayloadSchemas } from '@shared/protocol/schemas';
import type { Vec3 } from '@shared/physics/vec';
import { PRESETS } from '@shared/settings';
import { isReducedMotion, settingsState } from '@client/a11y/reduced-motion';

export type CombatEvent = PayloadSchemas['combat_event'];

/**
 * FX registry counters (TASK-54): `played` / `skipped` are the FX
 * registry's skip/play counts — the reduced-motion test asserts
 * `skipped > 0 && played == 0` after a combat event with the flag on.
 */
export const fxCounts: { played: number; skipped: number } = { played: 0, skipped: 0 };

export function __resetFxCounts(): void {
  fxCounts.played = 0;
  fxCounts.skipped = 0;
}

/**
 * The reduced-motion gate (TASK-54): one world effect call is either
 * PLAYED (default) or SKIPPED (the 'reduced-motion' setting is on).
 * Gated: laser flashes, impact flashes, explosions (which also arm the
 * client-side slow-mo — skipping the explosion skips the slow-mo) and
 * camera shake. When on, the registry counts the skip for the test.
 */
function fx(world: FxWorld, fn: () => void): void {
  if (isReducedMotion()) {
    fxCounts.skipped += 1;
    return;
  }
  // TASK-55: the quality preset's fxQuality scales the FX SPAWN RATE — each
  // gated effect only fires when the roll beats the multiplier (1.0 =
  // always, 0.3 = ~30 %). The multiplier is read LIVE off the settings
  // store (the SettingsBridge: a preset switch re-tunes FX next event, no
  // re-init).
  if (Math.random() >= fxSpawnRate()) {
    fxCounts.skipped += 1;
    return;
  }
  fxCounts.played += 1;
  fn();
}

/** The active FX spawn-rate multiplier (the preset's fxQuality). */
export function fxSpawnRate(): number {
  return PRESETS[settingsState().quality].fxQuality;
}

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
      fx(world, () => world.addLaserFlash(event.from, event.to));
      return;
    case 'missile-fired':
      // The tracer is a snapshot entity — nothing to play on launch.
      return;
    case 'missile-impact':
      fx(world, () => world.addImpactFlash(event.point));
      fx(world, () => world.screenShake(2));
      return;
    case 'hit': {
      const pos = resolvePos(event.target);
      if (pos) fx(world, () => world.addImpactFlash(pos));
      return;
    }
    case 'destroyed': {
      // TASK-49: the destruction sequence — explosion FX + the 1 s slow-mo
      // (the FX world arms it inside addExplosion). The 'SHIP LOST' overlay
      // is main.tsx's store (2 s), not an FX. Reduced motion skips both the
      // explosion (debris/smoke particles) and its slow-mo (gate above).
      const pos = resolvePos(event.target);
      if (pos) {
        fx(world, () => world.addExplosion(pos));
        fx(world, () => world.screenShake(6));
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
