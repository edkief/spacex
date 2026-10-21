/**
 * Atmosphere overlay — TASK-28.
 *
 * A CSS-driven haze layer that fades the starfield toward the
 * planet's sky color and tints the viewport with the planet's
 * haze color as the ship descends through the atmosphere
 * boundary band.
 *
 * Why CSS, not WebGL?
 *   - The TASK-70 canvas is a raw WebGL starfield owned by
 *     `GameCanvas` (the TASK-73 three.js mount). Mixing a second
 *     WebGL context on the same surface is awkward (the
 *     starfield already uses the full canvas with
 *     `preserveDrawingBuffer`). A separate DOM layer with
 *     `mix-blend-mode` is dramatically cheaper than spinning up
 *     a second GL context, and the visual effect is just a 0..1
 *     alpha tint.
 *   - The 3D atmosphere *dome* shader is the spec's "future
 *     task" — when the three.js renderer ships, the dome will
 *     own the atmospheric look directly. This CSS overlay is the
 *     bridge: same math (`hazeFactor`) driving the alpha, so the
 *     3D swap is a no-op for physics / gameplay.
 *
 * Visual structure:
 *
 *   ┌────────────────────────┐
 *   │  starfield canvas      │  ← GameCanvas (full viewport)
 *   │  ┌──────────────────┐  │
 *   │  │  skyColor layer  │  │  ← opacity = hazeFactor * 0.6
 *   │  │  ┌────────────┐  │  │
 *   │  │  │  hazeColor │  │  │  ← opacity = hazeFactor
 *   │  │  │  (centered)│  │  │
 *   │  │  └────────────┘  │  │
 *   │  └──────────────────┘  │
 *   │  ReentryOverlay (orange rim, see ./ReentryOverlay.tsx) │
 *   └────────────────────────┘
 *
 * The `skyColor` layer fades the entire viewport toward the
 * planet's sky tone; the `hazeColor` layer is a radial gradient
 * centred on the planet (or, when the planet position isn't
 * known, the viewport centre) so the haze reads as a sphere
 * even without a 3D dome.
 *
 * The component takes a `provider` rather than direct planet
 * data so it can be driven by anything that knows the
 * current altitude + descent speed (server snapshot, client
 * prediction, or a test fake).
 */

import { useEffect, useState } from "react";
import type * as React from "react";

import {
  atmosphereVisualState,
  rgbToCss,
  visualProfileForPlanet,
  type AtmosphereVisualProfile,
  type AtmosphereVisualState,
} from "@shared/physics/atmosphere-visuals.js";
import {
  BOUNDARY_RAMP_WIDTH_M,
  altitudeFromPlanet,
  boundaryFactor,
  type PlanetAtmosphere,
} from "@shared/physics/atmosphere.js";
import type { Planet } from "@shared/galaxy/types.js";
import { settingsBridge } from "../world/settingsBridge.js";

/**
 * Anything that knows the player's current atmospheric
 * state can drive the overlay. Two production callers:
 *
 *   - the player-rig: a controller that reads the live ship
 *     state from the WS snapshot.
 *   - the dev test hook: a fake that scripts altitude
 *     transitions for the smoke test.
 *
 * The provider interface is intentionally tiny — `getState()`
 * is the only thing the overlay needs per frame.
 */
export interface AtmosphereStateProvider {
  /**
   * Snapshot the current altitude (metres above the planet
   * surface), descent speed (m/s, positive = descending),
   * and the visible planet. Returns `null` when no
   * atmosphere-bearing planet is in range (overlay fades to
   * invisible).
   */
  getState(): {
    altitude: number;
    descentSpeed: number;
    planet: Planet;
    planetAtmosphere: PlanetAtmosphere;
  } | null;
}

/**
 * Convenience: build a `AtmosphereStateProvider` from a static
 * triple (altitude, descent speed, planet). Useful in tests +
 * the dev-only smoke hook.
 */
export function staticAtmosphereProvider(
  altitude: number,
  descentSpeed: number,
  planet: Planet,
  planetAtmosphere: PlanetAtmosphere,
): AtmosphereStateProvider {
  return {
    getState: () => ({ altitude, descentSpeed, planet, planetAtmosphere }),
  };
}

/**
 * Pure helper: derive the visual state for a given snapshot.
 * Pure so the unit test + the render path share the same math.
 *
 * `state` is `null` (no atmosphere-bearing planet in range) →
 * the overlay fades to 0 across every channel.
 */
export function deriveAtmosphereVisual(state: ReturnType<AtmosphereStateProvider["getState"]>): {
  state: AtmosphereVisualState | null;
  profile: AtmosphereVisualProfile | null;
  boundary: number;
} {
  if (state === null) {
    return { state: null, profile: null, boundary: 0 };
  }
  const profile = visualProfileForPlanet(state.planet);
  const visual = atmosphereVisualState(
    state.altitude,
    state.descentSpeed,
    state.planetAtmosphere,
    profile,
  );
  const boundary = boundaryFactor(state.altitude, state.planetAtmosphere);
  return { state: visual, profile, boundary };
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface AtmosphereOverlayProps {
  /** Provider for the current altitude / speed / planet snapshot. */
  provider: AtmosphereStateProvider;
  /**
   * Override clock for tests. Default `Date.now()`. Unused by the
   * CSS layer (no animation curves) — present for symmetry with
   * `WarpOverlay` and future animation work.
   */
  now?: () => number;
  /**
   * Optional planet centre in viewport coordinates (pixels from the
   * top-left). When provided, the haze layer is centred on the
   * planet; when absent, it falls back to the viewport centre
   * (the cheapest "sphere-shaped" look without a real 3D dome).
   */
  planetViewportCenter?: { x: number; y: number } | null;
}

/**
 * The overlay. Pure DOM/CSS — no canvas, no shaders. The two
 * layers (sky + haze) are stacked with `mix-blend-mode: normal`
 * so the alpha multiply composes linearly (the math the
 * `hazeFactor` ramp drives).
 *
 * The component subscribes to the provider via `useState` +
 * a `requestAnimationFrame` loop so a transition in altitude
 * updates the overlay every frame. In production this is
 * driven by the WS snapshot; the dev test hook scripts
 * altitude transitions and asserts the alpha response.
 */
export function AtmosphereOverlay(props: AtmosphereOverlayProps): React.JSX.Element {
  // We re-render via `useState` + an internal rAF loop. The
  // snapshot is read once per frame; React batches the render.
  const [, setTick] = useState(0);
  useAnimationFrame(() => {
    setTick((t) => t + 1);
  });

  const { state, profile, boundary } = deriveAtmosphereVisual(props.provider.getState());

  // No planet in range → overlay hidden (the dome is invisible).
  // We always render the root so e2e selectors find the layer
  // even when the value is 0 (test hook probes opacity).
  const hazeAlpha = state?.haze ?? 0;
  const skyAlpha = hazeAlpha * 0.6; // background tinted less than the dome
  const boundaryBand = boundary; // 0..1 ramp aligned with the haze
  // Sky layer is shown only inside the boundary band (so we
  // don't tint space at all).
  const skyVisible = boundaryBand > 0 ? 1 : 0;
  const hazeVisible = hazeAlpha > 0 ? 1 : 0;

  const center = props.planetViewportCenter ?? null;
  // TASK-59: the mobile profile runs no dome shader — the haze is a
  // flat colour wash instead of the radial gradient, which is the
  // single most expensive per-frame paint in the overlay.
  const flatHaze = settingsBridge.current().atmosphere === "haze";

  return (
    <div
      data-testid="drift-atmosphere-overlay"
      data-haze-alpha={hazeAlpha.toFixed(4)}
      data-boundary={boundaryBand.toFixed(4)}
      data-haze-visible={hazeVisible === 1 ? "true" : "false"}
      data-atmosphere={flatHaze ? "haze" : "dome"}
      aria-hidden="true"
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        zIndex: 800,
        // The sky tint covers the full viewport.
        background:
          profile && state ? rgbToCss(profile.skyColor, skyAlpha * skyVisible) : "transparent",
        transition: "background 80ms linear",
      }}
    >
      {/* The haze layer is a centred radial gradient so it reads
          as a sphere even without a real 3D dome. We centre it
          on the planet when known, otherwise on the viewport
          centre. */}
      <div
        data-testid="drift-atmosphere-haze"
        data-haze-color={
          profile && state
            ? `${profile.hazeColor.r.toFixed(4)},${profile.hazeColor.g.toFixed(4)},${profile.hazeColor.b.toFixed(4)}`
            : "0,0,0"
        }
        aria-hidden="true"
        style={{
          position: "absolute",
          left: center ? `${center.x}px` : "50%",
          top: center ? `${center.y}px` : "50%",
          width: "120vmax",
          height: "120vmax",
          transform: "translate(-50%, -50%)",
          // The radial gradient: transparent at the centre (the
          // planet surface would be opaque), peak at ~30% radius,
          // and back to transparent at the edge so the band is
          // visually "the atmosphere band, not a filled disc".
          background:
            profile && state
              ? flatHaze
                ? rgbToCss(profile.hazeColor, hazeAlpha * 0.85 * hazeVisible)
                : `radial-gradient(circle at 50% 50%, ${rgbToCss(profile.hazeColor, hazeAlpha * 0.5 * hazeVisible)} 0%, ${rgbToCss(profile.hazeColor, hazeAlpha * 0.9 * hazeVisible)} 30%, ${rgbToCss(profile.hazeColor, 0)} 75%)`
              : "transparent",
          opacity: hazeVisible,
          transition: "opacity 80ms linear, background 80ms linear",
        }}
      />
      {/* Animated key visible to e2e selectors even when alpha is 0. */}
      <span style={{ display: "none" }}>{`band=${BOUNDARY_RAMP_WIDTH_M}m`}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// React bits — kept inline so the file doesn't sprawl into hooks.
// ---------------------------------------------------------------------------

/** Run a callback once per animation frame. */
function useAnimationFrame(callback: () => void): void {
  useEffect(() => {
    if (typeof window === "undefined") return;
    let raf = 0;
    const tick = (): void => {
      callback();
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(raf);
    };
  }, [callback]);
}

/**
 * Static state derived for tests. Pure — no React lifecycle.
 *
 * @param altitude     Altitude above the planet surface (metres).
 * @param descentSpeed Descent velocity (m/s, positive = down).
 * @param planet       The visible planet.
 * @param planetAtmosphere  Atmosphere data for `boundaryFactor`.
 */
export function atmosphereOverlaySnapshot(
  altitude: number,
  descentSpeed: number,
  planet: Planet,
  planetAtmosphere: PlanetAtmosphere,
): {
  state: AtmosphereVisualState;
  profile: AtmosphereVisualProfile;
  boundary: number;
  altitudeFromSurface: number;
} {
  const profile = visualProfileForPlanet(planet);
  const visual = atmosphereVisualState(altitude, descentSpeed, planetAtmosphere, profile);
  const boundary = boundaryFactor(altitude, planetAtmosphere);
  return {
    state: visual,
    profile,
    boundary,
    altitudeFromSurface: altitudeFromPlanet(
      { x: 0, y: planetAtmosphere.radius + altitude, z: 0 },
      planetAtmosphere,
    ),
  };
}

// Re-export so consumers can read the boundary constant without
// reaching into `@shared/physics/atmosphere`.
export { BOUNDARY_RAMP_WIDTH_M } from "@shared/physics/atmosphere.js";
