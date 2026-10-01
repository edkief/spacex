# HANDOFF — TASK-28.1 (atmosphere view: dome + skybox crossfade wiring)

## Status

All code is implemented and the full unit/typecheck/lint surface is GREEN, but the new e2e
smoke test FAILS: after my change the in-system skybox renders a FLAT GRADIENT WITH NO STAR
DOTS (pre-change screenshot `.ralph/screenshots/TASK-70-1.png` shows stars clearly). The dome
wiring itself is not the visual goal yet (that's TASK-28.3); this is a regression to fix in
the skybox/star draw order caused by making the sky material transparent.

## Done

- NEW `app/src/client/world/atmosphere-view.ts` — pure `atmosphereViewFor(pos, system, current='space')`
  + `interface AtmosphereView { planet, altitude, boundary, haze }`, exactly per spec:
  null system → space; `regimeFor(pos, systemRegimePlanets(system), current, 0)`; space regime →
  space result; else boundary = `boundaryFactor(alt, {atmosphereRadius: planetAtmosphereRadius(planet)})`,
  haze = `hazeFactor(alt, {atmosphereRadius, atmosphereDensity})` — both from the shared functions.
- NEW `app/src/client/world/atmosphere-view.test.ts` — 4 tests (mid-band boundary≈0.5 +
  haze = 0.5·densityScale from the SAME shared fns; far/null-system → 0/0/null; exit band [1000,1050)
  respects `current` regime; airless → null/0/0). All 4 PASS.
- MODIFIED `app/src/client/world/WorldManager.ts` — all spec step-2 wiring: imports,
  `private system: SystemGen | null`, `private readonly dome: AtmosphereDome`, `tempColor`,
  constructor sets `(sky.material as MeshBasicMaterial).transparent = true`,
  `this.dome = createAtmosphereDome(ATMOSPHERE_BOUNDARY_M)`, `scene.add(this.dome.mesh)`;
  `swapWorld` sets `this.system = system`; new `setAtmosphereView(pos, current)` (one haze
  number → `dome.set(view.haze, tint)` + `sky.opacity = 1 - haze` + `stars.opacity = 0.95*(1-haze)`);
  module fn `setFromHex01` (raw sRGB floats, `THREE.NoColorSpace` — the sRGB→linear dead end);
  `dome.dispose()` in dispose().
- MODIFIED `app/src/client/main.tsx` — `useGameSession` gained optional
  `onAtmosphereView?: (pos: Vec3, regime: Regime) => void`; entity_update handler calls
  `onAtmosphereView?.(self.pos, regimeWiring.regime)` right after `onSelfUpdate`; App passes a
  CLOSURE `(pos, regime) => { worldRef.current?.setAtmosphereView(pos, regime); }` (TDZ-safe:
  worldRef is declared ~line 349, after the hook call — the closure only reads it when a WS
  message fires). Type imports `Regime`/`Vec3` added.
- VERIFIED GREEN: `npx vitest run src/client/world/atmosphere-view.test.ts` (4/4), FULL
  `npx vitest run` = 744 pass / 1 skip (baseline was 741 pass / 1 skip, +4 new),
  `npm run typecheck` clean, `npm run lint` clean.

## Working tree

NOT committed (no commit made this session; baseline is HEAD `818f2c0`):
- M `app/src/client/main.tsx`
- M `app/src/client/world/WorldManager.ts`
- ?? `app/src/client/world/atmosphere-view.ts`
- ?? `app/src/client/world/atmosphere-view.test.ts`
- ?? `app/tests/e2e/atmosphere-view.spec.ts` (new e2e smoke test — currently FAILING, see below)
- ?? `app/test-results/` (e2e failure artifacts incl. the failure screenshot
  `test-results/atmosphere-view-*/test-failed-1.png` — shows flat starless sky; gitignored)

Builds: unit suite, typecheck, lint all green. The e2e spec fails (see Status).

## Next steps

1. FIX THE REGRESSION (root cause is draw-order between the now-transparent sky sphere and the
   star Points — both in the transparent pass, both at scene origin, both renderOrder 0).
   Empirical bisection (each e2e run ≈ 1 min, boots its own dev server — no `npm run dev` needed):
   (a) temporarily set the dome out of play (`this.dome.mesh.visible = false` already; try
   NOT calling `scene.add(this.dome.mesh)`) and re-run the e2e → isolates dome involvement;
   (b) temporarily skip `transparent = true` → confirms sky transparency is the trigger.
   `transparent = true` is REQUIRED (opacity blending only works on transparent materials), so
   the fix must keep it — expected fix: explicit renderOrder layering so sky < stars < dome
   (e.g. sky stays 0, stars `renderOrder = 1`, dome `renderOrder = 2` — verify the dome's
   existing `renderOrder = 1` in atmosphere-dome.ts is updated consistently, and re-check
   atmosphere-dome.test.ts expectations if any assert renderOrder).
   NOTE: my reading of three r0.186's `reversePainterSortStable` (transparent sort:
   groupOrder → renderOrder → z desc → object id) predicted sky (lower id) draws BEFORE stars
   and stars should stay visible — that theory is CONTRADICTED by the screenshot, so debug
   empirically (add a temporary console.log of `renderer.info.render.calls` + mesh visibility in
   the WorldManager frame loop, or a throwaway debug spec) instead of more theory.
2. Re-run `cd app && npx playwright test --config playwright.e2e.config.ts tests/e2e/atmosphere-view.spec.ts`
   until green (it writes the screenshot to `.ralph/screenshots/TASK-28.1-1.png` itself).
3. Then: full `npx vitest run` (~85 s, once), `npm run typecheck`, `npm run lint`,
   set `passes: true` for TASK-28.1 in `.ralph/tasks.json`, log to `.ralph/logs/LOG.md`,
   commit `feat(TASK-28.1): atmosphere view — dome + skybox crossfade wiring (one-number, no-desync blend)`.

## Dead ends

- The exact `python3` PIL script I was running to sample/crop the failure screenshot was
  aborted on timeout — do NOT re-run that command as-is; a plain `read` of
  `test-results/atmosphere-view-*/test-failed-1.png` shows the same thing (flat sky, no stars).
- The "stars must still be visible by id-tiebreak" theory (see Next steps) does NOT hold up —
  stop reasoning about three's sort, measure instead.
- Do not "fix" it by dropping `transparent = true` — that just hides the regression; the spec
  requires opacity-driven crossfade.

## How to verify

- Unit: `cd app && npx vitest run src/client/world/atmosphere-view.test.ts` (expect 4 pass)
- Full: `cd app && npx vitest run` (expect 744 pass / 1 skip)
- Types/lint: `cd app && npm run typecheck && npm run lint` (both currently clean)
- E2E (the failing gate): `cd app && npx playwright test --config playwright.e2e.config.ts tests/e2e/atmosphere-view.spec.ts`
  (currently: `expect(received).toBeGreaterThan(1)` received 0.1118 after 15 s poll timeout)
- Visual reference: flat starless sky = `app/test-results/atmosphere-view-*/test-failed-1.png`;
  correct stars-in-system view = `.ralph/screenshots/TASK-70-1.png`
