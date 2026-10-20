/**
 * ShipPanel — TASK-53 the shared ship / dock panel.
 *
 * ONE component serves both surfaces:
 *
 *   - the ship panel (opened from the ESC menu or the ship HUD's
 *     Cargo button) — `docked-ship` / `in-flight` contexts,
 *   - the dock panel (opened from the on-foot dock terminal) —
 *     `on-foot-dock` context, with the Sell tab (TASK-40).
 *
 * The tab set is context-driven (see `panelTabs.ts`) so the two
 * surfaces cannot drift apart.
 *
 * Keyboard-first: `Tab` cycles inside the panel, `ArrowLeft` /
 * `ArrowRight` switch tabs, `ESC` backs out one level (handled by
 * the menu shell — the panel pops the shell stack).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type * as React from "react";

import { CARGO_RESOURCE_TYPES, type CargoHold } from "@shared/world/cargo.js";
import type { Inventory } from "@shared/world/inventory.js";
import { RESOURCE_CATALOG, type ResourceId } from "@shared/resources.js";

import type { DriftClient } from "../../net/wsClient.js";
import { useOptionalMenuShell } from "../menu/MenuShell.js";
import { createLiverySaver, type LiveryColors } from "./livery.js";
import {
  defaultTabForContext,
  tabsForContext,
  type ShipPanelContext,
  type ShipPanelTabId,
} from "./panelTabs.js";
import { DockRail } from "./DockRail.js";
import { OverviewTab } from "./OverviewTab.js";
import { PanelShell } from "./PanelShell.js";
import { RepairTab } from "./RepairTab.js";
import { SellTab, type SellRow } from "./SellTab.js";
import { fetchShip, repairShip, saveLivery, type ShipInfo } from "./shipApi.js";
import { CargoTransferView } from "./CargoTransferView.js";

/** Props for the shared panel. */
export interface ShipPanelProps {
  /** Drift client (used for the `sell` frames). */
  client: DriftClient | null;
  /** Which context the panel was opened in. */
  context: ShipPanelContext;
  /** Whether the panel is open. */
  open: boolean;
  /** Close callback. */
  onClose: () => void;
  /** On-foot inventory (TASK-34). */
  inventory: Inventory | null;
  /** Ship cargo hold (TASK-39). */
  cargo: CargoHold | null;
  /** Current credit balance. */
  balance: number;
  /** Pre-loaded ship row (tests inject one; otherwise it is fetched). */
  ship?: ShipInfo | null;
  /** Current weapon energy (`null` when unknown). */
  energy?: number | null;
  /** Bearer token for the REST endpoints (livery + repair). */
  authToken?: string | null;
  /** Test-id prefix for the DOM (the dock panel uses `drift-dock-panel`). */
  testId?: string;
  /** Called when the balance changes (after a repair). */
  onBalanceChange?: (balance: number) => void;
}

/** Floating "+N cr" lifetime in ms. */
const FLOAT_LIFETIME_MS = 1000;

/** Maximum floating texts on screen at once. */
const MAX_FLOATS = 5;

/**
 * The shared ship / dock panel.
 */
export function ShipPanel({
  client,
  context,
  open,
  onClose,
  inventory,
  cargo,
  balance,
  ship: shipProp,
  energy = null,
  authToken = null,
  testId = "drift-ship-panel",
  onBalanceChange,
}: ShipPanelProps): React.JSX.Element | null {
  const shell = useOptionalMenuShell();
  const tabs = useMemo(() => tabsForContext(context), [context]);
  const [tab, setTab] = useState<ShipPanelTabId>(defaultTabForContext(context));
  const [ship, setShip] = useState<ShipInfo | null>(shipProp ?? null);
  const [floats, setFloats] = useState<readonly { id: number; text: string }[]>([]);
  const [log, setLog] = useState<readonly { id: number; text: string }[]>([]);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Reset the active tab when the context changes (dock → ship).
  useEffect(() => {
    setTab(defaultTabForContext(context));
  }, [context]);

  // Keep the local ship row in sync with an injected prop.
  useEffect(() => {
    if (shipProp !== undefined) setShip(shipProp);
  }, [shipProp]);

  // Register the panel node with the menu shell so the input gate
  // knows which keys the panel handles itself. The callback ref
  // fires on mount AND on unmount, so the registration always
  // matches the rendered DOM.
  const setPanelRef = useCallback(
    (node: HTMLDivElement | null) => {
      panelRef.current = node;
      shell?.registerPanel(node);
    },
    [shell],
  );

  // Standalone fallback: when the panel is rendered outside the menu
  // shell (e.g. a host that mounts it directly), `ESC` closes it.
  useEffect(() => {
    if (shell !== null) return;
    if (!open) return;
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shell, open, onClose]);

  // Fetch the ship row when the panel opens (skipped when the host
  // injected one — the tests do that).
  useEffect(() => {
    if (!open) return;
    if (shipProp !== undefined) return;
    let cancelled = false;
    void fetchShip(authToken).then((row) => {
      if (cancelled || row === null) return;
      setShip(row);
    });
    return () => {
      cancelled = true;
    };
  }, [open, authToken, shipProp]);

  // `sell_ok` → floating "+N cr" + the recent-sales log.
  useEffect(() => {
    if (client === null) return;
    const unsub = client.onSellOk((payload) => {
      const id = Date.now() + Math.random();
      setFloats((prev) => {
        const next = [...prev, { id, text: `+${payload.earned} cr` }];
        return next.length > MAX_FLOATS ? next.slice(next.length - MAX_FLOATS) : next;
      });
      setLog((prev) => {
        const entry = {
          id,
          text: `${payload.sold} ${payload.resourceType} → +${payload.earned} cr`,
        };
        const next = [entry, ...prev];
        return next.length > 8 ? next.slice(0, 8) : next;
      });
    });
    return () => {
      unsub();
    };
  }, [client]);

  // Reap expired floats.
  useEffect(() => {
    if (floats.length === 0) return;
    const id = window.setInterval(() => {
      setFloats((prev) => prev.slice(1));
    }, FLOAT_LIFETIME_MS);
    return () => window.clearInterval(id);
  }, [floats.length]);

  // Livery saves are debounced by 500 ms so a burst of picker
  // changes collapses into a single request.
  const saverRef = useRef(createLiverySaver({ save: () => undefined }));
  useEffect(() => {
    saverRef.current = createLiverySaver({
      save: (colors) => {
        void saveLivery(authToken, colors).then((row) => {
          if (row !== null) setShip(row);
        });
      },
    });
    return () => saverRef.current.cancel();
  }, [authToken]);

  const onLiveryChange = useCallback((colors: LiveryColors) => {
    setShip((prev) => (prev === null ? prev : { ...prev, livery: colors }));
    saverRef.current.schedule(colors);
  }, []);

  const onRepair = useCallback(async () => {
    const outcome = await repairShip(authToken);
    if (outcome === null) return;
    setShip(outcome.ship);
    onBalanceChange?.(outcome.newBalance);
  }, [authToken, onBalanceChange]);

  const sellRows = useMemo<readonly SellRow[]>(() => {
    return CARGO_RESOURCE_TYPES.map((id) => {
      const invAmount = inventory?.stacks[id] ?? 0;
      const cargoAmount = cargo?.stacks[id] ?? 0;
      return {
        id,
        invAmount,
        cargoAmount,
        total: invAmount + cargoAmount,
        price: RESOURCE_CATALOG[id].basePrice,
      };
    });
  }, [inventory, cargo]);

  if (!open) return null;

  const body = ((): React.JSX.Element => {
    switch (tab) {
      case "overview":
        return (
          <OverviewTab
            ship={ship}
            energy={energy}
            onLiveryChange={onLiveryChange}
            testIdPrefix={testId}
          />
        );
      case "cargo":
        return (
          <CargoTransferView
            client={client}
            inventory={inventory}
            cargo={cargo}
            testIdPrefix={testId}
          />
        );
      case "repair":
        return (
          <RepairTab ship={ship} balance={balance} onRepair={onRepair} testIdPrefix={testId} />
        );
      case "sell":
        return (
          <SellTab
            rows={sellRows}
            onSellOne={(id: ResourceId, amount: number) => client?.sendSell(id, amount)}
            onSellAll={(id: ResourceId, total: number) => {
              if (total <= 0) return;
              client?.sendSell(id, total);
            }}
            canSell={client !== null}
            testIdPrefix={testId}
          />
        );
    }
  })();

  return (
    <PanelShell
      title={context === "on-foot-dock" ? "Dock terminal" : "Ship"}
      testId={testId}
      tabs={tabs}
      activeTab={tab}
      onTab={setTab}
      onClose={onClose}
      panelRef={setPanelRef}
      rail={
        context === "on-foot-dock" ? (
          <DockRail balance={balance} log={log} floats={floats} testIdPrefix={testId} />
        ) : null
      }
    >
      {body}
    </PanelShell>
  );
}
