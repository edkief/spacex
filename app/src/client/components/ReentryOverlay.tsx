/**
 * Re-entry overlay — TASK-28.
 *
 * The cosmetic orange rim that flashes when the ship is
 * descending through an atmosphere faster than
 * `REENTRY_DESCENT_SPEED_U_S` (200 u/s per spec). Lives in its
 * own component so the atmosphere haze and the re-entry
 * tint can be styled / tested independently — a future
 * accessibility option might let the player toggle the tint
 * off, and that toggle should not require editing the
 * atmosphere overlay.
 *
 * Visual:
 *
 *   - A radial vignette around the viewport edges that
 *     pulses with the re-entry alpha.
 *   - Inline filter glow so the rim reads as "hot air".
 *
 * The overlay reads the same `AtmosphereStateProvider` as
 * `AtmosphereOverlay` so both layers share one source of
 * truth — they cannot desync, even if a future task adds a
 * third atmosphere-driven layer.
 */

import type * as React from "react";

import {
  REENTRY_RIM_COLOR,
  reentryTint,
  rgbToCss,
  type Rgb,
} from "@shared/physics/atmosphere-visuals.js";
import { boundaryFactor } from "@shared/physics/atmosphere.js";
import type { AtmosphereStateProvider } from "./AtmosphereOverlay.js";

/**
 * Render the re-entry rim layer. Returns `null` when the
 * alpha is 0 (no descent, no atmosphere) so the layer
 * doesn't burn frames on an invisible overlay.
 *
 * `planet` and `planetAtmosphere` are passed through the
 * provider — see `AtmosphereOverlay` for the full contract.
 */
export function ReentryOverlay(props: {
  provider: AtmosphereStateProvider;
}): React.JSX.Element | null {
  const state = props.provider.getState();
  if (state === null) return null;

  const boundary = boundaryFactor(state.altitude, state.planetAtmosphere);
  const tint = reentryTint(state.descentSpeed, boundary);
  if (tint.alpha <= 0) return null;

  // Compose the rim colour once so we don't re-stringify per
  // frame. The rgba alpha is the reentry tint alpha (0..1).
  const rimColor = rgbToCss(tint.color, tint.alpha);

  return (
    <div
      data-testid="drift-reentry-overlay"
      data-reentry-alpha={tint.alpha.toFixed(4)}
      data-reentry-color={colorKey(tint.color)}
      aria-hidden="true"
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        zIndex: 900,
        // Radial vignette — orange at the edges, transparent
        // in the middle. The transition is 80 ms so the alpha
        // ramp reads as a smooth fade-in.
        background: `radial-gradient(circle at 50% 50%, ${rimColor.replace(
          /, [\d.]+\)$/,
          ", 0)",
        )} 30%, ${rimColor} 95%)`,
        // Subtle blur so the rim reads as "hot air" rather
        // than a hard frame. Kept small (1 px) so the orange
        // stays visually punchy in screenshots — a thicker
        // blur washes out into the haze layer.
        filter: "blur(1px)",
        opacity: 1,
        transition: "opacity 80ms linear",
      }}
    >
      {/* Colour band — three concentric boxes that pick up the
          rim color when alpha is high. Pure CSS so the
          overlay stays cheap. */}
      <div
        data-testid="drift-reentry-rim"
        style={{
          position: "absolute",
          inset: 0,
          boxShadow: `inset 0 0 ${Math.round(80 * tint.alpha)}px ${Math.round(
            30 * tint.alpha,
          )}px ${rgbToCss(tint.color, tint.alpha * 0.7)}`,
          transition: "box-shadow 80ms linear",
        }}
      />
    </div>
  );
}

/**
 * String key for a colour so the e2e smoke can assert the
 * tint colour matches the spec.
 */
function colorKey(color: Rgb): string {
  return `${color.r.toFixed(4)},${color.g.toFixed(4)},${color.b.toFixed(4)}`;
}

/**
 * Constant accessor — re-export the spec colour so tests
 * and consumers don't have to reach into the math module
 * for the literal.
 */
export const REENTRY_OVERLAY_COLOR: readonly [number, number, number] = REENTRY_RIM_COLOR;
