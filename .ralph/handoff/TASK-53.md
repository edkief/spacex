# Handoff: TASK-53

Written by Ralph: the agent ran out of time without leaving a complete handoff,
so this records what the loop could see.

## Status

Iteration 12 did not finish the task: Iteration exceeded its 45m budget.

## Done

Commits made during the iteration:

```
4b3186c wip(TASK-53): menu stack + focus trap + ESC menu + ONE shared ship/dock panel (re-shelled cargo/dock wrappers, star-chart Esc moved to the stack); main.tsx integration, tests, e2e remain
```

## Working tree

Clean.

## Next steps

Read the agent's last messages below and any uncommitted changes, decide what is worth
keeping, then continue the task.

## Dead ends

Not recorded.

## How to verify

Follow the task spec.

## The agent's last messages

> TASK-53 is the board's top unpassed task, and the human's note on TASK-34 is already handled (already marked as passing). Next, I'll investigate the existing code to understand the integration points.
>
>
> Now let me look at the remaining integration points: shared ship stats/livery, repair cost, the flight loop's input gating, and the existing e2e DOM contracts.
>
>
> Now let me check the star chart (Esc handling, ids), existing UI tests that may be affected, and the e2e helpers/fixtures:
>
>
> I have the full picture now. Let me check a few last things (credits store, flight-loop tests, claim page object) and then start implementing.
>
>
> Now let me check the test idiom and the shard's cargo-open denial path:
>
>
> I have everything I need. Time to implement. Starting with the menu stack store:
>
>
> Now the core shared panel component:
>
>
> I made a duplicate-key error in the tab button style. Fixing:
>
>
> Now the two thin wrappers that keep the existing DOM contracts (`#cargo-panel`, `#dock-panel`):
>
>
> Now update the star chart: remove its own Esc handler (centralized in the menu stack) and raise its z-index above the new backdrop:
>
>
> Three trivial type errors in my new file — quick cleanup so the WIP commit is accurate:
>
>
> Now the handoff, then commit:
>
>
> Handoff complete.
>
> **State of TASK-53:**
> - **Committed** (`4b3186c wip(TASK-53)`): all new work — `state/menu.ts` (surface stack), `ui/focus-trap.ts`, `ui/esc-menu.tsx`, `ui/ship-panel.tsx` (the ONE shared panel with context-driven tabs, livery debounce, repair gating), re-shelled `cargo-panel.tsx` / `dock-panel.tsx` (old DOM ids preserved), and `star-chart.tsx` with its Esc handler moved to the stack.
> - **Not done:** `main.tsx` integration (menu mount, ESC/pop handler, input gating, repair/livery REST calls, self-ship view plumbing), all unit tests, the e2e spec, close-out.
> - **Build:** `tsc` fails with exactly two expected errors at the old `<CargoPanel>`/`<DockPanel>` call sites in `main.tsx` (missing the new props) — documented in the handoff with a step-by-step plan.
> - No background processes were started, so nothing to kill.
>
> `.ralph/handoff/TASK-53.md` has the full next-steps, DOM-contract pins from existing e2e specs (which must stay green), and the design decisions already made (z-index ladder, tab sets, one panel component). `passes` stays `false`.

## The agent's incomplete handoff

> # TASK-53 handoff — Menu shell: ESC menu, pause, and the dock panel assembly
>
> ## Status
> UI components + state store are built (menu stack, focus trap, ESC menu, ONE shared ship/dock panel, re-shelled cargo/dock wrappers, star chart Esc moved to the stack). The `main.tsx` integration (menu open/ESC handler, input gating, panel openers, repair/livery REST calls, self-ship view plumbing) is NOT done — `tsc` fails on the two old call sites. No tests written yet, nothing in the task marked passed.
>
> ## Done
> All files below exist (working tree, uncommitted until this wip commit):
> - `app/src/client/state/menu.ts` — the open-surface stack (new). `Surface` = `{kind:'menu'} | {kind:'chart'} | PanelSurface`; `PanelSurface {id: 'cargo-panel'|'dock-panel'|'ship-panel', title, context: 'docked'|'flight'|'dock', activeTab}`. API: `menuStack()`, `topSurface()`, `anySurfaceOpen()`, `openMenu()` (only from empty stack), `openChart()`, `openPanel(surface)`, `popSurface()` (returns popped), `closeAllSurfaces()`, `menuSubscribe(fn)`, `__resetMenu()`. canonicalJson emit-on-change (cargo.ts idiom).
> - `app/src/client/ui/focus-trap.ts` — `useFocusTrap(ref, active)`: focuses first focusable on activate, Tab/Shift+Tab wrap, restores previous focus on deactivate.
> - `app/src/client/ui/esc-menu.tsx` — `EscMenu {callsign, credits, onResume, onSystems, onShips}`. `#esc-menu` + `#esc-menu-resume/systems/ships/settings` + `#esc-menu-footer` (credits + callsign) + "world keeps moving" note. Settings toggles a TASK-55 stub line. z-index 111.
> - `app/src/client/ui/ship-panel.tsx` — THE ONE shared panel. `tabsForContext()`: docked=[overview,cargo,repair], flight=[overview,cargo], dock=[overview,cargo,sell] (exported — the tab-set test target). `ShipPanel` props: `id/title/context/activeTab/ship:PanelShipView{classId,hull,shields,energy,livery}/docked/hold:PanelHoldView|null/inventory:PanelInvView|null/balance/onMove/onSell?/onRepair?/onLivery?/repairMessage/onClose`. Overview = class stats (SHIP_CLASSES) + hull/shield/energy bars + 3 color pickers debounced `LIVERY_SAVE_DEBOUNCE_MS=500` before `onLivery` (5 changes → 1 call). Repair tab = `repairCost()` preview (shared/physics/damage) + REPAIR button disabled w/ `#<id>-repair-reason` when `!docked`. Sell tab reuses the TASK-40 rows verbatim (`sell 1/all hold/inv` aria-labels preserved). Cargo tab reuses the TASK-39 StackColumn markup (`move 1/all <res>` aria-labels, 'Transfers need you on foot' hint). Tabs switch on click + ArrowLeft/ArrowRight (focus follows). z-index 112.
> - `app/src/client/ui/cargo-panel.tsx` — REWRITTEN as a thin wrapper: subscribes state/cargo, renders `<ShipPanel id="cargo-panel" title="CARGO" context={docked?'docked':'flight'} activeTab="cargo" .../>`. NEW props required by main.tsx: `onRepair, onLivery, repairMessage, onClose, ship, docked, balance` (in addition to `onMove`).
> - `app/src/client/ui/dock-panel.tsx` — REWRITTEN the same way: `id="dock-panel" title="STATION DOCK" context="dock" activeTab="sell"`, bal
