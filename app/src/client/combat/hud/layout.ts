/**
 * Combat-HUD layout slots — TASK-50.
 *
 * Every combat HUD region lives in a **fixed slot** so the regions
 * can never overlap the prompt line (bottom-center), the player
 * list (bottom-left), the chat (top-left) or the debug overlay
 * (top-right). The layout is data — `hudSlots` returns a rect per
 * region at a given viewport — so the disjointness test is pure
 * math, and the components read their own rect from the same table
 * (one source of truth, no per-component magic numbers).
 *
 * @see ../components/CombatHUD.tsx — assembles the four combat
 *      regions into these slots.
 */

import { FOV_DEG } from "../../camera/cameraMath.js";
import { VITALS_BAR_HEIGHT_PX, VITALS_BAR_WIDTH_PX } from "./vitals.js";

/** Reference viewport the layout test pins (spec). */
export const HUD_REFERENCE_VIEWPORT_W = 1280;
export const HUD_REFERENCE_VIEWPORT_H = 720;

/** Frame-monitor category name for HUD work timing (TASK-57). */
export const HUD_FRAME_CATEGORY = "hud";

/** HUD work budget per frame, ms (spec: < 1 ms/frame). */
export const HUD_FRAME_BUDGET_MS = 1;

/**
 * HUD state cadence in ms. The HUD reads the 10 Hz snapshot
 * cadence: state-driven React updates land at most 10×/s, and the
 * only per-frame work is the target-box projection.
 */
export const HUD_STATE_POLL_MS = 100;

/** A viewport-relative rectangle in CSS pixels. */
export interface HudRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** The combat HUD regions. */
export type CombatHudSlot = "killFeed" | "targetBox" | "weaponReadout" | "threatPing";

/**
 * The ship HUD regions (TASK-51) — speed / altitude / regime sit
 * below the player list, the vitals bar slots above the chat log
 * (under it on the column), and the nav readout floats near the
 * chart button so the chevron points to the chart selection.
 */
export type ShipHudSlot =
  "speedReadout" | "altitudeReadout" | "regimeTag" | "dockedTag" | "vitalsBar" | "navReadout";

/** Non-combat regions the combat HUD must not cover. */
export type ReservedHudSlot = "prompt" | "playerList" | "chat" | "debug" | "weightBar" | "header";

/** Every region name the layout test reasons about. */
export type HudSlotName = CombatHudSlot | ShipHudSlot | ReservedHudSlot;

/** Resolved layout at a viewport size. */
export type HudLayout = Readonly<Record<HudSlotName, HudRect>>;

/** Target box is anchored right-of-center, 1/3 in from the edge. */
export const TARGET_BOX_ANCHOR_X_RATIO = 2 / 3;

/** Every slot's size at the reference viewport. */
const SIZES: Readonly<Record<HudSlotName, { width: number; height: number }>> = {
  killFeed: { width: 320, height: 140 },
  targetBox: { width: 180, height: 90 },
  weaponReadout: { width: 360, height: 96 },
  threatPing: {
    width: HUD_REFERENCE_VIEWPORT_W,
    height: HUD_REFERENCE_VIEWPORT_H,
  },
  // Ship HUD (TASK-51):
  speedReadout: { width: 220, height: 30 },
  altitudeReadout: { width: 160, height: 22 },
  regimeTag: { width: 88, height: 20 },
  dockedTag: { width: 220, height: 28 },
  vitalsBar: { width: VITALS_BAR_WIDTH_PX, height: VITALS_BAR_HEIGHT_PX },
  navReadout: { width: 220, height: 44 },
  // Reserved (non-combat) regions.
  prompt: { width: 420, height: 44 },
  playerList: { width: 240, height: 220 },
  chat: { width: 320, height: 200 },
  debug: { width: 260, height: 200 },
  weightBar: { width: 180, height: 56 },
  header: { width: 320, height: 40 },
};

/** Vertical offset of the speed readout above the player-list top. */
const SPEED_READOUT_OFFSET_PX = 110;

/** Vertical gap between the chat log and the vitals bar. */
const VITALS_BAR_CHAT_GAP_PX = 8;

/**
 * Resolve every slot for a viewport. Sizes are fixed pixels; the
 * offsets are viewport-relative so the HUD scales between window
 * sizes without re-flowing the regions onto each other.
 *
 * The threat ping is the full-viewport overlay (the wedge is drawn
 * at its centre and rotated to the bearing) — it is excluded from
 * the disjointness pair set because an edge-anchored indicator is
 * *meant* to touch the frame.
 */
export function hudSlots(
  w: number = HUD_REFERENCE_VIEWPORT_W,
  h: number = HUD_REFERENCE_VIEWPORT_H,
): HudLayout {
  const centeredX = (width: number): number => Math.round((w - width) / 2);
  const chatTopPx = 72;
  const playerListTopPx = Math.round(h - SIZES.playerList.height - 16);
  return {
    killFeed: { left: centeredX(SIZES.killFeed.width), top: 8, ...SIZES.killFeed },
    targetBox: {
      left: Math.round(w * TARGET_BOX_ANCHOR_X_RATIO - SIZES.targetBox.width / 2),
      top: Math.round(h * 0.32),
      ...SIZES.targetBox,
    },
    weaponReadout: {
      left: centeredX(SIZES.weaponReadout.width),
      top: Math.round(h - SIZES.weaponReadout.height - 84),
      ...SIZES.weaponReadout,
    },
    threatPing: { left: 0, top: 0, ...SIZES.threatPing },
    // Ship HUD (TASK-51) — speeds cluster left of the chart button:
    speedReadout: {
      left: 16,
      top: playerListTopPx - SPEED_READOUT_OFFSET_PX,
      ...SIZES.speedReadout,
    },
    altitudeReadout: {
      left: 16,
      top: playerListTopPx - SPEED_READOUT_OFFSET_PX + 34,
      ...SIZES.altitudeReadout,
    },
    regimeTag: {
      left: 16,
      top: playerListTopPx - SPEED_READOUT_OFFSET_PX + 60,
      ...SIZES.regimeTag,
    },
    dockedTag: {
      left: 16,
      top: 60,
      ...SIZES.dockedTag,
    },
    vitalsBar: {
      left: 16,
      top: chatTopPx + SIZES.chat.height + VITALS_BAR_CHAT_GAP_PX,
      ...SIZES.vitalsBar,
    },
    navReadout: {
      left: Math.round(w - SIZES.navReadout.width - 16),
      top: 60,
      ...SIZES.navReadout,
    },
    // Reserved (non-combat) regions.
    prompt: {
      left: centeredX(SIZES.prompt.width),
      top: Math.round(h - SIZES.prompt.height - 20),
      ...SIZES.prompt,
    },
    playerList: {
      left: 16,
      top: playerListTopPx,
      ...SIZES.playerList,
    },
    chat: { left: 16, top: chatTopPx, ...SIZES.chat },
    debug: { left: w - SIZES.debug.width - 16, top: 16, ...SIZES.debug },
    weightBar: {
      left: w - SIZES.weightBar.width - 16,
      top: Math.round(h - SIZES.weightBar.height - 16),
      ...SIZES.weightBar,
    },
    header: { left: 16, top: 16, ...SIZES.header },
  };
}

/** Slots that must never overlap each other (the acceptance test). */
export const HUD_DISJOINT_SLOTS: readonly HudSlotName[] = [
  "killFeed",
  "targetBox",
  "weaponReadout",
  "prompt",
  "playerList",
  "chat",
  "debug",
  "speedReadout",
  "altitudeReadout",
  "regimeTag",
  "vitalsBar",
];

/** Do two rects share any area? Touching edges do **not** count. */
export function rectsOverlap(a: HudRect, b: HudRect): boolean {
  return (
    a.left < b.left + b.width &&
    b.left < a.left + a.width &&
    a.top < b.top + b.height &&
    b.top < a.top + a.height
  );
}

/**
 * Resolve the default camera FOV constant so the projection and
 * the layout agree on one number (the layout test pins it).
 */
export const HUD_CAMERA_FOV_DEG = FOV_DEG;
