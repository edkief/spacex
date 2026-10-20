/**
 * Settings panel — TASK-54 (the reduced-motion toggle).
 *
 * A minimal surface inside the ESC shell. It declares itself with
 * `data-menu-surface` so the shell's input gate lets `Tab` /
 * `Enter` / `Space` through (the gate swallows every other key so
 * the game never sees them while a surface is open).
 *
 * The reduced-motion toggle flips the shared settings flag, which
 * the FX registry reads on the next effect — the change takes
 * effect immediately, with no restart.
 *
 * TASK-55 grows this surface into the full settings page (quality
 * presets, sensitivity); the toggle + the focus behaviour land
 * here.
 */
import { useEffect, useRef, useSyncExternalStore } from "react";
import type * as React from "react";

import { cycleFocus, focusableWithin } from "./focusTrap.js";
import { settingsStore } from "../../a11y/settings.js";

/** Props for the settings panel. */
export interface SettingsPanelProps {
  /** Called when the surface is dismissed. */
  onClose?: () => void;
}

/**
 * The settings surface. Mounted by `App.tsx` while the `settings`
 * surface is on top of the menu stack.
 */
export function SettingsPanel({ onClose }: SettingsPanelProps): React.JSX.Element {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const reducedMotion = useSyncExternalStore(
    settingsStore.subscribe,
    settingsStore.getSnapshot,
    settingsStore.getSnapshot,
  ).reducedMotion;

  // TASK-54: move focus to the first control when the panel opens.
  useEffect(() => {
    const node = panelRef.current;
    if (node === null) return;
    const first = focusableWithin(node)[0];
    (first ?? node).focus();
  }, []);

  return (
    <div
      data-testid="drift-settings-backdrop"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(5,6,12,0.78)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 80,
        fontFamily: "monospace",
        color: "#e6edf3",
      }}
    >
      <div
        ref={panelRef}
        data-testid="drift-settings-panel"
        data-menu-surface="settings"
        role="dialog"
        aria-label="Settings"
        tabIndex={-1}
        onKeyDown={(ev: React.KeyboardEvent<HTMLDivElement>) => {
          if (ev.key === "Tab") {
            ev.preventDefault();
            cycleFocus(ev.currentTarget, ev.shiftKey ? -1 : 1);
          }
        }}
        style={{
          background: "#0b1018",
          border: "1px solid rgba(255,255,255,0.15)",
          padding: 16,
          fontSize: 12,
          minWidth: 280,
        }}
      >
        <div style={{ letterSpacing: "0.18em", textTransform: "uppercase", marginBottom: 12 }}>
          Settings
        </div>
        <label
          data-testid="drift-settings-reduced-motion"
          style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}
        >
          <input
            type="checkbox"
            data-testid="drift-settings-reduced-motion-input"
            checked={reducedMotion}
            onChange={(e) => settingsStore.setReducedMotion(e.currentTarget.checked)}
          />
          Reduced motion
        </label>
        <p style={{ marginTop: 12, fontSize: 10, opacity: 0.7, lineHeight: 1.5 }}>
          Disables camera shake, slow motion, particle effects, the animated threat ping and the
          warp streak. Takes effect immediately.
        </p>
        <button
          type="button"
          data-testid="drift-settings-close"
          aria-label="Close settings"
          onClick={() => onClose?.()}
          style={{
            marginTop: 12,
            background: "transparent",
            border: "1px solid rgba(255,255,255,0.25)",
            color: "#e6edf3",
            padding: "4px 10px",
            cursor: "pointer",
            fontFamily: "monospace",
            fontSize: 11,
          }}
        >
          Close
        </button>
      </div>
    </div>
  );
}
