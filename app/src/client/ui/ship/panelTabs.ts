/**
 * Ship panel tab model — TASK-53.
 *
 * The dock panel and the ship panel are ONE component with a
 * context-driven tab set:
 *
 *   - `docked-ship`  → Overview / Cargo / Repair
 *   - `in-flight`    → Overview / Cargo
 *   - `on-foot-dock` → Overview / Cargo / Sell
 *
 * The tab-set test enforces this so the dock UI and the ship UI
 * cannot drift apart.
 */

/** Where the panel was opened from. */
export type ShipPanelContext = "docked-ship" | "in-flight" | "on-foot-dock";

/** Every tab id the panel knows about. */
export type ShipPanelTabId = "overview" | "cargo" | "repair" | "sell";

/** Display labels for the tabs. */
export const SHIP_PANEL_TAB_LABELS: Readonly<Record<ShipPanelTabId, string>> = {
  overview: "Overview",
  cargo: "Cargo",
  repair: "Repair",
  sell: "Sell",
};

/**
 * The tabs available in a given context. The array order is the
 * display order (left → right).
 */
export function tabsForContext(context: ShipPanelContext): readonly ShipPanelTabId[] {
  switch (context) {
    case "docked-ship":
      return ["overview", "cargo", "repair"];
    case "in-flight":
      return ["overview", "cargo"];
    case "on-foot-dock":
      return ["overview", "cargo", "sell"];
  }
}

/**
 * The tab that is active when the panel opens. The dock context
 * opens on `Sell` (the player pressed `E` on a market terminal);
 * every other context opens on `Overview`.
 */
export function defaultTabForContext(context: ShipPanelContext): ShipPanelTabId {
  return context === "on-foot-dock" ? "sell" : "overview";
}

/**
 * Move the active tab by `delta` inside the context's tab list,
 * wrapping at both ends. Arrow keys use this.
 */
export function cycleTab(
  tabs: readonly ShipPanelTabId[],
  active: ShipPanelTabId,
  delta: 1 | -1,
): ShipPanelTabId {
  if (tabs.length === 0) return active;
  const index = tabs.indexOf(active);
  const next = index === -1 ? 0 : (index + delta + tabs.length) % tabs.length;
  return tabs[next] ?? active;
}
