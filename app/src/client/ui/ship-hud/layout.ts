/**
 * Ship HUD layout (TASK-51) — the fixed slots for the flight HUD regions,
 * the single source of truth for the inline styles AND the disjointness
 * test. Slots never overlap the protected regions (chat, player list,
 * prompt line, debug overlay — imported from the combat HUD's layout so
 * both HUDs share one map of the screen).
 */
import type { Viewport, HudRect } from '@client/ui/combat-hud/layout';

/** The bottom-left flight-instrument block: speed, altitude+regime, nav. */
export const SPEED_BLOCK_W = 224;
/** Compact on purpose: the block's top must stay under the vitals bar. */
export const SPEED_BLOCK_H = 80;
/** The top-left vitals bar (shield over hull, 200 px wide per spec). */
export const VITALS_W = 200;
export const VITALS_H = 44;

/** Speed block: bottom-left, ABOVE the player list (the protected rect's top). */
export function speedBlockRect(vp: Viewport): HudRect {
  return {
    x: 16,
    y: vp.h - 260 - 8 - SPEED_BLOCK_H,
    w: SPEED_BLOCK_W,
    h: SPEED_BLOCK_H,
  };
}

/** Vitals bar: top-left, under the chat block (the protected rect's bottom). */
export function vitalsRect(): HudRect {
  return { x: 16, y: 128 + 180 + 12, w: VITALS_W, h: VITALS_H };
}

/** All ship-HUD regions for a viewport (the test's input). */
export function shipHudRects(vp: Viewport): Record<string, HudRect> {
  return { speedBlock: speedBlockRect(vp), vitals: vitalsRect() };
}
