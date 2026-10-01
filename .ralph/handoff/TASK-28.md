# Handoff: TASK-28

## Status

TASK-28 is ~55% done and committed GREEN (full vitest suite 741 tests + tsc pass):
the shared boundary math (step 1), per-planet density, the inverted drag ramp, all
shared/sim tests, the fixed TASK-25 flight test, and the atmosphere dome module
(start of step 2). Remaining: WorldManager skybox crossfade wiring, the re-entry
tint overlay (step 3), and the e2e dome pixel probe (step 4). The design for all
remaining work is decided and listed below — no exploration needed.

## Done

All in commit `44202f3` (verified green before commit; working tree has only this handoff):

1. **`app/src/shared/physics/atmosphere.ts`** — single shared boundary number:
   - `boundaryFactor(alt, planet)`: 1 at surface → 0 at/above `atmosphereRadius`; airless = 0 everywhere.
   - `densityScale(atmosphereDensity)` (ref `ATMOSPHERE_REF_DENSITY = 0.1`), `hazeFactor(alt, planet)` = boundary × density.
   - `reentryTintFactor(descentSpeed, boundary)`: cosmetic orange ramp > `REENTRY_TINT_SPEED` (200 u/s), max `REENTRY_TINT_MAX` (0.4), × boundary. Documented assumption: re-entry heating NOT simulated in v1.
   - The old `atmosphereFactor` ramp was INVERTED by design (deleted): the spec's continuity AC requires drag → 0 at the enter radius; the old ramp was full-k there, a hard kick at the space→atmosphere regime switch.
2. **`app/src/shared/physics/flight.ts`** — drag calls `boundaryFactor`; `PlanetAtmo` gains `atmosphereRadius`; `integrateStep` takes the planet.
3. **`app/src/shared/galaxy/planets.ts`** — `planetAtmosphereDensity(planet)`: class base (rocky 0.04, ice 0.05, terran 0.08, ocean 0.1, gas 0.12) × seeded [0.5, 1.0) via `hash2(seedFromString(planet.id), 0x57413417n)`.
4. **`app/src/server/shard/shard.ts`** — per-planet density+radius into the flight context; `ATMO_DENSITY` constant removed (also from `shard/index.ts` exports).
5. **Tests** — `app/src/shared/physics/atmosphere.test.ts` (NEW: blend math, density scaling, > 20 % mid-boundary difference, tint ramp); `flight.test.ts` (continuity of drag acceleration at every boundary altitude incl. both kinks, entry-at-100 u/s 10 s profile vs fine-dt (1e-4 s) analytic ODE within 2 %, terminal velocity rewritten as LOCAL equilibrium `sqrt(g/(k·f(alt)))`, tint test); `planets.test.ts` (airless = 0, deterministic, seeded pair > 20 % haze diff — pure-math counterpart of the render test); `__fixtures__/flight-atmo-30s.json` regenerated.
6. **`app/src/server/shard/shard.regime.test.ts`** (TASK-25) — FIXED for the new physics: the scripted ascent is now a SUSTAINED climb (`entity.ship.vel.y = 100` injected every tick during the 'ascent' phase) instead of one 4000 u/s kick. Why: under the surface-dense ramp a ballistic kick from the ground is capped at ~210 u of climb (local terminal ~19 u/s is an unstable equilibrium) — short of the ~460 u climb needed from the ship's 945 u anchor X-offset to the 1050 u exit radius. All 4 tests pass.
7. **`app/src/client/render/atmosphere-dome.ts`** (NEW) + `atmosphere-dome.test.ts` (5 tests) — back-face sphere, `THREE.ShaderMaterial` with `gl_FragColor = vec4(mix(uSkyColor, uAtmoColor, uHaze), uHaze)`; `side: BackSide, transparent, depthWrite: false, renderOrder: 1`; hidden when haze ≤ 1e-4 (zero cost in space); geometry radius = `radiusU × DOME_RADIUS_FACTOR (1.01)` per spec; `ATMOSPHERE_HAZE_COLORS` per planet class; `DOME_SKY_COLOR = '#0c131f'` (skybox gradient average). `set(haze, atmoColor, skyColor?)` copies color components VERBATIM into the Vector3 uniforms.

## Working tree

Committed: everything above in `44202f3` — builds green (`npx vitest run` 741 pass/1 skip, `npx tsc --noEmit` clean, eslint/prettier clean on touched files). Uncommitted: ONLY the rewrite of this handoff file (`.ralph/handoff/TASK-28.md`). No background processes running (no dev server was started; e2e fixtures boot their own). Nothing else pending.

## Next steps

### A. `app/src/client/world/atmosphere-view.ts` (NEW, pure, ~60 lines)

```ts
import { regimeFor, type Regime } from '@shared/regime';
import { systemRegimePlanets, planetAtmosphereRadius, planetAtmosphereDensity } from '@shared/galaxy/planets';
import { boundaryFactor, hazeFactor } from '@shared/physics/atmosphere';

export interface AtmosphereView { planet: Planet | null; altitude: number; boundary: number; haze: number }
export function atmosphereViewFor(pos: Vec3, system: SystemGen | null, current: Regime = 'space'): AtmosphereView
```
- `regimeFor(pos, systemRegimePlanets(system), current, 0)`; if result.regime is 'space' → `{ planet: null, altitude: pos.y, boundary: 0, haze: 0 }`. Passing the LIVE regime as `current` keeps the exit hysteresis band [1000, 1050) consistent with the sim.
- Else `planet = system.planets.find(p => p.id === result.planetId)`; `altitude = pos.y` (flat client terrain; anchors sit at y=0); `boundary = boundaryFactor(altitude, planet)`; `haze = hazeFactor(altitude, { atmosphereRadius: planetAtmosphereRadius(planet), atmosphereDensity: planetAtmosphereDensity(planet) })`.
- Unit test (fixture-system pattern from `app/src/client/state/regime-wiring.test.ts`): mid-altitude haze/boundary values, space → null, hysteresis (band + current 'atmosphere' → planet kept; current 'space' → null).

### B. WorldManager wiring (`app/src/client/world/WorldManager.ts`, +~40 lines)

- Keep `private system: SystemGen | null` (set in `swapWorld`; also store it — `currentSystemId` is a string, not the object).
- Constructor: `this.dome = createAtmosphereDome(ATMOSPHERE_BOUNDARY_M)`; `scene.add(this.dome.mesh)`; set sky material `transparent: true` (opacity starts 1); base star opacity is 0.95.
- New method — ONE number drives dome AND skybox (the spec's no-desync contract):
```ts
setAtmosphereView(pos: Vec3, current: Regime = 'space'): void {
  const view = atmosphereViewFor(pos, this.system, current);
  if (view.planet) {
    const anchor = planetAnchor(this.system!.planets.indexOf(view.planet));
    this.dome.mesh.position.set(anchor.x, 0, anchor.z);
    this.dome.set(view.haze, this.tempColor.setRGB(hexTo01(ATMOSPHERE_HAZE_COLORS[view.planet.class])));
  } else {
    this.dome.set(0, this.tempColor);
  }
  const fade = 1 - view.haze;
  (this.background.sky.material as THREE.MeshBasicMaterial).opacity = fade;
  (this.background.stars.material as THREE.PointsMaterial).opacity = 0.95 * fade;
}
```
  Reuse one member `THREE.Color`; build colors with `setRGB(r/255, g/255, b/255, THREE.NoColorSpace)` (see Dead ends re: color spaces). `dispose()` the dome.

### C. Re-entry tint (step 3) — CSS overlay (cheapest option per spec; matches `ui/warp-overlay.tsx`)

- `app/src/client/state/reentry.ts` (NEW, ~30 lines): module state `setReentryTint(v)` (clamp [0, REENTRY_TINT_MAX], emit only on change), `reentryTint()`, `reentryTintSubscribe(fn) → unsubscribe` (pattern: `app/src/client/state/warp.ts`).
- `app/src/client/ui/reentry-tint.tsx` (NEW, ~50 lines): `<div id="reentry-tint" aria-hidden>` — `position: fixed; inset: 0; pointerEvents: 'none'; zIndex: 80; opacity: tint`, orange rim: `background: radial-gradient(ellipse at center, rgba(255,120,30,0) 55%, rgba(255,120,30,0.9) 100%)`; return null when tint ≤ 0.
- `app/src/client/state/regime-wiring.ts`: keep `private systemPlanets: Planet[] = []` (set in `setSystem` from `systemForId(...)?.planets ?? []`); add:
```ts
atmosphereBoundaryAt(pos: Vec3): number {
  if (this.tracker.regime === 'space' || !this.tracker.planetId) return 0;
  const planet = this.systemPlanets.find((p) => p.id === this.tracker.planetId);
  return planet ? boundaryFactor(pos.y, planet) : 0;
}
```
  (`RegimeTracker` exposes `regime` and `planetId` getters; RegimePlanet lacks class/density, hence the Planet[] mirror.)
- `app/src/client/main.tsx`: in the self `entity_update` handler, after `regimeWiring.onSelfUpdate(self, Date.now())`:
```ts
const boundary = regimeWiring.atmosphereBoundaryAt(self.pos);
setReentryTint(boundary > 0 ? reentryTintFactor(-self.vel.y, boundary) : 0);
worldRef.current?.setAtmosphereView(self.pos, regimeWiring.regime); // step-2 live path
```
  (ascending → `-vel.y < 0` → factor 0 ✓). Also `setReentryTint(0)` in `onSnapshot` (warp arrival). Mount `<ReentryTint />` next to `<WarpOverlay />` (line ~427).
- Tests: `reentry.test.ts` (state module: clamp/emit-once/subscribe), `reentry-tint.test.tsx` (`renderToStaticMarkup` pattern from `ui/debug-overlay.test.tsx` — set state, render, assert `id="reentry-tint"` + opacity value; null at 0), extend `regime-wiring.test.ts` for `atmosphereBoundaryAt` (0 in space; 0.5 at alt 500 after an 'atmosphere' authority update at `IN_ATMOSPHERE`; 0 at alt 1200).

### D. E2E render probe (step 4) — dev hook + Playwright spec

- `app/src/client/atmosphere-debug.ts` (NEW, ~150 lines; pattern: `app/src/client/camera/camera-debug.ts`): `installAtmosphereDebug()` (gated on `import.meta.env.DEV`) → `window.__ATMO__.midBoundaryComparison()`:
  - seed from `window.__DRIFT__.seed` (fed from /api/health, no login needed); scan `generateStars(seed)` (≤ 40 systems) via `generateSystem(seed, star.id)`; collect atmospheric planets with `hazeMid = hazeFactor(ATMOSPHERE_BOUNDARY_M / 2, { atmosphereRadius: planetAtmosphereRadius(p), atmosphereDensity: planetAtmosphereDensity(p) })`; take the min- and max-density pair (the spec AC is relative diff > 0.2 — fail loudly if no such pair exists).
  - For each planet: offscreen `document.createElement('canvas')` 128×72, `THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true })`, `scene.background = new THREE.Color('#0d1626')`; dome = `createAtmosphereDome(planetAtmosphereRadius(p))` positioned at `planetAnchor(index)` (index within that system's planets); camera at anchor + (0, 500, 0) looking horizontal (`lookAt(anchor.x, 500, anchor.z + 100)`), far 5000; `dome.set(hazeMid, ...)`; **then override the uniforms with RAW sRGB floats** (`(dome.material.uniforms.uAtmoColor.value as THREE.Vector3).set(r/255, g/255, b/255)` from `ATMOSPHERE_HAZE_COLORS[cls]`, and same for `uSkyColor` = the clear color — this makes the raw ShaderMaterial output free of color-space transforms so the expected pixel is exact); `renderer.render(scene, camera)`; `gl.readPixels` the center pixel; dispose everything.
  - Return `{ seed, a: { systemId, planetId, planetClass, density, hazeMid, pixel, expected }, b: {...}, hazeDiff, pixelError }` where `expected[channel] = lerp(clearF, atmoF, hazeMid) * 255`, `pixelError = max |pixel - expected|`.
  - `main.tsx`: add `installAtmosphereDebug();` next to the other installers (bottom of file, after `installCameraDebug()`).
- `app/tests/e2e/atmosphere.spec.ts` (NEW; pattern: `tests/e2e/streaming-budget.spec.ts`): `test.setTimeout(60_000)`; goto `e2eServer.baseURL`; poll `window.__DRIFT__?.seed` until non-null; `page.evaluate(() => window.__ATMO__!.midBoundaryComparison())`; assert `hazeDiff > 0.2`, `pixelError ≤ 3` (rendered dome color matches the shared-math mix — the density scaling is visibly in the pixels), and the two sampled pixels differ (max per-channel diff > 5); `console.log` the recorded values (like TASK-26.2); `page.screenshot({ path: '.../.ralph/screenshots/TASK-28-1.png' })`; `assertClean()`.
- No login needed: the hook installs at module load and the seed arrives unauthenticated.

### E. Close-out

- Run in order: `cd app && npx vitest run` (~85 s), `npx tsc --noEmit`, `npx eslint --fix` + `npx prettier --write` on touched files, `npx playwright test tests/e2e/atmosphere.spec.ts` (fixtures boot the real app themselves — do NOT start `npm run dev` manually).
- Playwright smoke of the running app (console clean) + screenshot per AGENTS.md → `.ralph/screenshots/TASK-28-{n}.png`.
- Mark `passes: true` for TASK-28 in `.ralph/tasks.json` + set the 4 step `pass` flags in `.ralph/tasks/TASK-28.json` (check how recent tasks recorded step passes); newest-first entry in `.ralph/logs/LOG.md` with screenshot paths; update `.ralph/STRUCTURE.md` only if dirs changed (none expected — all new files live in existing dirs); DELETE `.ralph/handoff/TASK-28.md` in the final commit; commit; output `<promise>TASK-28:DONE</promise>` and stop.

## Dead ends

- **A single impulse can never escape the atmosphere under the new ramp.** Kick of any size from the ground caps at ~210 u of climb (local terminal speed near the surface is an unstable equilibrium: at equilibrium, dw/dh < 0). The ship in the TASK-25 script is ~945 u from the anchor in X, needing ~460 u of climb to the 1050 u exit radius. Fixed with a sustained scripted `vel.y = 100`/tick climb — keep it; do not "simplify" back to a kick.
- **three.js ColorManagement vs the raw dome shader.** `new THREE.Color(hex)` converts sRGB → linear working space, but the custom `ShaderMaterial` writes `gl_FragColor` with no output transform. If you feed it a `new THREE.Color(hex)` the dome renders too dark and the e2e pixel math breaks. Always feed raw 0..1 sRGB floats (the dome's `set()` copies components verbatim; use `setRGB(..., THREE.NoColorSpace)` or set uniform Vector3s directly in the probe).
- **`preserveDrawingBuffer: true` is required** for the e2e `readPixels` outside the rAF loop (headless SwiftShader) — keep it on the probe renderer.
- The regime machine's hysteresis means the [1000, 1050) distance band can be 'space' OR 'atmosphere' depending on history — that is why `atmosphereViewFor` takes a `current: Regime` parameter; always pass the live tracker regime from main.tsx.
- Vitest start time matters: files created after `vitest run` begins are not picked up — re-run single files when in doubt (bit this session: a full-suite "green" that had not included the newest test file).

## How to verify

Task spec: `.ralph/tasks/TASK-28.json`. Step 1 + dome module (part of step 2) are done and committed green. Steps A-D above finish it; step E is close-out. Quick sanity for the already-committed work: `cd app && npx vitest run src/shared/physics src/shared/galaxy src/server/shard/shard.regime.test.ts src/client/render/atmosphere-dome.test.ts && npx tsc --noEmit`.
