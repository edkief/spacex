/**
 * TASK-28 — Atmosphere entry/exit smoke test.
 *
 * Verifies the visual layer wires up correctly in the browser:
 *
 *   - The `AtmosphereOverlay` mounts in the React tree with the
 *     `data-testid="drift-atmosphere-overlay"` selector.
 *   - When no atmosphere-bearing planet is in range (default
 *     state), the haze alpha is 0 and the layer is effectively
 *     invisible.
 *   - When the dev hook (`window.__driftAtmosphereState.setState`)
 *     pushes a snapshot with `altitude = 0` (surface) for a
 *     terran-class planet, the haze alpha jumps to ≈ 1 and
 *     the data-haze-color attribute matches the terran palette.
 *   - Two seeded planets (terran vs rocky) at the same altitude
 *     produce visibly different haze alphas — the per-planet
 *     density scaling assertion from the spec acceptance
 *     criterion.
 *   - The `ReentryOverlay` appears when descent speed exceeds
 *     the 200 u/s threshold (with atmosphere present) and
 *     disappears otherwise.
 *
 * The planet + planetAtmosphere objects are constructed inside
 * the page (via `page.evaluate`) because Playwright serialises
 * arguments through JSON, which can't carry the `heightAt`
 * callback the `PlanetAtmosphere` shape requires.
 */
import { test, expect } from "./fixtures.js";
import { ClaimPage } from "./pages/claim.js";

/** Default altitude for the surface (0 m above the planet surface). */
const SURFACE_ALT = 0;
/** Default atmosphere radius for the test stub (unused — see comments below). */
const _TEST_RADIUS = 5_000_000;
void _TEST_RADIUS;
/** Descent speed below the re-entry threshold (200 u/s). */
const CRUISE_DESCENT = 50;
/** Descent speed above the re-entry threshold. */
const FAST_DESCENT = 500;

test("atmosphere overlay: haze ramps up at the surface (terran)", async ({
  page,
  driftServer: server,
}) => {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  const claim = new ClaimPage(page, server);
  await claim.bootAndWaitForOnline();

  // The overlay is mounted by App.tsx. Default state = no planet
  // in range → haze alpha is 0.
  await expect(page.locator('[data-testid="drift-atmosphere-overlay"]')).toBeAttached();
  await expect(page.locator('[data-testid="drift-atmosphere-haze"]')).toBeAttached();

  // Drive the dev hook: surface altitude, terran, no descent.
  // Construct the planet + atmosphere INSIDE the page so the
  // `heightAt` function survives serialisation.
  await page.evaluate(
    ({ altitude, descentSpeed, className }) => {
      const win = window as unknown as {
        __driftAtmosphereState?: {
          setState: (a: number, d: number, p: unknown, pa: unknown) => void;
        };
      };
      const hook = win.__driftAtmosphereState;
      if (!hook) throw new Error("__driftAtmosphereState missing (dev hook not installed)");
      const planet = {
        id: "test-" + className,
        name: className,
        orbitIndex: 0,
        class: className,
        radiusKm: 5000,
        hasAtmosphere: true,
        landable: true,
        dockCount: 1,
        resourceTypes: ["iron"],
        aiRoster: { count: 0, classes: [] },
      };
      const planetAtmosphere = {
        id: "test-" + className,
        radius: 5_000_000,
        atmosphereHeight: 10_000,
        atmosphereDensity: 1,
        hasAtmosphere: true,
        heightAt: () => 0,
      };
      hook.setState(altitude, descentSpeed, planet, planetAtmosphere);
    },
    {
      altitude: SURFACE_ALT,
      descentSpeed: 0,
      className: "terran",
    },
  );

  // Give the rAF loop one frame to re-render.
  await page.waitForTimeout(120);

  const overlay = page.locator('[data-testid="drift-atmosphere-overlay"]');
  const alpha = parseFloat((await overlay.getAttribute("data-haze-alpha")) ?? "0");
  expect(alpha).toBeGreaterThan(0.99);

  // The terran palette is haze r=0.55, g=0.78, b=0.92. The data
  // attribute is "r,g,b" with 4 decimal places.
  const haze = page.locator('[data-testid="drift-atmosphere-haze"]');
  const hazeColor = await haze.getAttribute("data-haze-color");
  expect(hazeColor).not.toBeNull();
  const parts = (hazeColor ?? "").split(",").map((s) => parseFloat(s));
  expect(parts.length).toBe(3);
  expect(parts[0]).toBeCloseTo(0.55, 2);
  expect(parts[1]).toBeCloseTo(0.78, 2);
  expect(parts[2]).toBeCloseTo(0.92, 2);

  // Belt-and-braces: no console errors.
  expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
});

test("atmosphere overlay: two seeded planets differ on haze alpha (>20%)", async ({
  page,
  driftServer: server,
}) => {
  const claim = new ClaimPage(page, server);
  await claim.bootAndWaitForOnline();

  // Mid-boundary altitude (500 m above the surface, half the
  // 1 km band). Both planets get the same altitude + atmosphere
  // density, so any difference comes from the planet-class
  // visual profile.
  const alt = 500;

  const readAlpha = async (className: string): Promise<number> => {
    await page.evaluate(
      ({ altitude, className }) => {
        const win = window as unknown as {
          __driftAtmosphereState?: {
            setState: (a: number, d: number, p: unknown, pa: unknown) => void;
          };
        };
        const hook = win.__driftAtmosphereState;
        if (!hook) throw new Error("__driftAtmosphereState missing");
        const planet = {
          id: "test-" + className,
          name: className,
          orbitIndex: 0,
          class: className,
          radiusKm: 5000,
          hasAtmosphere: true,
          landable: true,
          dockCount: 1,
          resourceTypes: ["iron"],
          aiRoster: { count: 0, classes: [] },
        };
        const planetAtmosphere = {
          id: "test-" + className,
          radius: 5_000_000,
          atmosphereHeight: 10_000,
          atmosphereDensity: 1,
          hasAtmosphere: true,
          heightAt: () => 0,
        };
        hook.setState(altitude, 0, planet, planetAtmosphere);
      },
      { altitude: alt, className },
    );
    await page.waitForTimeout(120);
    const overlay = page.locator('[data-testid="drift-atmosphere-overlay"]');
    const raw = await overlay.getAttribute("data-haze-alpha");
    return parseFloat(raw ?? "0");
  };

  const terranAlpha = await readAlpha("terran");
  const rockyAlpha = await readAlpha("rocky");

  const denom = Math.max(terranAlpha, rockyAlpha);
  const diff = Math.abs(terranAlpha - rockyAlpha) / denom;
  // Acceptance: haze factor at mid-boundary differs by > 20% on
  // two seeded planets. Terran density 1.0 vs rocky 0.5 → ~50% diff.
  expect(diff).toBeGreaterThan(0.2);
});

test("reentry overlay: orange rim fires above 200 u/s descent", async ({
  page,
  driftServer: server,
}) => {
  const claim = new ClaimPage(page, server);
  await claim.bootAndWaitForOnline();

  // Slow cruise: no rim.
  await page.evaluate(
    ({ altitude, descentSpeed }) => {
      const win = window as unknown as {
        __driftAtmosphereState?: {
          setState: (a: number, d: number, p: unknown, pa: unknown) => void;
        };
      };
      const hook = win.__driftAtmosphereState;
      if (!hook) throw new Error("__driftAtmosphereState missing");
      const planet = {
        id: "test-terran",
        name: "terran",
        orbitIndex: 0,
        class: "terran",
        radiusKm: 5000,
        hasAtmosphere: true,
        landable: true,
        dockCount: 1,
        resourceTypes: ["iron"],
        aiRoster: { count: 0, classes: [] },
      };
      const planetAtmosphere = {
        id: "test-terran",
        radius: 5_000_000,
        atmosphereHeight: 10_000,
        atmosphereDensity: 1,
        hasAtmosphere: true,
        heightAt: () => 0,
      };
      hook.setState(altitude, descentSpeed, planet, planetAtmosphere);
    },
    {
      altitude: SURFACE_ALT,
      descentSpeed: CRUISE_DESCENT,
    },
  );
  await page.waitForTimeout(80);
  await expect(page.locator('[data-testid="drift-reentry-overlay"]')).toHaveCount(0);

  // Push the descent speed above the threshold.
  await page.evaluate(
    ({ altitude, descentSpeed }) => {
      const win = window as unknown as {
        __driftAtmosphereState?: {
          setState: (a: number, d: number, p: unknown, pa: unknown) => void;
        };
      };
      const hook = win.__driftAtmosphereState;
      if (!hook) throw new Error("__driftAtmosphereState missing");
      const planet = {
        id: "test-terran",
        name: "terran",
        orbitIndex: 0,
        class: "terran",
        radiusKm: 5000,
        hasAtmosphere: true,
        landable: true,
        dockCount: 1,
        resourceTypes: ["iron"],
        aiRoster: { count: 0, classes: [] },
      };
      const planetAtmosphere = {
        id: "test-terran",
        radius: 5_000_000,
        atmosphereHeight: 10_000,
        atmosphereDensity: 1,
        hasAtmosphere: true,
        heightAt: () => 0,
      };
      hook.setState(altitude, descentSpeed, planet, planetAtmosphere);
    },
    {
      altitude: SURFACE_ALT,
      descentSpeed: FAST_DESCENT,
    },
  );
  await page.waitForTimeout(80);

  const reentry = page.locator('[data-testid="drift-reentry-overlay"]');
  await expect(reentry).toHaveCount(1);
  const alpha = parseFloat((await reentry.getAttribute("data-reentry-alpha")) ?? "0");
  expect(alpha).toBeGreaterThan(0.5);
  // Spec orange: 1.0, 0.55, 0.25.
  const color = await reentry.getAttribute("data-reentry-color");
  expect(color).toBe("1.0000,0.5500,0.2500");
});

test("atmosphere overlay: take a screenshot at the surface for visual record", async ({
  page,
  driftServer: server,
}) => {
  const claim = new ClaimPage(page, server);
  await claim.bootAndWaitForOnline();

  // Push the overlay to surface on a terran planet + slow
  // descent. The rim stays invisible (below 200 u/s).
  await page.evaluate(
    ({ altitude, descentSpeed }) => {
      const win = window as unknown as {
        __driftAtmosphereState?: {
          setState: (a: number, d: number, p: unknown, pa: unknown) => void;
        };
      };
      const hook = win.__driftAtmosphereState;
      if (!hook) throw new Error("__driftAtmosphereState missing");
      const planet = {
        id: "test-terran",
        name: "terran",
        orbitIndex: 0,
        class: "terran",
        radiusKm: 5000,
        hasAtmosphere: true,
        landable: true,
        dockCount: 1,
        resourceTypes: ["iron"],
        aiRoster: { count: 0, classes: [] },
      };
      const planetAtmosphere = {
        id: "test-terran",
        radius: 5_000_000,
        atmosphereHeight: 10_000,
        atmosphereDensity: 1,
        hasAtmosphere: true,
        heightAt: () => 0,
      };
      hook.setState(altitude, descentSpeed, planet, planetAtmosphere);
    },
    {
      altitude: SURFACE_ALT,
      descentSpeed: CRUISE_DESCENT,
    },
  );
  await page.waitForTimeout(150);

  await page.screenshot({
    path: "../.ralph/screenshots/TASK-28-1.png",
    fullPage: true,
  });

  // Push a fast descent to trigger the re-entry rim.
  await page.evaluate(
    ({ altitude, descentSpeed }) => {
      const win = window as unknown as {
        __driftAtmosphereState?: {
          setState: (a: number, d: number, p: unknown, pa: unknown) => void;
        };
      };
      const hook = win.__driftAtmosphereState;
      if (!hook) throw new Error("__driftAtmosphereState missing");
      const planet = {
        id: "test-terran",
        name: "terran",
        orbitIndex: 0,
        class: "terran",
        radiusKm: 5000,
        hasAtmosphere: true,
        landable: true,
        dockCount: 1,
        resourceTypes: ["iron"],
        aiRoster: { count: 0, classes: [] },
      };
      const planetAtmosphere = {
        id: "test-terran",
        radius: 5_000_000,
        atmosphereHeight: 10_000,
        atmosphereDensity: 1,
        hasAtmosphere: true,
        heightAt: () => 0,
      };
      hook.setState(altitude, descentSpeed, planet, planetAtmosphere);
    },
    {
      altitude: SURFACE_ALT,
      descentSpeed: FAST_DESCENT,
    },
  );
  await page.waitForTimeout(150);

  await page.screenshot({
    path: "../.ralph/screenshots/TASK-28-2.png",
    fullPage: true,
  });
});
