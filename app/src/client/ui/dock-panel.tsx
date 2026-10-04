import React from 'react';

import type { ResourceId } from '@shared/inventory';
import type { Livery } from '@shared/ships';
import { dockPanel, dockPanelSubscribe, type DockPanelState } from '@client/state/dock';
import { ShipPanel, type PanelShipView } from '@client/ui/ship-panel';

/**
 * Dock panel (TASK-40, re-shelled in TASK-53) — the shared ShipPanel in
 * its DOCK mode: the same tab shell as the ship panel with the SELL tab
 * active by default (OVERVIEW / CARGO / SELL — the context-driven tab
 * set, ONE component, no duplicated panel code).
 *
 * Opened by the server's 'ui-open' {ui:'dock'} frame (the terminal
 * interaction — hold + inventory ride the payload, so the Sell tab
 * renders sellable amounts immediately). The Sell tab is driven by the
 * 'sell' result frames (the source stack decreases, the balance updates
 * within one frame). The panel never talks to the server itself: it only
 * calls onSell (main.tsx sends the 'sell' frame — the one-dispatch-site
 * pattern of the cargo panel). Esc / the close button pop it off the
 * menu stack (main.tsx).
 */

export interface DockPanelProps {
  /** Send a 'sell' frame (the Sell tab's only server contact). */
  onSell: (resourceId: ResourceId, amount: number, source: 'hold' | 'inv') => void;
  /** Send a 'cargo_transfer' frame (the embedded Cargo tab). */
  onMove: (resourceId: ResourceId, amount: number, from: 'inv' | 'hold') => void;
  onRepair: () => void;
  onLivery: (colors: Livery) => void;
  repairMessage: string | null;
  onClose: () => void;
  ship: PanelShipView;
  /** The player's ship is docked (the Repair gate — usually true here). */
  docked: boolean;
}

function useDockPanel(): DockPanelState {
  const [state, setState] = React.useState(dockPanel); // lazy init: current
  React.useEffect(() => dockPanelSubscribe(setState), []);
  return state;
}

export function DockPanel(props: DockPanelProps): React.ReactElement | null {
  const state = useDockPanel();
  // Esc closes via the global menu-stack handler in main.tsx (typing in an
  // input — chat — never does); the store close is paired with the pop.
  if (!state.open) return null;
  return (
    <ShipPanel
      id="dock-panel"
      title="STATION DOCK"
      context="dock"
      activeTab="sell"
      ship={props.ship}
      docked={props.docked}
      hold={state.hold}
      inventory={state.inventory}
      balance={state.balance}
      onMove={props.onMove}
      onSell={props.onSell}
      onRepair={props.onRepair}
      onLivery={props.onLivery}
      repairMessage={props.repairMessage}
      onClose={props.onClose}
    />
  );
}
