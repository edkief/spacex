/**
 * AltitudeReadout + RegimeTag — TASK-51.
 *
 * Two small labels stacked directly under the `SpeedReadout`:
 *
 *   - `ALT 1234 m` — altitude above the planet surface in integer
 *     metres. Becomes `—` in space (the em-dash the spec calls
 *     for — altitude is meaningless without a surface).
 *   - `SPACE / ATMOS / SURFACE` — the regime tag from the server.
 *     Caps match the spec exactly: three letters, all caps.
 *
 * Both render to a single DOM row each, polled at the 10 Hz HUD
 * cadence from the local predictor's state.
 *
 * @see ../combat/hud/shipReadout.ts for the formatters.
 */
import type * as React from "react";

import { formatAltitude, regimeTagFor, type ShipHudRegime } from "../combat/hud/shipReadout.js";

/** Props for the altitude readout. */
export interface AltitudeReadoutProps {
  /** Wire-level regime (the server reports `space` / `orbit` / `atmosphere` / `surface`). */
  regime: string | null;
  /** Local-ship altitude in metres (only meaningful in atm / surface regimes). */
  altitudeM: number | null;
}

/**
 * Altitude label. Spec: "ALT 1234 m in atmosphere/surface; '—' in space".
 */
export function AltitudeReadout(props: AltitudeReadoutProps): React.JSX.Element {
  const text = formatAltitude(props.regime, props.altitudeM);
  return (
    <div
      data-testid="drift-ship-altitude-readout"
      data-regime={regimeTagFor(props.regime)}
      style={{
        position: "fixed",
        bottom: 238,
        left: 16,
        padding: "2px 10px",
        background: "rgba(12, 16, 24, 0.55)",
        border: "1px solid rgba(230, 237, 243, 0.18)",
        borderRadius: 4,
        fontFamily:
          'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
        fontSize: 12,
        letterSpacing: "0.04em",
        color: "#e6edf3",
        pointerEvents: "none",
        zIndex: 850,
      }}
    >
      {text}
    </div>
  );
}

/** Props for the regime tag pill. */
export interface RegimeTagProps {
  /** Wire-level regime (the server reports `space` / `orbit` / `atmosphere` / `surface`). */
  regime: string | null;
}

/**
 * Three-letter regime pill. The tag reads as a small insets pill
 * (uppercase, single line) so the column still reads as one
 * "instrument" rather than two labels.
 */
export function RegimeTag(props: RegimeTagProps): React.JSX.Element {
  const tag: ShipHudRegime = regimeTagFor(props.regime);
  const colorMap: Record<ShipHudRegime, string> = {
    SPACE: "rgba(124, 199, 255, 0.85)",
    ATMOS: "rgba(245, 185, 77, 0.85)",
    SURFACE: "rgba(110, 231, 168, 0.85)",
  };
  return (
    <div
      data-testid="drift-ship-regime-tag"
      data-tag={tag}
      style={{
        position: "fixed",
        bottom: 212,
        left: 16,
        padding: "2px 10px",
        background: colorMap[tag],
        color: "#0b1018",
        borderRadius: 3,
        fontFamily:
          'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
        fontSize: 10,
        letterSpacing: "0.18em",
        fontWeight: 700,
        textTransform: "uppercase",
        pointerEvents: "none",
        zIndex: 850,
        width: 80,
        textAlign: "center",
      }}
    >
      {tag}
    </div>
  );
}
