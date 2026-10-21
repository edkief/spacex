/**
 * Settings panel — TASK-55 (the full settings page; the
 * reduced-motion toggle landed with TASK-54).
 *
 * Four sections: the **quality preset**, the **mouse sensitivity**
 * slider, **reduced motion**, and the read-only **keybind** list,
 * plus a *Reset to defaults* button.
 *
 * There is deliberately no "Apply" button:
 *
 *   - a preset switch applies **immediately** (the streaming
 *     pipeline re-tunes on its next tick through the
 *     `SettingsBridge`) and is persisted with one `PUT`,
 *   - the slider applies on the next input frame and the write is
 *     **debounced 300 ms** so a drag burst is one request,
 *   - the toggle applies on the next frame, one `PUT`.
 *
 * The panel declares itself with `data-menu-surface` so the shell's
 * input gate lets `Tab` / `Enter` / `Space` / arrows through while
 * still swallowing the game keys.
 *
 * @see ./SettingsPanel.test.tsx
 */
import { useEffect, useRef, useSyncExternalStore } from "react";
import type * as React from "react";

import { cycleFocus, focusableWithin } from "./focusTrap.js";
import { QualityButtons } from "./QualityButtons.js";
import {
  DeviceProfileRow,
  KeybindList,
  ReducedMotionToggle,
  SensitivitySlider,
} from "./SettingsSections.js";
import { settingsStore } from "../../a11y/settings.js";
import { createSettingsSaver, type SettingsSaver } from "../../settings/api.js";
import { settingsBridge } from "../../world/settingsBridge.js";
import {
  DEFAULT_SETTINGS,
  type DeviceProfile,
  type QualityPreset,
  type Settings,
} from "@shared/settings.js";

/** Props for the settings panel. */
export interface SettingsPanelProps {
  /** Called when the surface is dismissed. */
  onClose?: () => void;
  /**
   * Bearer token used for the settings writes. When omitted the
   * panel still works (settings apply live and persist to
   * localStorage) but nothing is sent to the server.
   */
  authToken?: string | null;
}

/** The settings surface. Mounted by `App.tsx` while `settings` is on top. */
export function SettingsPanel({ onClose, authToken }: SettingsPanelProps): React.JSX.Element {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const snapshot = useSyncExternalStore(
    settingsStore.subscribe,
    settingsStore.getSnapshot,
    settingsStore.getSnapshot,
  );

  // The saver is created once and reads the token lazily, so a token
  // that arrives after the panel opened is still picked up.
  const tokenRef = useRef(authToken ?? null);
  tokenRef.current = authToken ?? null;
  const saverRef = useRef<SettingsSaver | null>(null);
  if (saverRef.current === null) {
    saverRef.current = createSettingsSaver({
      getToken: () => tokenRef.current,
      onSaved: (stored) => settingsStore.hydrate(stored),
    });
  }

  // Persist immediately (preset / toggle / reset) and drop any
  // queued slider write so the two don't race.
  const persistNow = (patch: Partial<Settings>): void => {
    void saverRef.current?.saveNow(patch);
  };

  const onQuality = (next: QualityPreset): void => {
    settingsStore.setQuality(next);
    persistNow({ quality: next });
  };
  const onSensitivity = (next: number): void => {
    // Live: applies to the next input frame; the write is debounced.
    settingsStore.setSensitivity(next);
    saverRef.current?.queue({ sensitivity: next });
  };
  const onReducedMotion = (next: boolean): void => {
    settingsStore.setReducedMotion(next);
    persistNow({ reducedMotion: next });
  };
  // TASK-59: the override is stored immediately; the profile itself
  // lands on the next world load (the warp re-init).
  const onDeviceProfile = (next: DeviceProfile): void => {
    settingsStore.setDeviceProfile(next);
    persistNow({ deviceProfile: next });
  };
  const onReset = (): void => {
    settingsStore.reset();
    persistNow({ ...DEFAULT_SETTINGS });
  };

  // Move focus to the first control when the panel opens (TASK-54).
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
          minWidth: 320,
          display: "grid",
          gap: 14,
        }}
      >
        <div style={{ letterSpacing: "0.18em", textTransform: "uppercase" }}>Settings</div>

        <section aria-label="Quality">
          <QualityButtons value={snapshot.quality} onChange={onQuality} />
          <p style={{ margin: "6px 0 0", fontSize: 10, opacity: 0.7, lineHeight: 1.5 }}>
            Applies live — chunks already generated keep their detail until they are regenerated.
          </p>
        </section>

        <SensitivitySlider value={snapshot.sensitivity} onChange={onSensitivity} />

        <ReducedMotionToggle value={snapshot.reducedMotion} onChange={onReducedMotion} />

        <DeviceProfileRow
          value={snapshot.deviceProfile}
          onChange={onDeviceProfile}
          resolved={settingsBridge.profile().id}
        />

        <KeybindList />

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            type="button"
            data-testid="drift-settings-reset"
            onClick={onReset}
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
            Reset to defaults
          </button>
          <button
            type="button"
            data-testid="drift-settings-close"
            aria-label="Close settings"
            onClick={() => onClose?.()}
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
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
