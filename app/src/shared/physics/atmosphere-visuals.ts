/**
 * Atmosphere visuals — TASK-28.
 *
 * The math that drives the *visible* atmosphere transition (skybox
 * → haze → planet → back to skybox). Lives next to the physics
 * `atmosphere.ts` because both layers read the same
 * `boundaryFactor` and the visual ramp has to stay in lock-step
 * with the drag ramp — a 1 km drag band over a 2 km haze band
 * would look bizarre (you can see the haze start before the drag
 * starts biting, or the drag stops before the haze ends).
 *
 * The shared rule is "single source of truth for the boundary
 * factor". This file owns three derived values:
 *
 *   - `hazeFactor(altitude, planet)`     — 0..1 alpha for the
 *     atmosphere dome (0 in space, 1 at the surface).
 *   - `reentryTint(descentSpeed, f)`     — 0..1 alpha for the
 *     orange cosmic-reentry rim. Only fires when the ship is
 *     descending faster than `REENTRY_DESCENT_SPEED_U_S`
 *     (200 u/s per spec).
 *   - `atmosphereColor(planet)`          — the deterministic
 *     planet-coloured haze colour the dome blends toward.
 *
 * Plus a `visualProfileForPlanet(planet)` helper that bundles all
 * three per-planet values into one record so the render layer
 * doesn't have to call three functions.
 *
 * The renderer in `app/src/client/components/AtmosphereOverlay.tsx`
 * consumes these. The CSS-based overlay reads
 * `hazeFactor` once per frame and tints the full-viewport layer
 * accordingly — when the future 3D dome shader lands, the same
 * `hazeFactor` will drive its shader uniform.
 *
 * Pure module: no Math.random, no Date.now, no side effects.
 *
 * @see ./atmosphere.ts — the boundary factor the visuals mirror.
 * @see ../galaxy/types.ts — the Planet shape that drives the
 *      per-planet visual profile.
 * @see ../../client/components/AtmosphereOverlay.tsx — the
 *      consumer.
 */

import { BOUNDARY_RAMP_WIDTH_M, boundaryFactor, type PlanetAtmosphere } from "./atmosphere.js";
import type { Planet, PlanetClass } from "../galaxy/types.js";

// ---------------------------------------------------------------------------
// Tunable constants — exported so tests and consumers can pin them.
// ---------------------------------------------------------------------------

/**
 * Descent speed (m/s) above which the re-entry tint starts
 * ramping in. Per spec: 200 u/s. Anything below this and the
 * rim stays invisible — the player can cruise through the
 * boundary band at low speed without any visual alarm.
 */
export const REENTRY_DESCENT_SPEED_U_S = 200;

/**
 * Descent speed at which the re-entry tint reaches its peak
 * (1.0 alpha). Per spec: 600 u/s gives a comfortable spread
 * between "barely noticeable" and "full rim glow".
 */
export const REENTRY_DESATURATION_PEAK_U_S = 600;

/**
 * Re-entry rim RGB colour (orange, per spec). Exported so the
 * render layer can read it without re-typing the literal.
 */
export const REENTRY_RIM_COLOR: readonly [number, number, number] = [1.0, 0.55, 0.25];

// ---------------------------------------------------------------------------
// Per-planet visual profile
// ---------------------------------------------------------------------------

/**
 * A normalised RGB triple (each component in `0..1`). Use this
 * as the input to CSS `rgba(...)` strings, shader uniforms, or
 * `Color.setRGB(...)` in three.js.
 */
export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/**
 * The full visual profile for one planet. Bundles all the
 * per-planet visual constants into a single record so the
 * render layer only has to read it once per frame.
 *
 * `densityScale` is the visual-only density multiplier (e.g.
 * thin-atmosphere worlds render at 0.5, thick at 1.5). It is
 * derived from the planet's `atmosphereDensity` in the
 * `PlanetAtmosphere` shape if available, or from the planet
 * class if not.
 */
export interface AtmosphereVisualProfile {
  /** Planet-class-typed haze colour (alpha is driven separately by `hazeFactor`). */
  readonly hazeColor: Rgb;
  /** Background sky colour the starfield cross-fades to. */
  readonly skyColor: Rgb;
  /** Visual-only density multiplier in `0..1.5` range. */
  readonly densityScale: number;
  /** Whether this planet has a meaningful atmosphere at all. `false` → visuals are inert. */
  readonly hasAtmosphere: boolean;
}

// ---------------------------------------------------------------------------
// Per-planet-class palette
// ---------------------------------------------------------------------------

/**
 * The visual palette the dome blends toward per planet class.
 * Each entry is a (hazeColor, skyColor, densityScale) triple
 * picked to evoke the planet's nature:
 *
 *   - **terran** — earthy blue-green sky, soft cyan haze.
 *   - **ocean**  — deep blue sky, paler cyan haze.
 *   - **rocky**  — dusty ochre sky, brown haze.
 *   - **ice**    — pale blue sky, near-white haze.
 *   - **gas**    — orange-amber sky, deep gold haze.
 *
 * These are pure constants — no colour space conversion, no
 * gamma adjustment. The render layer feeds them straight into
 * CSS / WebGL.
 *
 * `densityScale` follows the same intuition: thick atmospheres
 * (`terran`, `gas`, `ocean`) get 1.0+; thin ones (`rocky`,
 * `ice`) get 0.5–0.8. The spec requires "two planets in the
 * seeded galaxy differ" — `terran` vs `rocky` differ by 50%
 * on density, well above the 20% threshold.
 */
const PLANET_VISUAL_PROFILES: Record<PlanetClass, AtmosphereVisualProfile> = {
  terran: {
    hazeColor: { r: 0.55, g: 0.78, b: 0.92 },
    skyColor: { r: 0.35, g: 0.55, b: 0.85 },
    densityScale: 1.0,
    hasAtmosphere: true,
  },
  ocean: {
    hazeColor: { r: 0.45, g: 0.7, b: 0.95 },
    skyColor: { r: 0.18, g: 0.4, b: 0.78 },
    densityScale: 1.1,
    hasAtmosphere: true,
  },
  rocky: {
    hazeColor: { r: 0.78, g: 0.6, b: 0.42 },
    skyColor: { r: 0.55, g: 0.4, b: 0.28 },
    densityScale: 0.5,
    hasAtmosphere: true,
  },
  ice: {
    hazeColor: { r: 0.88, g: 0.92, b: 0.96 },
    skyColor: { r: 0.65, g: 0.78, b: 0.92 },
    densityScale: 0.7,
    hasAtmosphere: true,
  },
  gas: {
    hazeColor: { r: 0.92, g: 0.65, b: 0.32 },
    skyColor: { r: 0.7, g: 0.42, b: 0.18 },
    densityScale: 1.5,
    hasAtmosphere: true,
  },
};

/**
 * The visual profile a no-atmosphere planet gets. Pure black
 * haze + zero density so the render layer can short-circuit
 * when the planet lacks an atmosphere (the spec says "no pop
 * at any altitude" — for a no-atmosphere world the dome is
 * invisible end-to-end).
 */
const NO_ATMOSPHERE_PROFILE: AtmosphereVisualProfile = {
  hazeColor: { r: 0, g: 0, b: 0 },
  skyColor: { r: 0, g: 0, b: 0 },
  densityScale: 0,
  hasAtmosphere: false,
};

/**
 * Resolve the visual profile for a `Planet`. Pure function — no
 * Math.random — so the same planet always renders the same way.
 *
 * Falls back to `NO_ATMOSPHERE_PROFILE` when `hasAtmosphere` is
 * false. Unknown planet classes fall back to `terran` (the
 * canonical default) so a future planet class addition can't
 * silently break rendering.
 *
 * @param planet — the `Planet` from `@shared/galaxy/types`. The
 *                 `class` field drives the lookup.
 */
export function visualProfileForPlanet(
  planet: Pick<Planet, "class" | "hasAtmosphere">,
): AtmosphereVisualProfile {
  if (!planet.hasAtmosphere) return NO_ATMOSPHERE_PROFILE;
  const profile = PLANET_VISUAL_PROFILES[planet.class];
  return profile ?? PLANET_VISUAL_PROFILES.terran;
}

// ---------------------------------------------------------------------------
// Haze factor
// ---------------------------------------------------------------------------

/**
 * The visible-haze blend factor `h ∈ [0, 1]`. Same shape as the
 * physics drag factor `boundaryFactor` — both ramp 0 → 1 over
 * the same `BOUNDARY_RAMP_WIDTH_M` band. They use *exactly* the
 * same source of truth, so the haze can't desync from the drag
 * (TASK-22 calls `boundaryFactor` too).
 *
 * The visual layer multiplies by `profile.densityScale` so a
 * thin-atmosphere planet renders visibly thinner haze.
 */
export function hazeFactor(altitude: number, profile: AtmosphereVisualProfile): number {
  if (!profile.hasAtmosphere) return 0;
  // Reuse the boundary factor — same band, same shape.
  // `altitude` is measured above the planet surface in metres.
  const f = boundaryFactor(altitude, {
    id: "",
    radius: 0,
    atmosphereHeight: BOUNDARY_RAMP_WIDTH_M,
    atmosphereDensity: 1,
    hasAtmosphere: true,
    heightAt: () => 0,
  });
  return Math.max(0, Math.min(1, f * profile.densityScale));
}

// ---------------------------------------------------------------------------
// Re-entry tint
// ---------------------------------------------------------------------------

/**
 * The re-entry rim alpha `t ∈ [0, 1]`.
 *
 *   - 0 when `|descentSpeed| < REENTRY_DESCENT_SPEED_U_S`
 *   - ramps linearly to 1 between the threshold and `REENTRY_DESATURATION_PEAK_U_S`
 *   - clamped at 1 above the peak
 *
 * `boundaryFactor` is multiplied in so the rim only fires
 * *inside* the atmosphere — the cosmetic cue is "you're
 * burning through air", which is meaningless in pure space.
 *
 * The returned colour is the spec's orange tint
 * (`REENTRY_RIM_COLOR`), scaled by the alpha — the render
 * layer reads the alpha + colour and mixes them into the
 * overlay.
 */
export function reentryTint(descentSpeed: number, boundary: number): { alpha: number; color: Rgb } {
  // Only positive descent (toward the surface) counts. Negative
  // values = ascent = no heating.
  const speed = Math.max(0, descentSpeed);
  if (speed < REENTRY_DESCENT_SPEED_U_S) {
    return {
      alpha: 0,
      color: { r: REENTRY_RIM_COLOR[0], g: REENTRY_RIM_COLOR[1], b: REENTRY_RIM_COLOR[2] },
    };
  }
  const range = REENTRY_DESATURATION_PEAK_U_S - REENTRY_DESCENT_SPEED_U_S;
  const raw = (speed - REENTRY_DESCENT_SPEED_U_S) / range;
  const scaled = Math.max(0, Math.min(1, raw));
  const alpha = scaled * Math.max(0, Math.min(1, boundary));
  return {
    alpha,
    color: { r: REENTRY_RIM_COLOR[0], g: REENTRY_RIM_COLOR[1], b: REENTRY_RIM_COLOR[2] },
  };
}

// ---------------------------------------------------------------------------
// Convenience: derive all three values for the current frame.
// ---------------------------------------------------------------------------

/**
 * Snapshot the full visual state for one ship at one altitude.
 * Pure function — same inputs always produce the same output.
 *
 * Used by both the React overlay (per render) and the unit
 * tests (one call per assertion).
 *
 * @param altitude          Metres above the planet surface.
 * @param descentSpeed      Velocity component along world -Y (m/s, positive = descending).
 * @param planet            The `PlanetAtmosphere` for drag factor math (drives `boundaryFactor`).
 * @param visual            The visual profile for the planet (drives color + density).
 */
export interface AtmosphereVisualState {
  /** Visible haze alpha in `[0, 1]`. */
  readonly haze: number;
  /** Re-entry rim alpha in `[0, 1]`. */
  readonly reentryAlpha: number;
  /** Atmosphere haze colour (constant per planet). */
  readonly hazeColor: Rgb;
  /** Background sky colour (constant per planet). */
  readonly skyColor: Rgb;
}

export function atmosphereVisualState(
  altitude: number,
  descentSpeed: number,
  planet: PlanetAtmosphere,
  visual: AtmosphereVisualProfile,
): AtmosphereVisualState {
  // boundaryFactor takes altitude (above the planet surface) +
  // PlanetAtmosphere; we pass a stub planet because we only
  // need the `hasAtmosphere` + ramp-width semantics, not the
  // planet's drag coefficients.
  const boundary = boundaryFactor(altitude, planet);
  const haze = hazeFactor(altitude, visual);
  const reentry = reentryTint(descentSpeed, boundary);
  return {
    haze,
    reentryAlpha: reentry.alpha,
    hazeColor: visual.hazeColor,
    skyColor: visual.skyColor,
  };
}

/**
 * Helper for tests: format an RGB triple as a CSS `rgba(...)`
 * string. The render layer uses this for the CSS overlay;
 * three.js shaders can ignore it and read the raw `r/g/b`
 * fields directly.
 */
export function rgbToCss(color: Rgb, alpha = 1): string {
  return `rgba(${(color.r * 255).toFixed(0)}, ${(color.g * 255).toFixed(0)}, ${(color.b * 255).toFixed(0)}, ${alpha})`;
}
