/**
 * Dock panel — TASK-53.
 *
 * The dock terminal panel is the SHARED ship panel (`ShipPanel`)
 * in the `on-foot-dock` context: the tab set is Overview / Cargo /
 * Sell and the Sell tab is active when the panel opens (TASK-40).
 *
 * There is deliberately no second implementation of the dock UI —
 * the dock panel and the ship panel are the same component with a
 * different context, so the two cannot drift apart.
 */
import type * as React from "react";

import type { CargoHold } from "@shared/world/cargo.js";
import type { Inventory } from "@shared/world/inventory.js";

import type { DriftClient } from "../net/wsClient.js";
import { ShipPanel } from "../ui/ship/ShipPanel.js";
import type { ShipInfo } from "../ui/ship/shipApi.js";

/** Props for the dock panel. */
export interface DockPanelProps {
  client: DriftClient | null;
  inventory: Inventory | null;
  cargo: CargoHold | null;
  /** Latest known credit balance; rendered in the right rail. */
  balance: number;
  open: boolean;
  onClose: () => void;
  /** Pre-loaded ship row (the panel fetches it when omitted). */
  ship?: ShipInfo | null;
  /** Bearer token for the livery / repair endpoints. */
  authToken?: string | null;
  /** Current weapon energy (rendered on the Overview tab). */
  energy?: number | null;
  /** Called when the balance changes (after a repair). */
  onBalanceChange?: (balance: number) => void;
}

/**
 * The dock terminal panel (TASK-40 sell tab + TASK-53 shared shell).
 */
export function DockPanel({
  client,
  inventory,
  cargo,
  balance,
  open,
  onClose,
  ship,
  authToken,
  energy,
  onBalanceChange,
}: DockPanelProps): React.JSX.Element | null {
  return (
    <ShipPanel
      client={client}
      context="on-foot-dock"
      open={open}
      onClose={onClose}
      inventory={inventory}
      cargo={cargo}
      balance={balance}
      ship={ship}
      authToken={authToken}
      energy={energy}
      testId="drift-dock-panel"
      onBalanceChange={onBalanceChange}
    />
  );
}
