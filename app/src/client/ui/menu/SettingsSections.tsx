/**
 * Settings sections — TASK-55.
 *
 * The three sub-components of the settings panel that aren't the
 * preset switch: the sensitivity slider, the reduced-motion toggle
 * (TASK-54's flag), and the read-only keybind list. Split out of
 * `SettingsPanel.tsx` so each stays small and independently testable.
 */
import type * as React from "react";

import {
  DEVICE_PROFILE_IDS,
  KEYBINDS,
  SENSITIVITY_MAX,
  SENSITIVITY_MIN,
  SENSITIVITY_STEP,
  type DeviceProfile,
} from "@shared/settings.js";

/** Props for {@link SensitivitySlider}. */
export interface SensitivitySliderProps {
  /** Current multiplier (0.5 – 2.0). */
  value: number;
  /** Called on every drag — the value applies to the next input frame. */
  onChange: (next: number) => void;
}

/**
 * The mouse-sensitivity slider. The parent applies the value live
 * and debounces the network write, so the drag itself stays at
 * input-event cadence.
 */
export function SensitivitySlider({ value, onChange }: SensitivitySliderProps): React.JSX.Element {
  return (
    <label data-testid="drift-settings-sensitivity" style={{ display: "block", cursor: "pointer" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span>Mouse sensitivity</span>
        <span data-testid="drift-settings-sensitivity-value">{value.toFixed(1)}×</span>
      </div>
      <input
        type="range"
        data-testid="drift-settings-sensitivity-input"
        aria-label="Mouse sensitivity"
        min={SENSITIVITY_MIN}
        max={SENSITIVITY_MAX}
        step={SENSITIVITY_STEP}
        value={value}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
        style={{ width: "100%" }}
      />
    </label>
  );
}

/** Props for {@link ReducedMotionToggle}. */
export interface ReducedMotionToggleProps {
  /** Whether reduced motion is on. */
  value: boolean;
  /** Called with the toggled value (applies immediately). */
  onChange: (next: boolean) => void;
}

/** The TASK-54 reduced-motion toggle. */
export function ReducedMotionToggle({
  value,
  onChange,
}: ReducedMotionToggleProps): React.JSX.Element {
  return (
    <label
      data-testid="drift-settings-reduced-motion"
      style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}
    >
      <input
        type="checkbox"
        data-testid="drift-settings-reduced-motion-input"
        checked={value}
        onChange={(e) => onChange(e.currentTarget.checked)}
      />
      Reduced motion
    </label>
  );
}

/**
 * The keybind list. Read-only: v1 ships no rebinding (scope cut), so
 * this is documentation of the defaults from `@client/input/controls`.
 */
/** Props for {@link DeviceProfileRow}. */
export interface DeviceProfileRowProps {
  /** Current override. */
  value: DeviceProfile;
  /** Called when the player picks a different one. */
  onChange: (next: DeviceProfile) => void;
  /** The profile id the override currently resolves to. */
  resolved?: string;
}

/**
 * TASK-59: the *Device profile* row — Auto / Desktop / Mobile. Auto
 * runs the navigator heuristic; Desktop and Mobile force the
 * profile. The choice is applied on the **next world load** (the
 * warp transition re-inits the pipeline), so the row says so.
 */
export function DeviceProfileRow({
  value,
  onChange,
  resolved,
}: DeviceProfileRowProps): React.JSX.Element {
  const labels: Record<DeviceProfile, string> = {
    auto: "Auto",
    desktop: "Desktop",
    mobile: "Mobile",
  };
  return (
    <div data-testid="drift-settings-device-profile">
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span>Device profile</span>
        {resolved !== undefined ? (
          <span data-testid="drift-settings-device-profile-resolved">{resolved}</span>
        ) : null}
      </div>
      <div role="radiogroup" aria-label="Device profile" style={{ display: "flex", gap: 6 }}>
        {DEVICE_PROFILE_IDS.map((id) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={value === id}
            data-testid={`drift-settings-device-profile-${id}`}
            onClick={() => {
              onChange(id);
            }}
            style={{
              background: value === id ? "#1d4ed8" : "transparent",
              border: "1px solid rgba(255,255,255,0.25)",
              color: "#e6edf3",
              padding: "3px 8px",
              cursor: "pointer",
              fontFamily: "monospace",
              fontSize: 11,
            }}
          >
            {labels[id]}
          </button>
        ))}
      </div>
      <p style={{ margin: "6px 0 0", fontSize: 10, opacity: 0.7, lineHeight: 1.5 }}>
        Mobile holds 30 fps on a phone (3 km draw distance, flat haze, fewer FX). Applies on the
        next system entry.
      </p>
    </div>
  );
}

export function KeybindList(): React.JSX.Element {
  return (
    <div data-testid="drift-settings-keybinds" style={{ fontSize: 10, lineHeight: 1.6 }}>
      <div style={{ opacity: 0.7, marginBottom: 4 }}>
        Controls <span style={{ opacity: 0.6 }}>(v1: fixed, no rebinding)</span>
      </div>
      <dl style={{ display: "grid", gridTemplateColumns: "9.5em 1fr", gap: "2px 8px", margin: 0 }}>
        {KEYBINDS.map((row) => (
          <div key={row.keys} style={{ display: "contents" }}>
            <dt style={{ opacity: 0.9 }}>{row.keys}</dt>
            <dd style={{ margin: 0, opacity: 0.75 }}>{row.action}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
