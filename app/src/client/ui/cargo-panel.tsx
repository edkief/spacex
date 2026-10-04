import React from 'react';

import type { ResourceId } from '@shared/inventory';
import type { Livery } from '@shared/ships';
import {
  cargoPanel,
  cargoPanelSubscribe,
  type CargoPanelState,
} from '@client/state/cargo';
import { ShipPanel, type PanelShipView } from '@client/ui/ship-panel';

/**
 * Cargo panel (TASK-39, re-shelled in TASK-53) — the shared ShipPanel in
 * its CARGO mode. Driven by state/cargo (the server's per-connection
 * 'cargo' frame — the panel re-renders from it after every
 * 'cargo_transfer'); the stack columns are the ShipPanel's Cargo tab (the
 * ONE panel component — the dock panel and this one share it).
 *
 * The panel never talks to the server itself: it only calls onMove
 * (main.tsx sends the 'cargo_transfer' frame — the one-dispatch-site
 * pattern) and onRepair / onLivery (the REST actions, main.tsx owns the
 * fetch). Esc or the close button pops it off the menu stack (main.tsx).
 */

export interface CargoPanelProps {
  /** Send a 'cargo_transfer' frame (the Cargo tab's only server contact). */
  onMove: (resourceId: ResourceId, amount: number, from: 'inv' | 'hold') => void;
  onRepair: () => void;
  onLivery: (colors: Livery) => void;
  repairMessage: string | null;
  onClose: () => void;
  ship: PanelShipView;
  /** The player's ship is docked (the Repair gate + the 'docked' context). */
  docked: boolean;
  /** The credit balance (the panel footer context; null = hidden). */
  balance: number | null;
}

/** The panel's React view (subscribed — re-renders only on real changes). */
function useCargoPanel(): CargoPanelState {
  const [state, setState] = React.useState(cargoPanel); // lazy init: current
  React.useEffect(() => cargoPanelSubscribe(setState), []);
  return state;
}

export function CargoPanel(props: CargoPanelProps): React.ReactElement | null {
  const state = useCargoPanel();
  // Esc closes via the global menu-stack handler in main.tsx (typing in an
  // input — chat — never does); the store close is paired with the pop.
  if (!state.open || !state.hold) return null;
  return (
    <ShipPanel
      id="cargo-panel"
      title="CARGO"
      context={props.docked ? 'docked' : 'flight'}
      activeTab="cargo"
      ship={props.ship}
      docked={props.docked}
      hold={state.hold}
      inventory={state.inventory}
      balance={props.balance}
      onMove={props.onMove}
      onRepair={props.onRepair}
      onLivery={props.onLivery}
      repairMessage={props.repairMessage}
      onClose={props.onClose}
    />
  );
}
