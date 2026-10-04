import React from 'react';

import { type Viewport } from '@client/ui/combat-hud/layout';
import { DockedIndicator } from '@client/ui/docked-indicator';
import { LeaveShipPrompt } from '@client/ui/leave-ship-prompt';
import { ExposureMeter } from '@client/ui/on-foot-hud/exposure-meter';
import { InteractionLine } from '@client/ui/on-foot-hud/interaction-line';
import { type NavSample } from '@client/ui/ship-hud/nav-readout';
import { ShipHud } from '@client/ui/ship-hud/ship-hud';
import { WeightBar } from '@client/ui/weight-bar';

/**
 * The HUD mode switch (TASK-52) — the ONE root that renders EITHER the ship
 * HUD subtree (flight readouts + docked/leave-ship prompts + cargo button)
 * OR the on-foot HUD subtree (exposure meter + weight bar + interaction
 * line), NEVER both.
 *
 * The mode is the player's ACTIVE ENTITY kind (the server's self
 * entity_update: kind 'ship' = in the cockpit, kind 'character' + onFoot =
 * on foot) — a single source of truth set by main.tsx at the SAME event as
 * the camera handoff (TASK-27), so the switch is atomic: no lingering
 * elements from the other mode, no overlap with the handoff.
 */

/** The HUD mode (null = boot / no self entity yet). */
export type HudMode = 'ship' | 'onfoot' | null;

/** The ship subtree's props (forwarded verbatim to ShipHud). */
export interface ShipHudAreaProps {
  viewport: Viewport;
  navSample: () => NavSample | null;
  dockTarget: () => { name: string; pos: { x: number; y: number; z: number } } | null;
  stationName: (padId: string) => string | null;
  /** Opens the cargo panel (the in-ship 'CARGO' button's 'cargo_open' frame). */
  onCargoOpen: () => void;
}

/** The ship-mode subtree (TASK-51 flight HUD + docked/leave prompts + cargo). */
export function ShipHudArea(props: ShipHudAreaProps): React.ReactElement {
  return (
    <>
      <ShipHud
        viewport={props.viewport}
        navSample={props.navSample}
        dockTarget={props.dockTarget}
        stationName={props.stationName}
      />
      <DockedIndicator />
      <LeaveShipPrompt />
      <button
        id="ship-hud-cargo"
        type="button"
        onClick={props.onCargoOpen}
        style={{
          position: 'fixed',
          bottom: '2rem',
          right: '6.5rem', // left of the weight bar's slot
          zIndex: 85,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: '0.7rem',
          letterSpacing: '0.08em',
          color: '#9fb0c3',
          background: 'rgba(15, 20, 28, 0.8)',
          border: '1px solid #2c3a4d',
          borderRadius: '4px',
          padding: '0.35rem 0.6rem',
          cursor: 'pointer',
        }}
      >
        CARGO
      </button>
    </>
  );
}

/** The on-foot subtree (exposure meter + weight bar + interaction line). */
export function OnFootHud({ promptText }: { promptText: string | null }): React.ReactElement {
  return (
    <>
      <ExposureMeter />
      <WeightBar />
      <InteractionLine text={promptText} />
    </>
  );
}

export interface HudRootProps extends ShipHudAreaProps {
  /** The HUD mode (the player's active entity kind). */
  mode: HudMode;
  /** The single on-foot prompt line (the interaction raycast's target). */
  promptText: string | null;
}

/** The switch itself: exactly one subtree renders, never both. */
export function HudRoot(props: HudRootProps): React.ReactElement | null {
  if (props.mode === 'ship') {
    return <ShipHudArea {...props} />;
  }
  if (props.mode === 'onfoot') {
    return <OnFootHud promptText={props.promptText} />;
  }
  return null;
}
