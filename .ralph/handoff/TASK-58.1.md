# TASK-58.1 handoff (iteration 25, stopped at ~07:19)

## Status
Steps 1–2 DONE. Step 3 (all gates green + exit 0) is BLOCKED on exactly ONE gate:
**materials 71 ≥ 40** — a property of the committed FX/scene design, not a driver bug,
and fixing it is out of this task's scope ("no new tuning passes"). This is the DECIDE
the previous handoff predicted, now isolated to a single gate.

## What changed this iteration (driver-only, in scope)
`app/src/client/test/renderBenchmark.ts`: added a driver-local `Ac1Streamer extends
ChunkStreamer` whose `mountable()` filters the base result back to the 13-chunk
AT-REST ACTIVE window (`activeSet` at speed 0 = 3×3 near + four cardinal mid/far).
The live pipeline also mounts the far-ring horizon impostors around that window; the
AC-1 scene spec is the 13-chunk steady state, so the driver now drops the horizon
entries. No scene/pipeline/combat-fx/chunk/tally change.

Result of the full re-run (recorded to `.ralph/bench/TASK-58.json`, `pass: false`):
- **draws 133 → 94 p95 / 96 max** (now < 120 ✓) — this was the fix.
- **materials 71** (≥ 40 ✗) — the only red gate, unchanged by the driver fix.
- triangles 87912 < 500 k ✓, spikes 0 ✓, **p95 spread 0.1995 < 0.20 ✓** (the script
  prints "20.0 %" by rounding, but 0.1995 passes; do not "fix" it — it is green).
- baseline draws also dropped 157 → 120 p95 (same horizon removal).

## Why materials is 71 and why it is NOT fixable in this task
Frustum-tallied distinct materials at steady state (verified with a temporary
per-class diagnostic, since removed):
- ~50 per-piece FX materials: 16 tracer bodies + 16 laser lines + 8 flash + ~10 debris
  (the committed FX material *pool* recycles instances but each live piece holds its
  own — per-entity material clones, which AC-3 says to avoid via a shared pool ≤ 24);
- 8 per-hazard-disc materials (`buildHazardDiscs`, one instance per cell);
- ~13 structural: merged ships 1 (16 draws / 1 mat), instanced ore 4 (per resource),
  biome 3, far 1, sky 1, stars 1.

Reaching < 40 requires SHARING materials across per-piece FX and hazard discs —
i.e. a new tuning/render pass in `combat-fx.ts` / `hazard-discs.ts`, which TASK-58.1
explicitly forbids ("no new tuning passes: no merged chunk meshes, no new rendering
features — bug fixes in the driver/tally/monitor/script only"). Do NOT "fix" the tally
to count pooled instances — that changes what the number measures.

## DECIDE (the one remaining blocker — needs a human)
The AC-3 materials budget (< 40) is unreachable by the committed design (71 measured):
- **(A)** Revise the materials budget in `app/src/shared/perf.ts`
  (`PERF_PROFILES.*.budgets.materials`, 40 → ~80) — a data-only change; touches the
  "no new tuning" line, so it is a human call. TASK-58.2 step 3 also owns rewriting
  the perf.ts comments with real numbers.
- **(B)** Add a material-sharing tuning pass (share one material per FX type / per
  hazard disc) in `combat-fx.ts` / `hazard-discs.ts` — out of scope for 58.1; it would
  be TASK-58.2's "at most one further tuning pass" (spec'd as the chunk-mesh merge) or
  a new task.

Draws/triangles/spikes/spread are all green now, so whichever is chosen, the remaining
work is small: (A) is edit two numbers + re-run bench (~7 min) + exit 0; (B) is a real
code pass.

## Working tree / next steps
- Committed this iteration: the Ac1Streamer driver fix + updated
  `.ralph/bench/TASK-58.json` (pass: false, draws green, materials red) + this handoff
  + step flags (1,2 = true; 3 = false).
- To close after the human picks (A) or (B): make the change, `npm run bench:render`
  until exit 0 (~7 min), `npx vitest run src/client/test/render-benchmark.test.ts`
  green (~11 s), final `npm run test` (~2 min), set step 3 + task `passes: true`,
  LOG.md entry, delete this handoff, commit, output the promise.
- No background processes left (bench finished; no dev server).

## Dead ends (carried + new)
- Pacing + frustum culling CANNOT get materials < 40 (committed FX pool = one material
  instance per live piece). Don't "fix" the tally to share pooled instances.
- Do NOT chase the p95 DELTA (legacy baseline faster in CPU-ms on the headless proxy) —
  that is TASK-58.2, not a failure gate here.
- The "20.0 %" spread print is rounding; 0.1995 < 0.20 PASSES. Don't touch it.
- `document?.` in Node code throws ReferenceError — keep `typeof` guards in bench code.
- combat-hud hud-budget test flakes when the machine is hot (right after the 7-min
  bench); verify in isolation before touching it.
