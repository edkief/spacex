/**
 * InteractionLine — TASK-52 on-foot HUD.
 *
 * The bottom-centre "interaction line" is the on-foot counterpart
 * of the ship HUD's nav readout: a single prompt slot that shows
 * *one* affordance at a time, plus the mining radial that
 * surrounds it while the player holds E on a deposit.
 *
 * Assembly:
 *
 *   - `<InteractionPrompt>` (TASK-33) — the existing cone-raycast
 *     prompt. It owns the `(targetId, action)` resolution and the
 *     nearest-wins exclusivity via `promptForTarget(...)`.
 *   - `<RadialMiningProgress>` (TASK-38) — the conic-gradient ring
 *     with server-timed radial + "+1 iron" float text. We feed it
 *     the live `mining_update` echo through `useMiningState`.
 *   - When the prompt is **null** (nothing is in range) the line
 *     hides entirely — the only signal the player gets is the
 *     floating "+1 iron" affordance when the channel awards.
 *     When a channel is active, the prompt reads "[E] Mine (hold)"
 *     and the radial wraps the kbd badge.
 *
 * Both children are mounted unconditionally with their own
 * `enabled` props; the children themselves hide when no input
 * is relevant (`InteractionPrompt` returns null on no target,
 * `RadialMiningProgress` returns null on no update).
 */
import { useEffect, useState } from "react";
import type * as React from "react";

import type { DriftClient } from "../net/wsClient.js";
import { InteractionPrompt, type InteractionPromptProps } from "./InteractionPrompt.js";
import { RadialMiningProgress, type RadialMiningProgressProps } from "./RadialMiningProgress.js";
import type { MiningUpdate } from "./useMiningState.js";

export interface InteractionLineProps {
  /** Same as `InteractionPrompt.interactor`. */
  interactor: InteractionPromptProps["interactor"];
  /** Same as `InteractionPrompt.interactables`. */
  interactables: InteractionPromptProps["interactables"];
  /** Same as `InteractionPrompt.onInteract`. */
  onInteract: InteractionPromptProps["onInteract"];
  /** Same as `InteractionPrompt.onEnter`. */
  onEnter?: InteractionPromptProps["onEnter"];
  /** Same as `InteractionPrompt.onMineStart`. */
  onMineStart?: InteractionPromptProps["onMineStart"];
  /** Same as `InteractionPrompt.onMineStop`. */
  onMineStop?: InteractionPromptProps["onMineStop"];
  /** True while the WS is online. */
  enabled: boolean;
  /** Optional InteractionPrompt registry override. */
  registry?: InteractionPromptProps["registry"];
}

/** Live mining echo + the timestamp the radial interpolates from. */
interface MiningSlot {
  update: MiningUpdate;
  receivedAtMs: number;
}

/**
 * Bottom-centre interaction line. Returns `null` when the prompt
 * is hidden AND no mining update is active — the spec says
 * "hidden when nothing is in range". The two children are always
 * mounted with their own hide-rules so this component stays a
 * thin composition.
 */
export function InteractionLine(props: InteractionLineProps): React.JSX.Element | null {
  const mining = useMiningFromGlobal();
  return (
    <div
      data-testid="drift-interaction-line"
      data-mining-state={mining?.update.state ?? "idle"}
      style={{
        position: "absolute",
        left: "50%",
        bottom: 116,
        transform: "translateX(-50%)",
        zIndex: 940,
        pointerEvents: "none",
      }}
    >
      <InteractionPrompt
        interactor={props.interactor}
        interactables={props.interactables}
        onInteract={props.onInteract}
        onEnter={props.onEnter}
        onMineStart={props.onMineStart}
        onMineStop={props.onMineStop}
        enabled={props.enabled}
        registry={props.registry}
      />
      {mining && props.enabled ? (
        <RadialMiningProgress update={mining.update} receivedAtMs={mining.receivedAtMs} enabled />
      ) : null}
    </div>
  );
}

/** Avoid lint: `RadialMiningProgressProps` is referenced by the JSX. */
export type _RadialMiningProgressProps = RadialMiningProgressProps;

/**
 * Subscribe to the global `__driftClient.onMiningUpdate(...)` seam
 * so the line doesn't require the host to thread the client down.
 * Returns `null` until the first echo lands or the client mounts.
 *
 * Kept intentionally small — the radial owns the rAF interpolation
 * between echoes (this hook doesn't manage any timing).
 */
function useMiningFromGlobal(): MiningSlot | null {
  const [slot, setSlot] = useState<MiningSlot | null>(null);
  useEffect(() => {
    let unsub: (() => void) | null = null;
    let cancelled = false;
    const tryAttach = (): boolean => {
      const w = window as unknown as {
        __driftClient?: { onMiningUpdate?: DriftClient["onMiningUpdate"] };
      };
      const onMining = w.__driftClient?.onMiningUpdate;
      if (!onMining) return false;
      unsub = onMining.call(w.__driftClient, (payload) => {
        if (cancelled) return;
        setSlot({ update: payload, receivedAtMs: performance.now() });
      });
      return true;
    };
    if (!tryAttach()) {
      const id = window.setInterval(() => {
        if (cancelled) return;
        if (tryAttach()) window.clearInterval(id);
      }, 250);
      return () => {
        cancelled = true;
        window.clearInterval(id);
        if (unsub) unsub();
      };
    }
    return () => {
      cancelled = true;
      if (unsub) unsub();
    };
  }, []);
  return slot;
}
