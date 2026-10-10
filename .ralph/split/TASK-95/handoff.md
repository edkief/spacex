# TASK-95 split record — CLOSED (TASK-95.2 completed, 2026-10-10)

Split into TASK-95.1 (touch-loop e2e) + TASK-95.2 (docs + full gate + close-out).
Both pass. This file is the split record (kept); the per-task handoffs are deleted
in the close-out commit.

## TASK-95.1 — touch-loop e2e (done, commit `6be4789`)

`app/tests/e2e/touch-loop.spec.ts` FULLY GREEN on the mobile profile (hasTouch,
deviceProfile 'mobile'), every action via the touchDebug channel, no
keyboard/mouse. The SC-1 loop (claim → warp → fly → VTOL land → exit → mine →
re-enter → sell) ends with credits risen + cargo empty. Loop wall ≈ **160.8 s**
(console `[TASK-95] loop wall=160.8 s`). Fixes taken: warp leg = force-click of
the chart node (dispatchEvent); land leg = probe-then-reseed dead-stick glide +
in-ship VTOL hold at touchdown; legs 6–10 wired (egress → walk → mine →
re-enter → fly-back → sell). Screenshot `.ralph/screenshots/TASK-95-1.png` at
the sold/dock state.

## TASK-95.2 — docs + full gate + close-out (done, this close-out commit)

- **Docs (wip `6a31180`):** README v1-scope line ('no touch controls' removed,
  'no voice' + ops.md link kept), Features line ('Keyboard + touch play'), new
  '**Touch controls.**' note under `## Controls` (dual sticks, per-regime
  buttons, MENU, Settings Auto/On/Off); `app/docs/architecture.md` 'Touch /
  mobile controls' dev note under Prediction/reconciliation (virtual-key design
  + enablement model). Prettier clean (the flat eslint config has no markdown
  processor — prettier is the linter of record for these .md files).
- **Gate:** `npx tsc --noEmit` GREEN. FULL `npm run test` GREEN — 196 files,
  1854 passed / 1 skipped (one full run had 2 reds in
  multiplayer-foot.ws.test.ts p95 — documented wall-clock flake family, green
  in isolation, second full run fully green). `__fixtures__` UNCHANGED.
- **Full e2e gate:** the one-shot 56-spec batch died at 37/56
  (worker-scoped shared server: 'Timed out waiting 900s for the test suite to
  run') — the batch is too long for one boot; the documented per-file /
  small-batch shape was used for the remainder. 37 passed in the batch; of 4
  reds, 3 were proven load-flakes green in isolation (menu 3/3, multiplayer
  3/3, planet-approach 1/1); the 4th (aria-coverage) was a REAL red, root-caused
  (CDP-synthetic Enter no longer triggers implicit form submission in this
  Chromium build — the form is healthy, `requestSubmit()` proven end-to-end)
  and fixed spec-side: the claim step now clicks `#claim-button` (matching
  `ClaimPage` used by every other spec; the spec's keyboard-only proof is the
  in-game navigation). Isolated re-run GREEN (29.1 s). The 20 never-run specs
  re-ran in small batches: 19/20 GREEN, including the headline touch-loop
  (1 passed, 2.5 min, `[TASK-95] loop wall=134.3 s` console line — TASK-95.1
  commit value 160.8 s — + screenshot rewritten). One red: ship-hud 409 from
  /api/dev/teleport — surviving isolation (2/2) = the RECURRING PRE-EXISTING
  flake documented in the TASK-52 LOG entry (same signature: random home
  system ≠ pad system leaves no active shard; seed-dependent); the bisect
  range 4c7b84e..HEAD holds only the client-side TouchControls change
  (unmounted in ship-hud's desktop context; dev.ts untouched), so no product
  diff to fix. Flake policy applied throughout.
