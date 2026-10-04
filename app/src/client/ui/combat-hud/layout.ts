/**
 * TASK-50: the combat HUD's fixed layout slots — the single source of truth
 * for BOTH the inline styles the components render AND the layout
 * disjointness test (a rect computed here is the rect rendered there).
 *
 * Layout rules (spec): the combat regions (target box card, weapon readout,
 * threat ping wedge, kill feed) never overlap the prompt line
 * (bottom-center), the player list (bottom-left), the chat (top-left) or the
 * debug overlay (top-right). The test (combat-hud.test.tsx) asserts the
 * pairwise disjointness of every region at the reference 1280×720 viewport.
 */
import React from 'react';

export interface Viewport {
  w: number;
  h: number;
}

/** The 'hud' frame-monitor budget (ms) — the AC's < 1 ms/frame bound. */
export const HUD_BUDGET_MS = 1;

export interface HudRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Combat region slot sizes (px). */
export const TARGET_BOX_W = 190;
export const TARGET_BOX_H = 104;
export const WEAPON_READOUT_W = 260;
export const WEAPON_READOUT_H = 72;
export const THREAT_WEDGE_PX = 64;
export const KILL_FEED_W = 240;
/** Worst case: the feed's cap of 5 entries at the shipped line height. */
export const KILL_FEED_MAX_H = 157;
export const TARGET_BANNER_W = 280;
export const TARGET_BANNER_H = 24;

/** The threat wedge rides a ring of this radius about the screen center. */
export function threatWedgeRadius(vp: Viewport): number {
  return Math.max(40, Math.min(vp.w, vp.h) / 2 - 120);
}

/**
 * The wedge center for a relative bearing (rad; 0 = dead ahead, positive =
 * right of the nose — the screen mapping: x += sin, y -= cos).
 */
export function threatWedgeCenter(bearingRad: number, vp: Viewport): { x: number; y: number } {
  const r = threatWedgeRadius(vp);
  return {
    x: vp.w / 2 + r * Math.sin(bearingRad),
    y: vp.h / 2 - r * Math.cos(bearingRad),
  };
}

/** Target box card: right of center, 1/3 from the right edge. */
export function targetBoxRect(vp: Viewport): HudRect {
  return {
    x: (vp.w * 2) / 3,
    y: vp.h * 0.28,
    w: TARGET_BOX_W,
    h: TARGET_BOX_H,
  };
}

/** Weapon readout: bottom-center, above the prompt line (which starts at h−72). */
export function weaponReadoutRect(vp: Viewport): HudRect {
  return {
    x: (vp.w - WEAPON_READOUT_W) / 2,
    y: vp.h - 104 - WEAPON_READOUT_H,
    w: WEAPON_READOUT_W,
    h: WEAPON_READOUT_H,
  };
}

/** Threat ping: the wedge (screen-edge, not world-anchored). */
export function threatPingRect(bearingRad: number, vp: Viewport): HudRect {
  const c = threatWedgeCenter(bearingRad, vp);
  return {
    x: c.x - THREAT_WEDGE_PX / 2,
    y: c.y - THREAT_WEDGE_PX / 2,
    w: THREAT_WEDGE_PX,
    h: THREAT_WEDGE_PX,
  };
}

/** Kill feed (TASK-47): top-center, worst-case 5 entries. */
export function killFeedRect(vp: Viewport): HudRect {
  return { x: (vp.w - KILL_FEED_W) / 2, y: 16, w: KILL_FEED_W, h: KILL_FEED_MAX_H };
}

/** Transient 'TARGET LOCKED' / 'NO TARGET' banner, below the feed. */
export function targetBannerRect(vp: Viewport): HudRect {
  return {
    x: (vp.w - TARGET_BANNER_W) / 2,
    y: 16 + KILL_FEED_MAX_H + 3,
    w: TARGET_BANNER_W,
    h: TARGET_BANNER_H,
  };
}

/** All combat HUD regions for a state (the threat ping's bearing). */
export function combatHudRects(vp: Viewport, threatBearingRad: number): Record<string, HudRect> {
  return {
    targetBox: targetBoxRect(vp),
    weaponReadout: weaponReadoutRect(vp),
    threatPing: threatPingRect(threatBearingRad, vp),
    killFeed: killFeedRect(vp),
    targetBanner: targetBannerRect(vp),
  };
}

/**
 * The protected regions the combat HUD must stay out of. Boxes are the
 * shipped components' geometry (chat: top 8rem / 20rem wide / max 5 lines;
 * player list: bottom-left ~10 rows; prompt line: bottom 4.5rem centered;
 * debug overlay: top-right panel).
 */
export function protectedRects(vp: Viewport): Record<string, HudRect> {
  return {
    chat: { x: 16, y: 128, w: 320, h: 180 },
    playerList: { x: 16, y: vp.h - 260, w: 240, h: 244 },
    promptLine: { x: (vp.w - 360) / 2, y: vp.h - 72 - 28, w: 360, h: 28 },
    debugOverlay: { x: vp.w - 296, y: 16, w: 280, h: 154 },
  };
}

/** Strict intersection (touching edges is disjoint). */
export function rectsIntersect(a: HudRect, b: HudRect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** True when every pair in the group is disjoint. */
export function allPairwiseDisjoint(group: Record<string, HudRect>): boolean {
  const keys = Object.keys(group);
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      if (rectsIntersect(group[keys[i]], group[keys[j]])) return false;
    }
  }
  return true;
}

/** The fixed-position inline style for a rect (px, viewport-absolute). */
export function styleFromRect(r: HudRect, extra?: React.CSSProperties): React.CSSProperties {
  return {
    position: 'fixed',
    left: `${r.x}px`,
    top: `${r.y}px`,
    width: `${r.w}px`,
    height: `${r.h}px`,
    ...extra,
  };
}
