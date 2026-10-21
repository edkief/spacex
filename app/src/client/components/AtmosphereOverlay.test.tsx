/**
 * AtmosphereOverlay component tests — TASK-28.
 *
 * Covers the React layer's wiring:
 *
 *   - Provider snapshot → DOM data attributes (haze alpha, boundary, etc.).
 *   - No-atmosphere planet → 0 alpha, layer hidden.
 *   - Per-planet density scaling: terran vs rocky differ on alpha at mid-band.
 *   - Haze layer centered on the viewport by default; follows `planetViewportCenter` when set.
 *
 * Uses `renderToStaticMarkup` so the tests run in Node without
 * jsdom/happy-dom — the overlay has no effects-only paths that
 * we need a DOM for (the rAF loop in the React component does
 * not affect the markup output, and `provider.getState()` is
 * invoked synchronously during render so the data attributes
 * are baked into the markup).
 */

// @vitest-environment node

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

import { AtmosphereOverlay, staticAtmosphereProvider } from "./AtmosphereOverlay.js";
import { ReentryOverlay } from "./ReentryOverlay.js";
import {
  REENTRY_DESCENT_SPEED_U_S,
  REENTRY_DESATURATION_PEAK_U_S,
} from "@shared/physics/atmosphere-visuals.js";
import { makeFlatPlanet, type PlanetAtmosphere } from "@shared/physics/atmosphere.js";
import { settingsStore } from "../a11y/settings.js";
import { settingsBridge } from "../world/settingsBridge.js";
import type { Planet } from "@shared/galaxy/types.js";

const RADIUS = 5_000_000; // 5000 km

const PLANET_ATMO: PlanetAtmosphere = makeFlatPlanet({
  id: "test-planet",
  radius: RADIUS,
  atmosphereDensity: 1,
  hasAtmosphere: true,
});

const TERRAN: Planet = {
  id: "test-terran",
  name: "Terran",
  orbitIndex: 0,
  class: "terran",
  radiusKm: 5000,
  hasAtmosphere: true,
  landable: true,
  dockCount: 1,
  resourceTypes: ["iron"],
  aiRoster: { count: 0, classes: [] },
};

const ROCKY: Planet = {
  id: "test-rocky",
  name: "Rocky",
  orbitIndex: 1,
  class: "rocky",
  radiusKm: 3000,
  hasAtmosphere: true,
  landable: true,
  dockCount: 1,
  resourceTypes: ["iron"],
  aiRoster: { count: 0, classes: [] },
};

const NO_ATMO_PLANET: Planet = {
  ...TERRAN,
  id: "no-atmo",
  hasAtmosphere: false,
};

const NO_ATMO: PlanetAtmosphere = makeFlatPlanet({
  id: "no-atmo",
  radius: RADIUS,
  hasAtmosphere: false,
});

/** Pull a `data-*` attribute out of the rendered markup. */
function readAttr(markup: string, attr: string): string | null {
  // Match the first data attribute of the given name on the overlay root.
  const re = new RegExp(`${attr}="([^"]*)"`);
  const m = markup.match(re);
  return m ? m[1] : null;
}

describe("AtmosphereOverlay: provider snapshot → DOM", () => {
  it("renders the overlay layer", () => {
    const provider = staticAtmosphereProvider(0, 0, TERRAN, PLANET_ATMO);
    const markup = renderToStaticMarkup(createElement(AtmosphereOverlay, { provider }));
    expect(markup).toContain('data-testid="drift-atmosphere-overlay"');
    expect(markup).toContain('data-testid="drift-atmosphere-haze"');
  });

  it("reports haze alpha ≈ 1 at the surface (terran, density 1.0)", () => {
    const provider = staticAtmosphereProvider(0, 0, TERRAN, PLANET_ATMO);
    const markup = renderToStaticMarkup(createElement(AtmosphereOverlay, { provider }));
    const alpha = parseFloat(readAttr(markup, "data-haze-alpha") ?? "0");
    expect(alpha).toBeGreaterThan(0.99);
  });

  it("reports haze alpha ≈ 0 above the boundary band", () => {
    const provider = staticAtmosphereProvider(5000, 0, TERRAN, PLANET_ATMO);
    const markup = renderToStaticMarkup(createElement(AtmosphereOverlay, { provider }));
    const alpha = parseFloat(readAttr(markup, "data-haze-alpha") ?? "0");
    expect(alpha).toBe(0);
  });

  it("ramps linearly inside the boundary band (mid-band ≈ 0.5)", () => {
    const provider = staticAtmosphereProvider(500, 0, TERRAN, PLANET_ATMO);
    const markup = renderToStaticMarkup(createElement(AtmosphereOverlay, { provider }));
    const alpha = parseFloat(readAttr(markup, "data-haze-alpha") ?? "0");
    expect(alpha).toBeCloseTo(0.5, 1);
  });

  it("per-planet density scaling: terran vs rocky differ on alpha", () => {
    const terranMarkup = renderToStaticMarkup(
      createElement(AtmosphereOverlay, {
        provider: staticAtmosphereProvider(500, 0, TERRAN, PLANET_ATMO),
      }),
    );
    const rockyMarkup = renderToStaticMarkup(
      createElement(AtmosphereOverlay, {
        provider: staticAtmosphereProvider(500, 0, ROCKY, PLANET_ATMO),
      }),
    );
    const aAlpha = parseFloat(readAttr(terranMarkup, "data-haze-alpha") ?? "0");
    const bAlpha = parseFloat(readAttr(rockyMarkup, "data-haze-alpha") ?? "0");
    // Acceptance: the haze factor at mid-boundary differs by > 20%
    // between two planets. Terran density 1.0 vs rocky 0.5.
    const denom = Math.max(aAlpha, bAlpha);
    const diff = Math.abs(aAlpha - bAlpha) / denom;
    expect(diff).toBeGreaterThan(0.2);
  });

  it("no-atmosphere planet yields haze alpha 0", () => {
    const provider = staticAtmosphereProvider(0, 0, NO_ATMO_PLANET, NO_ATMO);
    const markup = renderToStaticMarkup(createElement(AtmosphereOverlay, { provider }));
    const alpha = parseFloat(readAttr(markup, "data-haze-alpha") ?? "0");
    expect(alpha).toBe(0);
  });

  it("respects planetViewportCenter (centers the haze layer there)", () => {
    const provider = staticAtmosphereProvider(0, 0, TERRAN, PLANET_ATMO);
    const markup = renderToStaticMarkup(
      createElement(AtmosphereOverlay, {
        provider,
        planetViewportCenter: { x: 320, y: 240 },
      }),
    );
    expect(markup).toContain("left:320px");
    expect(markup).toContain("top:240px");
  });

  it("defaults to centred haze (no planetViewportCenter)", () => {
    const provider = staticAtmosphereProvider(0, 0, TERRAN, PLANET_ATMO);
    const markup = renderToStaticMarkup(createElement(AtmosphereOverlay, { provider }));
    expect(markup).toContain("left:50%");
    expect(markup).toContain("top:50%");
  });
});

describe("ReentryOverlay: provider snapshot → DOM", () => {
  it("renders nothing when descent speed is below the threshold", () => {
    const provider = staticAtmosphereProvider(
      500,
      REENTRY_DESCENT_SPEED_U_S - 1,
      TERRAN,
      PLANET_ATMO,
    );
    const markup = renderToStaticMarkup(createElement(ReentryOverlay, { provider }));
    expect(markup).toBe("");
  });

  it("renders nothing when there is no atmosphere (boundary = 0)", () => {
    const provider = staticAtmosphereProvider(
      500,
      REENTRY_DESATURATION_PEAK_U_S * 2,
      NO_ATMO_PLANET,
      NO_ATMO,
    );
    const markup = renderToStaticMarkup(createElement(ReentryOverlay, { provider }));
    expect(markup).toBe("");
  });

  it("renders with reentry-alpha 1 at peak descent", () => {
    const provider = staticAtmosphereProvider(
      0,
      REENTRY_DESATURATION_PEAK_U_S * 2,
      TERRAN,
      PLANET_ATMO,
    );
    const markup = renderToStaticMarkup(createElement(ReentryOverlay, { provider }));
    expect(markup).toContain('data-testid="drift-reentry-overlay"');
    const alpha = parseFloat(readAttr(markup, "data-reentry-alpha") ?? "0");
    expect(alpha).toBeCloseTo(1, 2);
  });

  it("renders at half-alpha when descent is at the midpoint", () => {
    const mid = (REENTRY_DESCENT_SPEED_U_S + REENTRY_DESATURATION_PEAK_U_S) / 2;
    const provider = staticAtmosphereProvider(0, mid, TERRAN, PLANET_ATMO);
    const markup = renderToStaticMarkup(createElement(ReentryOverlay, { provider }));
    const alpha = parseFloat(readAttr(markup, "data-reentry-alpha") ?? "0");
    expect(alpha).toBeCloseTo(0.5, 1);
  });

  it("ignores ascent (negative descent speed)", () => {
    const provider = staticAtmosphereProvider(0, -1000, TERRAN, PLANET_ATMO);
    const markup = renderToStaticMarkup(createElement(ReentryOverlay, { provider }));
    expect(markup).toBe("");
  });

  it("exposes the orange reentry colour as a data attribute", () => {
    const provider = staticAtmosphereProvider(
      0,
      REENTRY_DESATURATION_PEAK_U_S,
      TERRAN,
      PLANET_ATMO,
    );
    const markup = renderToStaticMarkup(createElement(ReentryOverlay, { provider }));
    const color = readAttr(markup, "data-reentry-color");
    // 1.0, 0.55, 0.25 — the spec orange.
    expect(color).toBe("1.0000,0.5500,0.2500");
  });
});

// ---------------------------------------------------------------------------
// TASK-59 — the mobile profile drops the dome shader for a flat haze
// ---------------------------------------------------------------------------

describe("AtmosphereOverlay — flat haze mode (TASK-59)", () => {
  it("renders the radial dome gradient on a desktop profile", () => {
    const markup = renderToStaticMarkup(
      createElement(AtmosphereOverlay, {
        provider: staticAtmosphereProvider(20_000, -400, TERRAN, PLANET_ATMO),
      }),
    );
    expect(markup).toContain('data-atmosphere="dome"');
    expect(markup).toContain("radial-gradient");
  });

  it("renders a flat colour wash when the mobile profile is in force", () => {
    settingsBridge.setSignals({ maxTouchPoints: 5, deviceMemory: 4, hardwareConcurrency: 4 });
    settingsStore.setDeviceProfile("mobile");
    settingsBridge.apply(settingsStore.getSnapshot());
    try {
      const markup = renderToStaticMarkup(
        createElement(AtmosphereOverlay, {
          provider: staticAtmosphereProvider(20_000, -400, TERRAN, PLANET_ATMO),
        }),
      );
      expect(markup).toContain('data-atmosphere="haze"');
      expect(markup).not.toContain("radial-gradient");
    } finally {
      settingsStore.setDeviceProfile("auto");
      settingsBridge.setSignals({ maxTouchPoints: 0 });
      settingsBridge.apply(settingsStore.getSnapshot());
    }
  });
});
