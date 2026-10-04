# Handoff — TASK-52 (On-foot HUD: prompt, inventory strip, objective hint)

## Status

Implementation is complete: the on-foot HUD (exposure meter, weight bar,
interaction line with mining radial) is built behind a single HUD mode switch,
new unit tests + the new e2e are green, `tsc --noEmit` is clean. The full unit
suite was green at **158 files / 1453 passed / 1 skipped** BEFORE the final
prettier pass; the one full re-run after prettier showed **2 failed / 1451
passed** (files unidentified — re-run was launched but the session was cut;
the 24-test TASK-52 subset is green post-format, and the 2 failures match the
documented perf-guard / wall-clock flake family — confirm on the next full
run). What remains: one green full-suite run, pass flags, commit. Nothing
functional is left.

## Done

- `app/src/client/ui/on-foot-hud/exposure-meter.tsx` — vertical 50-max exposure
  bar (bottom-right, above the weight bar, keeps `#hazard-hud` id), ☢ radzone /
  ⚡ storm icons, exact bands green > 25 / amber 10–25 / red < 10
  (`exposureColor`), RECOVERING state: bar frozen at the server-held 0 value,
  pulsing red, `RECOVERING Ns` countdown from `recoveringUntil` (250 ms
  cosmetic tick, `recoveringSeconds` pure helper).
- `app/src/client/ui/on-foot-hud/interaction-line.tsx` — the single
  bottom-center prompt line (keeps `#interact-prompt`) with the TASK-38 mining
  radial drawn AROUND it (keeps `#mining-hud`); the only per-frame work is an
  rAF conic-gradient angle write from the server's 10 Hz miningProgress into a
  ref'd div (`MiningRadial`, no React re-render); '+1' float + 'Backpack
  full'/'Depleted' moved in from the old `mining-hud.tsx` (`miningRingGradient`
  / `miningHudStatus` exported from here now).
- `app/src/client/ui/hud-root.tsx` — the mode switch: `HudRoot` renders
  `ShipHudArea` (ShipHud + DockedIndicator + LeaveShipPrompt + `#ship-hud-cargo`
  button) XOR `OnFootHud` (ExposureMeter + WeightBar + InteractionLine), never
  both. Mode = player's active entity kind.
- `app/src/client/main.tsx` — new `hudMode` state (`'ship' | 'onfoot' | null`),
  set at the same self-entity event that drives the camera handoff (on-foot
  branch → `'onfoot'`; ship branch → `'ship'`; system-snapshot handler →
  `null`); the old scattered mounts (HazardHud / WeightBar / InteractPrompt /
  MiningHud / DockedIndicator / LeaveShipPrompt / inline CARGO button /
  `inShip` state) were replaced by one `<HudRoot mode={hudMode}
  promptText={interactPrompt} … onCargoOpen={…}>`.
- `app/src/client/state/hazards.ts` — `HazardState` gained `recoveringUntil`
  (epoch-ms deadline, null when clear); `hazards.test.ts` updated.
- Deleted: `app/src/client/ui/hazard-hud.tsx`(+test), `interact-prompt.tsx`
  (+test), `mining-hud.tsx` — fully replaced by the new files. `WeightBar`
  itself is unchanged (TASK-34, hover counts intact).
- `app/src/server/routes/dev.ts` — `GET /api/dev/hazard-target?kind=radzone`
  (default `'storm'` unchanged, so the TASK-48 e2e is untouched).
- Tests: `on-foot-hud/exposure-meter.test.tsx` (8), `on-foot-hud/
  interaction-line.test.tsx` (7, incl. live rAF angle-write assert in
  happy-dom), `ui/hud-root.test.tsx` (4 — both stores seeded at once proves
  the switch, not the data, decides; atomic both-way switch). Prompt
  exclusivity (two targets → nearest only) is enforced by the existing
  `input/interaction.test.ts` raycast tests.
- E2E: `app/tests/e2e/on-foot-hud.spec.ts` (green 8.9 s): in-ship asserts
  flight HUD up + no on-foot elements → E disembark → on-foot asserts weight
  bar up + no ship elements → radzone teleport → `#hazard-hud` visible with ☢
  + drain to ≤ 40.5. Screenshot `.ralph/screenshots/TASK-52-1.png` verified.
- eslint --fix + prettier --write run on all touched files. `npx tsc --noEmit`
  clean (after prettier).

## Working tree

Everything above is committed as a `wip(TASK-52)` commit (base 3ae70a2,
TASK-51). `.ralph/tasks.json` TASK-52 `passes` is still `false` and the 4
step flags in `.ralph/tasks/TASK-52.json` are still `false` (intentionally
left for the close-out). `.ralph/logs/LOG.md` has the entry (marked
"close-out pending", count left at 74). The tree builds: tsc clean, subset
unit tests green after formatting, e2e green. No background processes were
left running (the e2e fixture boots/tears down its own server; check for a
stray dev server with `ss -ltnp | grep -E '3000|3001'`).

## Next steps

1. `cd app && npm run test` (≈ 2 min) — confirm the full suite is still green
   after the prettier pass (pre-format run: 158 files / 1453 passed / 1
   skipped; post-format subset already green).
2. Optional extra confidence: `npx playwright test --config
   playwright.e2e.config.ts tests/e2e/on-foot-hud.spec.ts tests/e2e/hazards.spec.ts`.
3. Set the 4 step `pass: true` flags in `.ralph/tasks/TASK-52.json` and
   `"passes": true` for TASK-52 in `.ralph/tasks.json` (surgical edit — do NOT
   rewrite these files with python json.dump; it re-escapes unicode and
   re-indents the whole file, which happened once this session).
4. Update `.ralph/logs/LOG.md`: change the TASK-52 entry heading from
   "(implementation complete — close-out pending, see handoff)" to "(complete)"
   and bump `Tasks Completed` 74 → 75.
5. Delete this handoff file.
6. Commit everything as `feat(TASK-52): on-foot HUD — exposure meter, weight bar,
   interaction line, HUD mode switch` and output the promise.

## Dead ends

- `tests/e2e/ship-hud.spec.ts` FAILS with `Expected: 200, Received: 409` on
  `POST /api/dev/teleport` — PRE-EXISTING, not caused by this task: it fails
  identically on the base commit (verified with `git stash`). The 409 is
  `not-in-system` (no active shard for the ship's system) — the spec's random
  home system ≠ the pad system, so the ship never enters the pad system's
  shard. Out of scope for TASK-52; a future fix would make the spec warp the
  ship to the pad system (like `dockAtPad` in hazards.spec.ts) before
  teleporting.
- `tests/e2e/inventory.spec.ts` failed once in a 7-spec batch run and was
  green isolated (8.8 s) — the documented load-sensitive flake family
  (SwiftShader load accumulation), no regression signal.
- happy-dom renders inline React style objects with a space after the colon
  (`height: 0%`, not `height:0%`) — asserts in the new tests use the spaced
  form.
- happy-dom's rAF is NOT advanced by `vi.useFakeTimers()` — the radial
  angle-write test drops fake timers and awaits a real 50 ms; the countdown
  test uses fake timers only (setInterval, no rAF). Same pattern as TASK-51.

## How to verify

- `cd app && npx tsc --noEmit` (clean)
- `cd app && npx vitest run src/client/ui/on-foot-hud src/client/ui/hud-root.test.tsx src/client/state/hazards.test.ts` (24 passed)
- `cd app && npm run test` (full suite; pre-format result 158 files / 1453 passed / 1 skipped)
- `cd app && npx playwright test --config playwright.e2e.config.ts tests/e2e/on-foot-hud.spec.ts` (green 8.9 s)
- Screenshot: `.ralph/screenshots/TASK-52-1.png` — ☢ green vertical meter
  39/50 above the weight bar in the rad zone, no ship-HUD elements.
