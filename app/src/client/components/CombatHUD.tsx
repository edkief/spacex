/**
 * CombatHUD — TASK-50 assembly.
 *
 * The four combat-facing regions in their fixed layout slots:
 *
 *   | region        | slot          | source                    |
 *   |---------------|---------------|---------------------------|
 *   | kill feed     | top-center    | TASK-47 `KillFeedStore`   |
 *   | target box    | right-of-center (world-anchored) | TASK-44 `TargetingStore` |
 *   | weapon/energy | bottom-center | TASK-43 `weapon_state`    |
 *   | threat ping   | screen edge   | TASK-44 `threatPings`     |
 *
 * Layout discipline is enforced by `combat/hud/layout.ts`:
 * `hudSlots()` is the single source of truth for every slot, and
 * the disjointness test asserts the combat regions never overlap
 * the prompt line, the player list, the chat or the debug overlay.
 *
 * The HUD is DOM (not canvas) so it stays accessible and so the
 * layout is testable with `getBoundingClientRect`.
 */

import type * as React from "react";

import type { KillFeedStore } from "../combat/killFeed.js";
import type { TargetingStore } from "../combat/targeting.js";
import type { ShipClassId } from "@shared/ships.js";
import type { WeaponId } from "@shared/weapons.js";
import { HUD_STATE_POLL_MS, hudSlots } from "../combat/hud/layout.js";
import type { FrameMonitor } from "../perf/frameMonitor.js";
import { KillFeed } from "./KillFeed.js";
import { TargetBox, type TargetBoxSource } from "./TargetBox.js";
import { ThreatPingHud } from "./ThreatPingHud.js";
import { WeaponReadout } from "./WeaponReadout.js";
import type { WeaponStateSnapshot } from "./WeaponHud.js";

/** Props for the assembled combat HUD. */
export interface CombatHUDProps {
  /** Targeting store (target box + threat ping). */
  targeting: TargetingStore;
  /** Kill-feed store (top-center). */
  killFeed: KillFeedStore;
  /** Live weapon state snapshot (null mid-handshake). */
  weaponState: WeaponStateSnapshot | null;
  /** World-space sampler for the target box. */
  targetSource: TargetBoxSource;
  /** Own ship class id (drives the weapon-selector counts). */
  classId?: ShipClassId | null;
  /** Rounds left on the missile weapon. */
  missilesLeft?: number | null;
  /** Weapon-slot click handler. */
  onSelectWeapon?: (weapon: WeaponId) => void;
  /** Frame monitor for the `hud` budget check. */
  monitor?: FrameMonitor | null;
  /** e2e seam — force the target box's screen position. */
  targetScreenOverride?: { x: number; y: number } | null;
  /** Test seam — fixed clock for the threat ping. */
  nowMs?: number;
}

/**
 * Assemble the four combat regions. Mounted by `App.tsx`; each
 * region owns its own slot geometry (sourced from `hudSlots`).
 */
export function CombatHUD(props: CombatHUDProps): React.JSX.Element {
  const killFeedRect = hudSlots().killFeed;
  return (
    <div data-testid="drift-combat-hud" data-poll-ms={HUD_STATE_POLL_MS}>
      {/* Kill feed — top-center. `KillFeed` hides itself when the
          feed is empty, so the slot stays free during calm flight. */}
      <div
        data-testid="drift-hud-slot-killFeed"
        data-slot="killFeed"
        style={{
          position: "fixed",
          left: killFeedRect.left,
          top: killFeedRect.top,
          width: killFeedRect.width,
          pointerEvents: "none",
        }}
      >
        <KillFeed store={props.killFeed} topPx={0} />
      </div>
      <TargetBox
        store={props.targeting}
        source={props.targetSource}
        monitor={props.monitor ?? null}
        screenOverride={props.targetScreenOverride ?? null}
      />
      <WeaponReadout
        state={props.weaponState}
        classId={props.classId ?? null}
        missilesLeft={props.missilesLeft ?? null}
        onSelect={props.onSelectWeapon}
      />
      <ThreatPingHud store={props.targeting} monitor={props.monitor ?? null} nowMs={props.nowMs} />
    </div>
  );
}
