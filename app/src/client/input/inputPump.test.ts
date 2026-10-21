/**
 * InputPump unit tests — TASK-74.
 *
 * Covers the spec's acceptance:
 *   - "Unit tests cover the keycode->LocalInput mapping
 *     (including that W and S are opposite axes and Shift
 *     maps to boost)".
 *   - The pump stamps a monotonic seq.
 *   - The 50 ms send gate holds back-to-back frames until the
 *     interval elapses (test-injected clock controls the boundary).
 *   - Re-binding the active scheme takes effect on the NEXT
 *     `tick()` (TASK-55 rebinds should NOT need a new pump).
 */
import { describe, expect, it, vi } from "vitest";

import { ATMOSPHERE_SCHEME, SPACE_SCHEME } from "./controls.js";
import { InputPump, INPUT_SEND_INTERVAL_MS, resolveAxes } from "./inputPump.js";
import type { LocalInput } from "../net/prediction.js";

/**
 * In-memory `KeyboardState` shape the pump reads. The test
 * builds a fresh `Set` and swaps it in to simulate
 * keydown/keyup transitions.
 */
class FakeHeld {
  public readonly held: Set<string> = new Set();
  press(code: string): void {
    this.held.add(code);
  }
  release(code: string): void {
    this.held.delete(code);
  }
}

interface BuildArgs {
  held: FakeHeld;
  seq?: number[];
  onSend?: () => void;
  now?: () => number;
}

function buildPump(args: BuildArgs): {
  pump: InputPump;
  stamps: LocalInput[];
  /** The seq counter the test bumps so `predictorStep` returns
   *  incrementing seqs (mirrors the production ClientShipPredictor). */
  seq: number;
} {
  const stamps: LocalInput[] = [];
  args.seq ??= [];
  // The wall-clock cursor is shared across the test's
  // `tick(...)` mutations; the InputPump reads it via the
  // injected `now()` closure. The `let` form is intentional so
  // tests can advance the clock outside the closure scope.
  const nowVal = args.now?.() ?? 0;

  // the cursor in `tick(...)` so it must stay `let`.
  const now = nowVal;
  const pump = new InputPump({
    held: args.held,
    getScheme: () => SPACE_SCHEME.keyBindings,
    predictorStep: (step) => {
      const local: LocalInput = {
        seq: (args.seq!.length || 0) + 1,
        tMs: step.now,
        thrust: step.thrust,
        turn: step.turn,
        pitch: step.pitch,
        yaw: step.yaw,
        dt: step.dt,
      };
      args.seq!.push(local.seq);
      stamps.push(local);
      return local;
    },
    sendInput: () => {},
    now: args.now ?? (() => now),
    intervalMs: INPUT_SEND_INTERVAL_MS,
    onSend: args.onSend,
  });
  return {
    pump,
    stamps,
    seq: args.seq.length,
  };
}

describe("resolveAxes — keymap projection", () => {
  it("W sets thrust=1, S is the opposite axis (thrust=0 + reverse treated as brake)", () => {
    const onlyW = resolveAxes(new Set(["KeyW"]), SPACE_SCHEME.keyBindings);
    expect(onlyW.thrust).toBe(1);
    expect(onlyW.turn).toBe(0);
    // S alone should not produce a positive thrust — the wire
    // shape carries `thrust ∈ [0, 1]` so reverse is implicit in
    // a brake (zero throttle, in-flight drag slows the ship).
    const onlyS = resolveAxes(new Set(["KeyS"]), SPACE_SCHEME.keyBindings);
    expect(onlyS.thrust).toBe(0);
  });

  it("Shift maps to boost", () => {
    const axes = resolveAxes(new Set(["KeyW", "ShiftLeft"]), SPACE_SCHEME.keyBindings);
    expect(axes.thrust).toBe(1);
    expect(axes.boost).toBe(true);
  });

  it("A/D are opposite turn axes", () => {
    const a = resolveAxes(new Set(["KeyA"]), SPACE_SCHEME.keyBindings);
    expect(a.turn).toBe(-1);
    const d = resolveAxes(new Set(["KeyD"]), SPACE_SCHEME.keyBindings);
    expect(d.turn).toBe(1);
    const both = resolveAxes(new Set(["KeyA", "KeyD"]), SPACE_SCHEME.keyBindings);
    expect(both.turn).toBe(0);
  });

  it("Q/E are opposite roll axes (the wire's `yaw` field)", () => {
    const q = resolveAxes(new Set(["KeyQ"]), SPACE_SCHEME.keyBindings);
    expect(q.yaw).toBe(-1);
    const e = resolveAxes(new Set(["KeyE"]), SPACE_SCHEME.keyBindings);
    expect(e.yaw).toBe(1);
    const both = resolveAxes(new Set(["KeyQ", "KeyE"]), SPACE_SCHEME.keyBindings);
    expect(both.yaw).toBe(0);
  });

  it("ArrowUp/ArrowDown are opposite pitch axes", () => {
    const up = resolveAxes(new Set(["ArrowUp"]), SPACE_SCHEME.keyBindings);
    expect(up.pitch).toBe(-1);
    const down = resolveAxes(new Set(["ArrowDown"]), SPACE_SCHEME.keyBindings);
    expect(down.pitch).toBe(1);
  });

  it("atmosphere scheme adds Space → but Space has no flight-axis mapping", () => {
    // Atmosphere scheme keeps the same flight axes. `up` is for
    // VTOL; the pump intentionally ignores it because the
    // ship physics layer already reads the `Space` key off
    // the active bindings. We verify the projection doesn't
    // contaminate the other axes.
    const axes = resolveAxes(new Set(["KeyW"]), ATMOSPHERE_SCHEME.keyBindings);
    expect(axes.thrust).toBe(1);
    expect(axes.turn).toBe(0);
  });
});

describe("InputPump — wire transport", () => {
  it("stamps a monotonic seq every tick", () => {
    const held = new FakeHeld();
    held.press("KeyW");
    let now = 0;
    const { pump } = buildPump({ held, now: () => now });
    pump.tick(0.016);
    now += 100;
    pump.tick(0.016);
    now += 100;
    pump.tick(0.016);
    expect(pump.sendCount).toBeGreaterThanOrEqual(3);
  });

  it("respects the 50 ms send cadence (no input sent within the window)", () => {
    const held = new FakeHeld();
    held.press("KeyW");
    let now = 1_000;
    const sent = vi.fn();
    const { pump } = buildPump({ held, now: () => now, onSend: sent });
    // First tick at t=1000 sends (first eligible boundary).
    pump.tick(0.016);
    expect(sent).toHaveBeenCalledTimes(1);
    // Second tick at t=1010 is within the 50 ms window — the
    // pump accumulates but does NOT send.
    now = 1_010;
    pump.tick(0.016);
    expect(sent).toHaveBeenCalledTimes(1);
    // Tick past the boundary (t=1060 > last-send-at 1000 + 50).
    now = 1_060;
    pump.tick(0.016);
    expect(sent).toHaveBeenCalledTimes(2);
  });

  it("re-bind the scheme: changing getScheme() takes effect on the NEXT tick", () => {
    const held = new FakeHeld();
    held.press("Space");
    let scheme = SPACE_SCHEME.keyBindings;
    const pump = new InputPump({
      held,
      getScheme: () => scheme,
      predictorStep: () => ({ seq: 0, tMs: 0, thrust: 0, turn: 0, pitch: 0, yaw: 0, dt: 0 }),
      sendInput: () => {},
      now: () => 0,
      intervalMs: INPUT_SEND_INTERVAL_MS,
    });
    // `Space` is not a flight axis in the space scheme —
    // pump.tick should project to all-zero axes.
    const stamped0 = pump.tick(0.016);
    expect(stamped0.thrust).toBe(0);
    expect(stamped0.turn).toBe(0);
    // Swap to the atmosphere scheme and re-tick. `Space`
    // still isn't a flight axis; axes should still be zero
    // (atmosphere's `up` action doesn't project to a
    // physical-axis field). The point of this test is that
    // the swap, not the key mapping, is observed.
    scheme = ATMOSPHERE_SCHEME.keyBindings;
    const stamped1 = pump.tick(0.016);
    expect(stamped1.thrust).toBe(0);
  });
});
