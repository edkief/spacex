# TASK-70 handoff

## Status
Task **NOT** complete. The fixture, page object, and three spec files (`render-smoke`, `core-flow`, `presence`, `chat`) plus updates to the existing five specs are written, and `npm run test:e2e` now spawns its own dev server. The render-smoke spec boots and runs end-to-end but the headless WebGL canvas still comes back as a solid clear-colour when sampled via the 2D-canvas `drawImage` path — the WebGL `preserveDrawingBuffer: true` flag is set but pixels are uniform. This is the one open blocker preventing TASK-70 from being marked done.

## Done

### Code / fixtures written
- `app/tests/e2e/fixtures.ts` — Playwright worker-scoped fixture. Spawns `npm run dev --silent` with `PORT=<random>` + `API_PORT=<random+1>` + `DB_DRIVER=sqlite` + `DB_PATH=<tmp>/drift.db` + `GALAXY_SEED=E2E-<worker>-<ts>` + `SESSION_SECRET` (read from `.env.local`, fallback to the prereq value). Waits for `/api/health` on the API port. SIGTERMs the child + `rm -rf` the tmp dir on teardown. Exposes `DriftServer` with `baseURL`, `apiURL`, `wsURL`, `tmpDir`, `galaxySeed`. Also exports `sampleCanvasPixels(page, 32)` helper that reads a `w × h` patch via a 2D scratch canvas.
- `app/tests/e2e/pages/claim.ts` — `ClaimPage` page object holding the `drift-canvas` / `drift-header` / `drift-player-list*` / `drift-chat-log*` / `drift-toast-stack` selectors + `bootAndWaitForOnline`, `currentCallsign`, `currentSystemId`, `joinSystem`, `sendChat`, `chatSnapshot` helpers. Takes `server: DriftServer` in the constructor so all `page.goto` and `request.*` calls use the random-port URLs.
- `app/tests/e2e/render-smoke.spec.ts` — single spec: boots app, waits 250 ms, asserts pixel variance > 0. **Currently failing** with `variance = -1e-12` (essentially zero — solid clear colour).
- `app/tests/e2e/core-flow.spec.ts` — claim → handshake → join → canvas + player list.
- `app/tests/e2e/presence.spec.ts` — two-context mutual visibility (rewritten to use the fixture).
- `app/tests/e2e/chat.spec.ts` — two-context chat, 2 s SLA + XSS inert-text assertion (rewritten to use the fixture).
- `app/tests/e2e/scaffold.spec.ts` (rewritten), `app/tests/e2e/livery.spec.ts` (rewritten), `app/tests/e2e/prediction.spec.ts` (rewritten), `app/tests/e2e/reconnect.spec.ts` (rewritten) — all migrated to use `./fixtures.js` + `server.baseURL` / `server.apiURL` instead of the old `localhost:3000` + external `npm run dev` assumption.
- `app/src/client/components/CanvasStage.tsx` — minimal raw-WebGL starfield renderer: 200 seeded points (LCG with seed `0xc0ffee ^ dpr`), additive blending, point-size proportional to viewport, soft-edged disc fragment shader, deep-navy clear colour. Sets `preserveDrawingBuffer: true`. Falls back to `data-drift-no-webgl="1"` + a flat dark fill (no console error) if the WebGL context is unavailable. Uses `ResizeObserver` to redraw on viewport changes.
- `app/playwright.config.ts` — `webServer` block removed (fixture handles lifecycle). Documents the chromium-1248 executable-path override and notes that `--use-gl=angle --use-angle=swiftshader` would be the documented knob if a future sandbox needs it (we don't).
- `app/package.json` — added `"test:e2e": "playwright test"`. Vitest config already excludes `tests/**` from the `test` glob.

### Verified
- `tsc --noEmit` clean across the whole workspace.
- `vite` reports binding `[::1]:<port>` only (IPv6 loopback), not `127.0.0.1`. **Therefore `findFreePort` must bind to `"::1"`** and the URLs use `localhost` (which `getent hosts localhost` resolves to `::1` on this box). Both fixes applied. Without the `::1` binding tweak the page hits `ERR_CONNECTION_REFUSED` even though `/api/health` succeeds.
- WebGL2 context is available in the sandbox chromium (`getContext('webgl2')` returns a non-null context). Verified with a standalone test.

## Working tree
All changes are **uncommitted** (one-block commit below). Working tree at hand-off:

```
M app/package.json
M app/playwright.config.ts
M app/src/client/components/CanvasStage.tsx
M app/tests/e2e/chat.spec.ts
M app/tests/e2e/livery.spec.ts
M app/tests/e2e/prediction.spec.ts
M app/tests/e2e/presence.spec.ts
M app/tests/e2e/reconnect.spec.ts
M app/tests/e2e/scaffold.spec.ts
?? app/tests/e2e/core-flow.spec.ts
?? app/tests/e2e/fixtures.ts
?? app/tests/e2e/pages/
?? app/tests/e2e/render-smoke.spec.ts
```

`tsc --noEmit` is clean. `vitest` has not been re-run end-to-end but the e2e tests live outside its include glob (`vitest.config.ts` only matches `src/**/*.test.ts(x)` + `prereqs.test.ts`), so the unit suite should be unaffected.

## Next steps
1. **Diagnose the WebGL pixel-sampling issue.**
   The starfield is being drawn (no console errors, the React mount path runs the `useEffect`, the WebGL context is created — confirmed by the `chromium-1248` standalone test). But `getImageData` from a 2D scratch canvas reads back only the clear colour, not the rendered points.
   Possible causes to investigate:
   - **React double-mount in StrictMode.** `main.tsx` wraps `<App />` in `<StrictMode>`. The first mount's `useEffect` runs and draws, then the cleanup runs, then the second mount draws again. If the cleanup tears down the WebGL context (it doesn't, currently) or if React clears the canvas between mounts, the second draw may not have happened yet at the time we sample. The 250 ms wait might not be enough — try `await page.waitForFunction(() => /* WebGL has rendered */)` or hook a `__driftRendered` flag onto `window` from the `apply()` callback in the effect.
   - **`preserveDrawingBuffer: true` semantics under headless.** The chromium-1248 headless renderer may not honour the flag the same way the headed one does, OR the canvas is composited by a separate GPU process that the 2D `drawImage` path doesn't see. Try alternative readback paths:
     - `gl.readPixels` directly (synchronous, reads from the bound framebuffer).
     - `canvas.toDataURL('image/png')` then decode in Node and compute variance.
     - Take a Playwright `page.screenshot({clip: {x, y, width, height}})` of just the canvas region and use `sharp`/`pngjs` in the test to compute pixel variance.
   - **`getContext('webgl')` returning null under React StrictMode.** If StrictMode tears down and remounts the canvas, the second `getContext` returns the *same* context but the draw hasn't happened yet at the 250 ms mark. Add a `window.__driftCanvasReady` flag from the effect that fires after the first successful `draw()` call.
2. **Verify all four NEW specs pass** (`render-smoke`, `core-flow`, `presence`, `chat`).
4. **Verify the migrated specs still pass** (`scaffold`, `livery`, `prediction`, `reconnect`). They share the same worker-scoped fixture so the dev server is reused.
5. **Run `npm run test` (vitest)** to confirm the unit suite is unaffected.
6. **Lint + typecheck** the changed files (the e2e files live under `tests/`, which is excluded from the `eslint .` glob — verify this is still the case).
7. **Commit** the work in two pieces: `feat(TASK-70): Playwright e2e harness` (fixtures + page object + starfield + scripts + config) and `test(TASK-70): e2e specs for core flow + presence + chat + WebGL smoke`.
8. **Update `.ralph/STRUCTURE.md`** with the new `tests/e2e/fixtures.ts` + `tests/e2e/pages/` paths and the new `dev`/`test:e2e` wiring.
9. **Log to `.ralph/logs/LOG.md`** with screenshots + summary.
10. Set `passes: true` in `.ralph/tasks.json` only after steps 1–9 are all green.

## Dead ends
- **`__dirname` in ESM.** First version of `fixtures.ts` used `__dirname` to resolve the `app/` root — Playwright threw `ReferenceError: __dirname is not defined`. Switched to `import.meta.url` + `fileURLToPath`.
- **`127.0.0.1` vs `::1` for Vite.** Vite binds `[::1]:PORT` only (verified with `ss -tlnp`); Fastify binds `0.0.0.0:API_PORT`. `page.goto('http://127.0.0.1:<vitePort>/')` was refused with `ERR_CONNECTION_REFUSED` even though `/api/health` succeeded. Fixed by binding `findFreePort` to `"::1"` and using `localhost` in all URLs. (`getent hosts localhost` → `::1` on this box.)
- **Direct `gl.readPixels` from the test page.** Considered but rejected: `readPixels` reads the back buffer which the browser may have already presented/swapped, leaving the read buffer empty. The 2D-canvas `drawImage` path is the documented workaround but as of this handoff it still returns solid clear colour — see Next steps.
- **`PLAYWRIGHT_START_SERVER` webServer config.** The old shared-server mode was incompatible with the new fixture (would race for `:3000`). The `webServer` block was removed; the fixture is now the only source of truth for the dev server lifecycle.

## How to verify
From `app/`:

```bash
# Type-check (must be clean).
npx tsc --noEmit

# Unit tests (must remain at green; e2e specs are excluded from the glob).
npm test

# Full e2e suite — self-contained, spawns its own dev server per worker.
# Expected: 8 specs pass. If render-smoke fails with variance ~ 0,
# the canvas is solid clear colour — see Next steps item 1.
npm run test:e2e

# Single spec for fast iteration on the WebGL smoke:
npx playwright test tests/e2e/render-smoke.spec.ts --reporter=list

# Screenshot output goes to:
#   app/../.ralph/screenshots/TASK-70-{1,2,3,4}.png
# (render-smoke, core-flow, presence, chat)
```

The fixture allocates a free port pair on the loopback interface, so multiple `npm run test:e2e` invocations can run side-by-side without colliding. The per-worker `DB_PATH` is `mkdtempSync('${os.tmpdir()}/drift-e2e-')` so sqlite state never collides between workers.