# TASK-95 handoff — Full touch loop e2e (SC-1 by touch) + controls docs

## Status

**TASK-95.1 DONE — spec FULLY GREEN in one run** (run 16: 1 passed, 3.0 min):
`assertClean()` + screenshot `.ralph/screenshots/TASK-95-1.png` rewritten at
the sold/dock state + `[TASK-95] loop wall=160.8 s` (thrust 8.0 → 96.0 u/s,
yaw-dot 0.971, land 56.0 s vtol-held-at-dock=true, mined 1/40u, sold 505 cr /
0/40u). tsc green.

## Land-leg fix taken

Probe-then-reseed dead-stick glide (spec side): the 130 m probe measures the
stop on this seed's corridor, the final glide starts shifted by it (run 16:
probe stopped 28 m out → final1 at 102 m stopped 23 m → final2 at 107 m
DOCKED 15.2 m in, VTOL held at touchdown). The product-side enabler (the ONE
allowed change, committed earlier in TASK-95.1): `TouchControls.tsx` — the
in-ship touchdown KEEPS the held VTOL (the regime-flip channel hygiene only
clears when `onFoot`), so the 1.35·g lift + pad machine settle the ship. NO
main.tsx wiring change was needed (the diagnosis proved the scheme flips were
correct, server-authoritative). No server / wire / prediction / golden-fixture
changes; no facePad / steering.

## Flake fixes (this iteration)

- Warp leg: `dispatchEvent('click')` on the chart node (NOT `{force:true}` —
  force dispatches by COORDINATES and the co-open `#esc-menu` captures the hit
  test, so the node's onClick never fired). Deterministic and seed-independent.
- `teleport()` polls the SERVER `__TL__` tap, not the rendered ship (the
  predictor does not snap to a large state jump). With a seeded `vel`, the
  ship leaves the point at 90 u/s and the proximity poll flakely reads only
  the grounded state (run 15) — the vel-seeded path confirms via the
  `flightRegime === 'atmosphere'` flip instead.
- Leg 9 `reEnterShip` targets the SHIP's server position (the `__TL__` tap),
  not the pad centre (run 14: the ship docked 18.6 m off the centre; the
  5 m enter radius was never reached from the centre). CLOSE with the bearing
  walk, then FACE the ship IN PLACE (the prompt is a raycast ≤ 3 m AND the
  ±30° forward cone).

## Remaining

TASK-95.2 (controls docs + full gate + close-out) — records the loop wall
time (160.8 s) in the LOG entry.
