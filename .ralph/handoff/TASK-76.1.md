# Handoff: TASK-76.1 — Stabilize the atmosphere-sky e2e: deterministic aim, confirmed pre-fix FAIL + 3x post-fix PASS

## Status

The geometry mystery is RESOLVED by measurement, and the verdict is bad for the spec as
written: with the committed deterministic aim the pre-fix run can never read ≤ 5 — the band
reads ~29-43 (this iteration: PNG 28.6 / live 43.2; prior: PNG 33.2, live 32.4/45.5) for
two independent, compounding reasons. Step 3 (3× post-fix PASS) is DONE (4/4 consecutive
passes, 65.8-68.7). The ONLY remaining gate is a DECIDE (aim vs threshold) on the pre-fix
AC — it is decided nothing else can be done without a human: every fix path (A/B/C below)
requires changing something the spec forbids me to change unilaterally (assertion, band,
target). Steps 1 (aim) and 4 (type/unit gates) are effectively done; step 2 (pre-fix FAIL)
is blocked on that decision.

## Done

- (Prior iterations, committed at f8ac38e — all still in place): VTOL-hover closed-loop yaw
  aim (wall-clock deadline, NaN-probe retry, 300 ms server-drain settle, hard |err| < 0.12
  rad assert); client NaN-frame guards + unit tests; TEMP-TASK-76.1 attitude log in the
  spec (lines 412-460 of app/tests/e2e/atmosphere-sky.spec.ts — REMOVE before the final
  commit per step 4); WorldManager.ts restored to committed state (constructor line 422 =
  `new THREE.PerspectiveCamera(70, 1, 0.1, CAMERA_FAR)`).
- (THIS iteration — e2e runs + fresh evidence, no code changes to app/):
  - **Step 3 DONE: 4/4 consecutive post-fix PASSes** (CAMERA_FAR=4000, committed spec
    unmodified), runs 1-3 = the required triple: central top band mean **66.8 / 68.7 /
    65.8** (live, bright 83210-83328, regime=atmosphere, heading error 0.4° each run);
    run 4 (65.8) taken AFTER the pre-fix run to leave the post-fix frame on disk.
  - **Fresh pre-fix data point (current spec form, far=1000, then `git checkout --`
    restored clean):** central top band mean **43.2 live / 28.6 PNG** (bright 46255),
    heading error -1.8°, regime=atmosphere. NOTE: with the current assertion (`> 5`) the
    pre-fix run PASSES (43.2 > 5) — direct proof the committed AC cannot catch the bug.
    Same structure as the prior dark-disk frame (bright ~66 sliver rows 0-0.1, dark
    plateau below) — consistent with the committed HEAD frame (33.2).
  - Verified `.ralph/measure-png.mjs` still works (ran it on both frames).
  - Full run logs: `.ralph/logs/t761/` (prefix-run.log, postfix-run2..4.log) — untracked,
    kept as working-tree evidence.
- (Prior iteration — analysis + measurement only, no e2e runs, no code changes):
  - Measured the on-disk pre-fix screenshot (`.ralph/screenshots/TASK-76-1.png`, 1280×720,
    the run-2 dark-disk frame) with `.ralph/measure-png.mjs` (NEW this iteration — fixed a
    ×10 bug from the previous throwaway, verified: topBand mean **33.2**, bright 32931):
    - Rows 0→0.1 (37.5°→30° above boresight): BRIGHT, ~66, color **#2b4259** — the VISIBLE
      part of the dome (haze ~0.58, see below).
    - Rows 0.15→0.4 (30°→22.5° above boresight and below): DARK DISK, plateau **lum ~11**,
      color **#060a11** — the clipped cap (skybox at opacity 1-haze over black clear).
    - Center-column dark/bright transition at y=72 (frac 0.10) = 30° above the boresight.
  - Measured the committed post-fix screenshot (`git show dade5dd:.ralph/screenshots/TASK-76-1.png`):
    uniform dome haze **#314b65, lum ~75** everywhere in the frame (topBand ~75).
  - Confirmed from code (no runs needed): nothing ever overrides `camera.far` (constructor
    is the live far plane — only CameraRig.ts:115 sets fov, resize() sets aspect);
    `CAMERA_FOV = 75` (vertical, canvas fills the page — so DOM-fraction rows map to
    ±37.5°); the atmosphere control scheme HAS pitch: `pitch: ['r','f']` in
    src/client/input/controls.ts:60 (r = nose down, f = nose up), same turnRate as yaw.
  - **Root cause, two compounding spec-assumption failures (both measured):**
    1. **The cap edge misses the band top for a LEVEL nose.** Attitude at measurement
       (committed TEMP log, run 2): pitch=0, roll=0, dome centre 26.4° BELOW the boresight
       (anchorDepression=26.37°, anchorDist=886.6, shipY≈394, spot y=413). The far=1000
       clip cap is a ~63°-half-angle cone centred 26.4° below the boresight, so in the
       centre column it reaches only ~30-37° above the boresight — the band spans 15°-37.5°,
       so its top third sits over the visible (bright ~66) dome. Band mean = ~1/3 bright +
       ~2/3 dark ≈ 33.
    2. **The clipped region reads ~11, not ~3.** The shared hazeFactor uses WORLD-y altitude
       (flat client terrain, anchors at y=0 — atmosphere-view.ts:68 `altitude = pos.y`), not
       local-above-terrain altitude. This seed's densest planet has the pad at y=229 and the
       spot terrain ≈ 353, so "60 u local" = world y ≈ 413 → boundary 0.587 → **haze ≈ 0.58**
       (the spec's "haze 0.93" assumed world y = 60). The clipped cap renders the skybox at
       opacity 1-0.58 = 0.42 over the black clear → lum ≈ 11-14, never ≤ 5. (Verified:
       visible-dome math mix(#0c131f,#6fa8dc,0.58) over skybox·0.42 = (43,66,90) ≈ measured
       #2b4259 exactly.)
  - **Key consequence (why option A alone is not enough):** aiming the nose DOWN at the dome
    centre would put the ENTIRE band inside the clipped cap (cap radius ~63° > band top
    37.5°), but the band would then read ~11-13 (skybox at 0.42 + stars) — STILL > 5.
    Reaching ≤ 5 at the current spot is impossible at any nose attitude (needs haze ≥ 0.85,
    i.e. world y ≤ ~150, terrain ≤ ~90 there — unverified). The pre-fix AC "≤ 5" and the
    aim style must change together, or the threshold must be revised. See Next steps.
  - Also resolved the old "live 45.5 vs PNG 13.7" mismatch: 13.7 was a mis-mapped earlier
    measurement; the exact band math on the same run's PNG reads 33.2 ≈ live 32.4. There is
    no buffer-timing problem — live readPixels and the PNG agree.

## Working tree

- HEAD = the wip(TASK-76.1) commit recording the 3× post-fix PASS + fresh pre-fix data
  (b50d6e6 + one): aim + NaN guards + TEMP attitude log + measure tool + post-fix
  hazy-blue frame (65.8) on disk.
- THIS iteration's changes (committed in the wip checkpoint):
  - `.ralph/handoff/TASK-76.1.md` — rewritten (this file).
  - `.ralph/screenshots/TASK-76-1.png` — the FRESH POST-FIX frame (run 4, topBand 65.8
    live / 66 PNG, uniform hazy blue, no dark disk). The pre-fix dark-disk frames remain
    in git history (b50d6e6: 33.2).
  - `.ralph/logs/t761/` — untracked raw run logs (5 runs); evidence only, not committed.
- Uncommitted pre-existing dirt — do NOT commit: `ralph.config.json`,
  `.ralph/screenshots/TASK-28.1-1.png`, `TASK-70-1.png`, `TASK-72-1.png`, `TASK-73-1.png`.
- `app/src/client/world/WorldManager.ts` is at committed state (CAMERA_FAR=4000 in the
  constructor, line 422; verified `git diff` empty after this iteration's pre-fix run) —
  re-edit to 1000 for pre-fix runs, then `git checkout --` it.
- The spec (app/tests/e2e/atmosphere-sky.spec.ts) is clean vs HEAD; the TEMP-TASK-76.1 block
  (lines 412-460) IS committed and must be removed in the final commit (step 4).
- tsc/eslint/vitest were clean at dade5dd; nothing in app/ changed this iteration. No
  background processes.

## Next steps

1. **ESCALATE (DECIDE) first — the spec's pre-fix AC (≤ 5) is unreachable for this seed at
   60 u local altitude, at ANY nose attitude. This is now the ONLY blocker** (step 3 is
   done). Measured numbers: pre-fix band 28.6-43.2 (PNG 28.6 & 33.2, live 32.4/43.2/45.5),
   post-fix 65.8-68.7; clipped-region plateau ~11 (not ~3, haze 0.58 not 0.93). With the
   committed assertion (`> 5`) the pre-fix run PASSES (43.2) — direct proof the committed
   AC cannot catch the bug, so the AC itself must change. The spec forbids changing
   TOP_BAND / the target / the assertion, and the prior handoff says escalate rather than
   loosen unilaterally. The options, with my analysis:
   - **(A) Pitch-down aim at the dome centre + small threshold revision (my recommendation).**
     Aim the nose at (anchor.x, 0, anchor.z) — yaw loop as-is PLUS a pitch loop on 'r'/'f'
     (controls.ts:60, same turnRate 0.8, same hover/drain/retry pattern; assert both
     |yaw err| < 0.12 AND |pitch err| < 0.12 — extend aimProbe to return the pitch error via
     nose.y = 2(qx·qz... ) — see the TEMP attitude block for the quat→nose math). Pre-fix
     the whole band sits in the clipped cap → band ≈ 11-13; post-fix unchanged (65.8-68.7
     measured). Pre-fix AC becomes "≤ 20" (clean margin both sides: 13 vs 66). This is also
     arguably the more faithful reading of "aim the nose at the anchor" (the anchor
     direction is 26° down, not level).
   - **(B) Keep the yaw-only level aim, revise the threshold to pre-fix ≤ 40 / post-fix > 60**
     (measured 28.6-43.2 vs 65.8-68.7). Cheapest, keeps all committed aim work, but a
     weaker separator and the screenshot still shows the bright sliver.
   - **(C) Scan for a low-terrain spot (world y ≤ ~150, terrain ≤ ~90) inside the dome /
     atmosphere regime and keep ≤ 5.** Most faithful to the original AC but changes the
     spot derivation (spec: "do NOT change the target") and may not exist — highest risk.
   Phrasing for the DECIDE tag: "TASK-76.1: pre-fix ≤5 unreachable at this seed (band
   28.6-43.2 pre / 65.8-68.7 post; clipped cap reads ~11 not ~3 — haze 0.58 at world-y 413,
   and the dome centre is 26° below a level boresight): (A) pitch-down aim at dome centre
   + pre-fix AC ≤20 vs (B) keep level yaw aim + AC ≤40 vs (C) low-terrain spot scan to
   keep ≤5?"
2. **Once decided, run step 2 for real:** WorldManager.ts line 422 → 1000, run the spec,
   record the central-band value (it must FAIL the revised/original threshold). Expect ~11-13
   under (A) or ~29-43 under (B). Restore WorldManager.ts exactly (`git checkout --` + empty
   `git diff`).
3. **Step 3 — DONE this iteration: 4/4 consecutive post-fix PASSes** with CAMERA_FAR=4000,
   committed spec unmodified: central top band mean 66.8 / 68.7 / 65.8 (the required
   triple) + run 4 (65.8) to leave the post-fix frame on disk; heading error 0.4° each
   run; regime=atmosphere. `.ralph/screenshots/TASK-76-1.png` on disk is the uniform
   hazy-blue frame (topBand 66 PNG, no dark disk). If a decision changes the aim (option
   A), re-run this triple with the new aim.
4. **Step 4 close-out:** remove the TEMP-TASK-76.1 block (spec lines 412-460), `npx tsc
   --noEmit` (cd app), `npx vitest run src/client/world/world-manager.test.ts` (10/10),
   `git status --short` (only the spec + screenshot + handoff + measure tool in the commit;
   never ralph.config.json or the four old screenshots), commit per the spec's step-4
   message format with the recorded numbers, delete `.ralph/handoff/TASK-76.1.md` +
   `.ralph/measure-png.mjs` in that commit, LOG.md entry, `passes: true` bookkeeping.

## Dead ends

- Expecting the pre-fix run to FAIL at ≤ 5 with the level yaw aim: it passes (45.5, 32.4
  live; 33.2 PNG). The band's top third (30°-37.5° above boresight) is over the VISIBLE
  dome — the dome centre is 26.4° below a level nose, so the clip cap (cone ~63° around a
  direction 26.4° down) does not cover the band top. Measured from the on-disk PNG, not
  guessed.
- Pitch-aim alone does NOT reach ≤ 5: even with the whole band inside the clipped cap the
  region reads ~11-13 (skybox at opacity 1-0.58 = 0.42 over black), because haze at the
  spot is 0.58 (world y ≈ 413), not the spec's assumed 0.93 (world y = 60). "60 u local
  altitude" ≠ "60 u world altitude" on this seed (pad y=229, spot terrain ≈ 353).
- The previous "live ≠ PNG" buffer-timing hypothesis: WRONG — the exact band math on the
  run-2 PNG reads 33.2 vs live 32.4. Do not chase SwiftShader presentation timing.
- `planetAnchor()` has no `.y` — the dome centre is (anchor.x, **0**, anchor.z); an earlier
  TEMP-log version crashed on `anchor.y.toFixed`.
- pngjs is not installed; the measurement tool works around it with a chromium `file://`-
  style data-URI page + 2d canvas (`.ralph/measure-png.mjs`).
- `camera.far` is never touched after the constructor (checked: only CameraRig.ts:115 sets
  fov; resize() sets aspect) — the constructor arg IS the live far plane, so far-variant
  experiments are not needed to resolve which camera renders.

## How to verify

- Run: `cd app && npx playwright test --config playwright.e2e.config.ts atmosphere-sky`
  (fresh vite+server per run, ~30-60 s; 150 s test timeout; workers 1, retries 0).
- Watch for: `[TASK-76] aimed at the anchor: heading error <X>°` (must be < 6.9°),
  `[TASK-76] TEMP attitude: {...}` (pitch/roll 0 in the committed level-aim form), and
  `central top band mean=<M> bright=<B>, full top band mean=<F>`.
- Measure any screenshot: `cd app && node ../.ralph/measure-png.mjs <png>` → topBand mean,
  per-row profile, centre-column transitions. Reference colors: visible dome haze #2b4259
  (lum ~66, pre-fix), post-fix uniform #314b65 (lum ~75), clipped cap #060a11 (lum ~11),
  skybox-only ~#03060b (lum ~7) only if haze were ≥ 0.9.
- Type/lint: `cd app && npx tsc --noEmit`; unit: `npx vitest run src/client/world/world-manager.test.ts`.
- `git status --short` before committing: spec (TEMP removed in the final commit),
  `.ralph/screenshots/TASK-76-1.png`, handoff, (measure tool until final), LOG.md,
  tasks.json — never the pre-existing dirty files.
