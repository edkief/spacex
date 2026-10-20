/**
 * MenuPanel — TASK-53 the ESC menu.
 *
 * A centred panel with the four navigation items (Resume /
 * Systems / Ships / Settings) plus a footer with the player's
 * callsign and credit balance.
 *
 * Keyboard-first:
 *   - `Tab` cycles inside the panel (focus is trapped),
 *   - `ArrowUp` / `ArrowDown` move between items,
 *   - `Enter` activates the focused item (native button behaviour),
 *   - `ESC` is owned by the shell (it pops one level).
 *
 * The menu does NOT pause the world — the player can still be shot
 * while it is open. That is by design (multiplayer).
 */
import { useCallback, useEffect, useRef } from "react";
import type * as React from "react";

import { cycleFocus } from "./focusTrap.js";
import { useMenuShell } from "./MenuShell.js";
import { MENU_ITEM_IDS, type MenuItemId } from "./menuStack.js";

/** Display metadata for each menu item. */
const ITEM_LABELS: Readonly<Record<MenuItemId, string>> = {
  resume: "Resume",
  systems: "Systems",
  ships: "Ships",
  settings: "Settings",
};

/** Props for the menu panel. */
export interface MenuPanelProps {
  /** Player callsign (shown in the footer). */
  callsign: string | null;
  /** Current credit balance (shown in the footer). */
  credits: number;
  /** Called with the activated item id. */
  onSelect: (item: MenuItemId) => void;
}

/**
 * The ESC menu surface. Mounted by the host while the `menu`
 * surface is on the stack.
 */
export function MenuPanel({ callsign, credits, onSelect }: MenuPanelProps): React.JSX.Element {
  const shell = useMenuShell();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Tell the shell which node owns the keyboard while the menu is
  // open — every other key is swallowed by the input gate.
  useEffect(() => {
    shell.registerPanel(panelRef.current);
    return () => shell.registerPanel(null);
  }, [shell.registerPanel]);

  // Focus the first item when the panel mounts so the keyboard
  // flow starts inside the surface.
  useEffect(() => {
    itemRefs.current[0]?.focus();
  }, []);

  const moveFocus = useCallback((direction: 1 | -1) => {
    const items = itemRefs.current.filter((el): el is HTMLButtonElement => el !== null);
    if (items.length === 0) return;
    const active = document.activeElement;
    const index = active instanceof HTMLButtonElement ? items.indexOf(active) : -1;
    const next = index === -1 ? 0 : (index + direction + items.length) % items.length;
    items[next]?.focus();
  }, []);

  const onKeyDown = useCallback(
    (ev: React.KeyboardEvent<HTMLDivElement>) => {
      if (ev.key === "Tab") {
        // Trap the focus inside the panel.
        ev.preventDefault();
        cycleFocus(panelRef.current, ev.shiftKey ? -1 : 1);
        return;
      }
      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        moveFocus(1);
        return;
      }
      if (ev.key === "ArrowUp") {
        ev.preventDefault();
        moveFocus(-1);
      }
    },
    [moveFocus],
  );

  return (
    <div
      data-testid="drift-menu-backdrop"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(5,6,12,0.72)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 80,
        fontFamily: "system-ui, sans-serif",
        color: "#e6edf3",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onSelect("resume");
      }}
    >
      <div
        ref={panelRef}
        data-testid="drift-menu-panel"
        role="dialog"
        aria-label="Game menu"
        onKeyDown={onKeyDown}
        style={{
          width: 320,
          background: "#0b1018",
          border: "1px solid rgba(255,255,255,0.15)",
          padding: 16,
          fontFamily: "monospace",
          fontSize: 12,
          boxShadow: "0 20px 60px rgba(0,0,0,0.55)",
        }}
      >
        <div
          style={{
            fontSize: 13,
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            marginBottom: 12,
          }}
        >
          Drift menu
        </div>
        <nav
          role="menu"
          aria-label="Menu items"
          style={{ display: "flex", flexDirection: "column", gap: 4 }}
        >
          {MENU_ITEM_IDS.map((id, index) => (
            <button
              key={id}
              ref={(el) => {
                itemRefs.current[index] = el;
              }}
              type="button"
              role="menuitem"
              data-testid={`drift-menu-${id}`}
              onClick={() => onSelect(id)}
              style={menuButtonStyle}
            >
              {ITEM_LABELS[id]}
            </button>
          ))}
        </nav>
        <div
          data-testid="drift-menu-footer"
          style={{
            marginTop: 14,
            paddingTop: 10,
            borderTop: "1px solid rgba(255,255,255,0.12)",
            display: "flex",
            justifyContent: "space-between",
            fontSize: 11,
          }}
        >
          <span data-testid="drift-menu-callsign">{callsign ?? "—"}</span>
          <span data-testid="drift-menu-credits">{credits.toLocaleString()} cr</span>
        </div>
        <p style={{ marginTop: 8, fontSize: 9, opacity: 0.55 }}>
          The world keeps running while the menu is open — this is a live multiplayer system.
        </p>
      </div>
    </div>
  );
}

const menuButtonStyle: React.CSSProperties = {
  background: "transparent",
  border: "1px solid rgba(255,255,255,0.18)",
  color: "#e6edf3",
  padding: "8px 12px",
  cursor: "pointer",
  fontFamily: "monospace",
  fontSize: 12,
  letterSpacing: "0.12em",
  textAlign: "left",
  textTransform: "uppercase",
};
