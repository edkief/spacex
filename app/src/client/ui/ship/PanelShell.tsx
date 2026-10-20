/**
 * Panel shell — TASK-53.
 *
 * The modal chrome shared by every tabbed panel: the dimmed
 * backdrop, the title row with the `Esc` button, and the tab bar.
 * The panel body is passed in as `children`.
 */
import { useEffect, useRef } from "react";
import type * as React from "react";

import { cycleFocus, focusableWithin } from "../menu/focusTrap.js";
import { SHIP_PANEL_TAB_LABELS, type ShipPanelTabId } from "./panelTabs.js";

/** Props for the panel shell. */
export interface PanelShellProps {
  /** Panel title (top-left). */
  title: string;
  /** Test-id prefix for the host panel. */
  testId: string;
  /** The available tabs (left -> right). */
  tabs: readonly ShipPanelTabId[];
  /** The active tab. */
  activeTab: ShipPanelTabId;
  /** Called when a tab is picked. */
  onTab: (tab: ShipPanelTabId) => void;
  /** Called when the panel is dismissed. */
  onClose: () => void;
  /** The panel body. */
  children: React.ReactNode;
  /** The right rail (dock context only). */
  rail?: React.ReactNode;
  /** Ref to the panel node (the menu shell registers it). */
  panelRef?: React.Ref<HTMLDivElement>;
}

/**
 * The shared panel frame. `Tab` cycles inside the panel (the focus
 * trap) and `ArrowLeft` / `ArrowRight` switch tabs.
 */
export function PanelShell({
  title,
  testId,
  tabs,
  activeTab,
  onTab,
  onClose,
  children,
  rail,
  panelRef,
}: PanelShellProps): React.JSX.Element {
  const localRef = useRef<HTMLDivElement | null>(null);
  const setRef = (node: HTMLDivElement | null): void => {
    localRef.current = node;
    if (typeof panelRef === "function") {
      panelRef(node);
    } else if (panelRef !== null && panelRef !== undefined) {
      (panelRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
    }
  };
  // TASK-54: when the panel opens, move focus to its first focusable
  // control so the keyboard flow starts inside the surface (the
  // shell restores focus to the trigger when the panel closes).
  useEffect(() => {
    const node = localRef.current;
    if (node === null) return;
    const first = focusableWithin(node)[0];
    (first ?? node).focus();
  }, []);
  return (
    <div
      data-testid={`${testId}-backdrop`}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(5,6,12,0.78)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 60,
        fontFamily: "system-ui, sans-serif",
        color: "#e6edf3",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={setRef}
        data-testid={testId}
        role="dialog"
        aria-label={title}
        tabIndex={-1}
        style={{
          position: "relative",
          width: 760,
          maxWidth: "92vw",
          background: "#0b1018",
          border: "1px solid rgba(255,255,255,0.15)",
          padding: 16,
          fontFamily: "monospace",
          fontSize: 12,
          color: "#e6edf3",
          boxShadow: "0 20px 60px rgba(0,0,0,0.55)",
        }}
        onKeyDown={(ev: React.KeyboardEvent<HTMLDivElement>) => {
          if (ev.key === "Tab") {
            ev.preventDefault();
            cycleFocus(ev.currentTarget, ev.shiftKey ? -1 : 1);
            return;
          }
          if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") {
            ev.preventDefault();
            const index = tabs.indexOf(activeTab);
            const delta = ev.key === "ArrowRight" ? 1 : -1;
            const next = tabs[(index + delta + tabs.length) % tabs.length];
            if (next !== undefined) onTab(next);
          }
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 12,
          }}
        >
          <div style={{ fontSize: 14, letterSpacing: "0.12em", textTransform: "uppercase" }}>
            {title}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close panel"
            style={{
              background: "transparent",
              border: "1px solid rgba(255,255,255,0.25)",
              color: "#e6edf3",
              padding: "4px 10px",
              cursor: "pointer",
              fontFamily: "monospace",
              fontSize: 11,
            }}
          >
            Esc
          </button>
        </div>

        <div
          role="tablist"
          aria-label="Ship panel tabs"
          style={{
            display: "flex",
            gap: 8,
            borderBottom: "1px solid rgba(255,255,255,0.12)",
            marginBottom: 12,
          }}
        >
          {tabs.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={activeTab === id}
              data-testid={`${testId}-tab-${id}`}
              onClick={() => onTab(id)}
              style={{
                background: "transparent",
                border: "none",
                color: activeTab === id ? "#7adfff" : "rgba(230,237,243,0.55)",
                padding: "6px 12px",
                cursor: "pointer",
                fontFamily: "monospace",
                fontSize: 11,
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                borderBottom: activeTab === id ? "2px solid #7adfff" : "2px solid transparent",
              }}
            >
              {SHIP_PANEL_TAB_LABELS[id]}
            </button>
          ))}
        </div>

        {children}

        {rail}
      </div>
    </div>
  );
}
