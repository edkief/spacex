/**
 * Quality-preset buttons — TASK-55.
 *
 * Three buttons (High / Medium / Low). The switch is **immediate**:
 * picking a preset writes to the shared store in the same event, the
 * `SettingsBridge` re-tunes the pipeline on the next frame, and the
 * parent persists it with a single `PUT` (no debounce — presets are
 * rare and the player expects them to stick).
 */
import type * as React from "react";

import {
  pipelineParamsFor,
  QUALITY_PRESET_IDS,
  type QualityPreset,
  type Settings,
} from "@shared/settings.js";

/** Props for {@link QualityButtons}. */
export interface QualityButtonsProps {
  /** The active preset. */
  value: QualityPreset;
  /** Called with the newly-picked preset. */
  onChange: (next: QualityPreset) => void;
}

/** Human label + one-line budget summary per preset. */
const LABELS: Record<QualityPreset, string> = { high: "High", medium: "Medium", low: "Low" };

function summary(preset: QualityPreset): string {
  const params = pipelineParamsFor(preset);
  return `${(params.drawDistanceM / 1000).toFixed(0)} km · ${params.chunkDetail.near}² near · fx ${
    params.fxQuality
  }`;
}

/** The quality preset radio group. */
export function QualityButtons({ value, onChange }: QualityButtonsProps): React.JSX.Element {
  return (
    <div role="radiogroup" aria-label="Quality preset" style={{ display: "flex", gap: 8 }}>
      {QUALITY_PRESET_IDS.map((preset) => {
        const active = preset === value;
        return (
          <button
            key={preset}
            type="button"
            role="radio"
            aria-checked={active}
            data-testid={`drift-settings-quality-${preset}`}
            onClick={() => onChange(preset)}
            style={{
              flex: 1,
              cursor: "pointer",
              fontFamily: "monospace",
              fontSize: 11,
              padding: "6px 4px",
              color: "#e6edf3",
              background: active ? "#1d4ed8" : "transparent",
              border: "1px solid rgba(255,255,255,0.25)",
            }}
          >
            <div>{LABELS[preset]}</div>
            <div style={{ fontSize: 9, opacity: 0.75, marginTop: 2 }}>{summary(preset)}</div>
          </button>
        );
      })}
    </div>
  );
}

/** Convenience type re-export so the panel doesn't import `Settings` twice. */
export type { Settings };
