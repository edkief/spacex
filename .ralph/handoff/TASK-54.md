# Handoff: TASK-54

Written by Ralph: iteration 16 ran out of time; all implementation + unit tests
landed and are committed, the headline keyboard-only e2e is nearly green (one
remaining flake at a random step per run), the aria-coverage e2e is GREEN.

## Status

Not complete. Remaining work: stabilize `tests/e2e/keyboard-only.spec.ts`
(one timing/topology flake, see below), re-run it green, then close out.

## Done (committed)

- Full a11y implementation from the previous attempt KEPT + verified:
  - `src/shared/settings.ts` — shared `reduced-motion` setting key + defaults.
  - `src/client/a11y/` — announcement queue (max 1 pending, 2 s min interval,
    combat > navigation > chat priority), the 1 Hz `LiveRegion` (aria-live=polite,
    `hudSummary()` speech text), reduced-motion store + `useReducedMotion` hook.
  - `src/client/fx.ts` — reduced-motion FX gate + `fxCounts` played/skipped
    registry counters.
  - `main.tsx` — announcements wired (prompts, lock-on, low energy, kills),
    canvas `role="img"` + aria-label, `<LiveRegion />` mounted.
  - `threat-ping.tsx` static icon, `warp-overlay.tsx` plain fade (both
    reduced-motion), `esc-menu.tsx` reduced-motion toggle (role=switch).
  - `src/client/ui/theme.ts` — design tokens + `contrastRatio`/`relativeLuminance`;
    `theme.contrast.test.ts` asserts every token pair ≥ 4.5:1 (WCAG AA).
  - `app/src/server/routes/dev.ts` — `?systemId=` scoping on
    pad-target/terminal-target (keyboard e2e routing).
  - Unit tests (all green, part of the 168-file suite):
    `a11y/*.test.*`, `theme.contrast.test.ts`,
    `threat-ping.reduced-motion.test.tsx`, `warp-overlay.reduced-motion.test.tsx`.
- **Bug fixed this iteration (root-caused from the Playwright trace):**
  `src/client/hud/chat-log.tsx` — its window-level "Enter from anywhere opens
  chat" handler called `e.preventDefault()`, which suppressed the NATIVE Enter
  activation on the focused element (warp button, menu items). That made the
  entire keyboard-only loop impossible (Enter on the warp button did nothing).
  Now Enter inside any focused interactive control (`button, a, input, select,
  textarea, [role="button"], [tabindex]`) never opens chat. This is a real a11y
  defect fix, not a test workaround.
- **NEW e2e GREEN: `tests/e2e/aria-coverage.spec.ts`** (18.4 s) — walks claim,
  in-ship HUD, ESC menu (+ settings / reduced-motion toggle), star chart,
  shared ship panel, on-foot HUD, dock panel; asserts every VISIBLE interactive
  element has an accessible name (aria-label/aria-labelledby/placeholder/text),
  canvas role=img + label, live region mounted. Screenshots TASK-54-4..7.png.
- `tests/e2e/keyboard-only.spec.ts` — headline e2e, improved diagnostics
  (chart error-state + rendered-node list on the warp-node assert).
- Unit suite: 168 files / 1512 passed (one flake in
  `src/server/galaxy/enter-ship.ws.test.ts` under full-parallel load —
  passes 3/3 isolated, unrelated to this task; the only server change is the
  dev-only `?systemId` route param).
- eslint + prettier clean on all changed files; `tsc --noEmit` clean.

## Working tree

Clean (everything committed).

## Next steps (in order)

1. **Stabilize `keyboard-only.spec.ts`.** It now gets PAST the warp (the
   chat-log fix works — warp via focus+Enter verified) but fails at a
   DIFFERENT step each run (timing/topology flake on the freshly seeded
   per-run world):
   - run 2: step 7 re-enter — `sweepUntil('[E] Enter ship')` matched, E pressed,
     character stayed on foot (weight bar visible 20 s). Hypothesis: the 10 Hz
     raycast target (`resolvedTargetRef`) went null between the prompt read and
     the E keydown in `main.tsx` (the E handler silently returns when target is
     null), or a key-repeat race after the mining hold-E release. Trace was in
     `app/test-results/` at commit time. Consider: retry the E press 2–3× if
     the prompt still reads '[E] Enter ship' (the server enter_ship is
     idempotent: 'already-in-ship' is a safe no-op); or make the client E
     handler re-resolve the target from the current prompt instead of the
     cached ref (check `resolvedTargetRef` staleness).
   - run 3: out-and-back leg — warp target system node not rendered in the
     chart (count 0, no #star-chart-error). Overview = home + 2 nearest
     neighbors, so the node SHOULD exist; suspect the chart fetch raced the
     world swap (it re-fetches on `currentSystemId` change; the loading-hidden
     assert may have passed on a stale render before the refetch cleared it).
     Consider waiting for a node with `data-system-id=home` BEFORE asserting
     the target node, or `#star-chart-map` to contain the target id.
   - The server-side re-enter path is fine: `shard.handleEnterShip` allows
     re-entering a DOCKED ship (no dock check); validation = not-found /
     not-owner / already-in-ship / out-of-range (5 m) / ship-moving (<1 u/s).
2. Run it: `npx playwright test --config playwright.e2e.config.ts
   tests/e2e/keyboard-only.spec.ts tests/e2e/aria-coverage.spec.ts`
   (NO other file edits while it runs — vite HMR mid-test corrupts the page;
   that caused one earlier failure). Spec budget is 240 s; keep < 60 s ideal.
3. Once green: re-run `npm run test` (≈2 min) + `npx tsc --noEmit`; set the 4
   step pass flags true in `.ralph/tasks/TASK-54.json`; set `passes: true` for
   TASK-54 in `.ralph/tasks.json`; LOG.md entry at top (screenshots
   TASK-54-1..7.png exist: 1=after warp, 2=after mine, 3=after sell [will be
   re-shot when green], 4=esc menu+settings, 5=star chart, 6=ship panel,
   7=dock panel); update STRUCTURE.md (new dirs: `app/src/client/a11y/`);
   DELETE this handoff in the completion commit; Conventional Commit.

## Dead ends

- HMR: running `eslint --fix`/`prettier --write` in `app/` while the e2e vite
  harness is up hot-reloads `main.tsx` mid-test and resets the client session
  (warp "arrives nowhere"). Never edit `app/` sources during an e2e run.
- The `?sys=` URL boot param and raw-WS prep (menu.spec.ts pattern) are NOT
  needed here: the spec's own browser-claim flow stores the session in
  localStorage and the dev endpoints use it.

## How to verify

Follow the task spec; the two e2e specs + the unit suite are the proof.
