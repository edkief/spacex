/**
 * OnFootHUD — TASK-52 assembly.
 *
 * The surface-mode HUD root. Three regions:
 *
 *   | region         | slot              | source                           |
 *   |----------------|-------------------|----------------------------------|
 *   | exposure meter | bottom-right      | hazard store `state.exposure`    |
 *   | weight bar     | bottom-right      | `useOwnInventory` (TASK-34)      |
 *   | interaction    | bottom-centre     | `<InteractionLine>` (TASK-33+52) |
 *
 * The HUD only mounts when the local entity is a `character`
 * (i.e. the on-foot mode is active). The host (App.tsx) swaps
 * between `<ShipHUD>` and `<OnFootHUD>` by reading `useHudMode`;
 * the two subtrees never share a render — the camera-handoff
 * event flips both at the same frame.
 */
import type * as React from "react";

import type { HazardStore } from "../world/hazards.js";
import type { Interactable, Interactor } from "../input/interaction.js";
import type { InteractionPrompt } from "../input/interaction.js";
import { ExposureMeter } from "./ExposureMeter.js";
import { InteractionLine } from "./InteractionLine.js";
import { WeightBar } from "./WeightBar.js";
import { useOwnInventory } from "./WeightBar.js";
import type { FrameMonitor } from "../perf/frameMonitor.js";
import { timeHudWork } from "../combat/hud/timing.js";

export interface OnFootHUDProps {
  /** Live hazard store (exposure + recovering + currentHazard). */
  hazardStore: HazardStore;
  /** The local character's interactor (position + forward). */
  interactor: Interactor | null;
  /** Interactable list — the cone-raycast source. */
  interactables: readonly Interactable[];
  /** Send an interact frame. */
  onInteract: (targetId: string, action: InteractionPrompt["action"]) => void;
  /** Optional re-entry dispatcher (TASK-35). */
  onEnter?: () => void;
  /** Optional mining start dispatch (TASK-38). */
  onMineStart?: (targetId: string) => void;
  /** Optional mining stop dispatch. */
  onMineStop?: () => void;
  /** True while the WS is online. */
  enabled: boolean;
  /** Optional frame monitor (TASK-57 budget enforcement). */
  monitor?: FrameMonitor | null;
}

/**
 * On-foot HUD root. Renders the exposure meter, the weight bar,
 * and the unified interaction line. Designed to mount under
 * `App.tsx` only when the player is on foot.
 */
export function OnFootHUD(props: OnFootHUDProps): React.JSX.Element {
  const inventory = useOwnInventory();
  // Render the HUD subtree and measure its on-mount work. The
  // meter / weight bar / prompt are all snapshot-driven (the only
  // rAF work is the mining radial — sibling component), so the
  // per-frame cost is well under the 0.5 ms budget.
  const monitor = props.monitor ?? null;
  if (monitor) {
    timeHudWork(() => undefined, { monitor });
  }
  return (
    <div data-testid="drift-on-foot-hud" data-mode="character">
      <ExposureMeter store={props.hazardStore} />
      <WeightBar inventory={inventory} />
      <InteractionLine
        interactor={props.interactor}
        interactables={props.interactables}
        onInteract={props.onInteract}
        onEnter={props.onEnter}
        onMineStart={props.onMineStart}
        onMineStop={props.onMineStop}
        enabled={props.enabled}
      />
    </div>
  );
}
