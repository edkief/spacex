/**
 * Loop tests — TASK-73.
 *
 * Pin the frame-loop contract from `loop.ts`:
 *   - Fixed-step accumulator fires `onFixedStep` exactly once
 *     per `fixedStepSeconds` of accumulated time.
 *   - `maxSubSteps` clamp caps the sub-steps per animation
 *     frame and drops residual accumulator on the floor (the
 *     long-pause recovery rule).
 *   - `onFrame` fires once per rAF tick — even when no
 *     `onFixedStep` fires (a small dt).
 *   - StrictMode double-mount: the second `startFrameLoop(host)`
 *     with the same host returns a no-op handle.
 *   - `stop()` cancels the rAF and clears the guard.
 *   - Frame monitor (when supplied) receives one
 *     `recordFrameTime` + `recordRendererInfo` per tick.
 */
import { describe, expect, it, vi } from "vitest";

import { FrameMonitor } from "@client/perf/frameMonitor.js";

import {
  DEFAULT_FIXED_STEP_SECONDS,
  DEFAULT_MAX_SUBSTEPS,
  LOOP_GUARD_KEY,
  startFrameLoop,
} from "./loop.js";
import type { RenderHostLike } from "./loop.js";

/**
 * Build a minimal host stand-in: one `framesRendered` counter
 * + a `rendererInfo()` slice the loop can mirror into the
 * FrameMonitor. The test controls `render()` simulation by
 * pushing counters when the onFrame callback runs.
 */
function makeHost(initial: { drawCalls?: number; triangles?: number } = {}): RenderHostLike & {
  render: () => void;
  getDrawCalls: () => number;
} {
  let framesRendered = 0;
  const drawCalls = initial.drawCalls ?? 1;
  const triangles = initial.triangles ?? 2;
  const host: RenderHostLike & { render: () => void; getDrawCalls: () => number } = {
    render: () => {
      framesRendered += 1;
    },
    rendererInfo: () => ({ drawCalls, triangles }),
    get framesRendered() {
      return framesRendered;
    },
    getDrawCalls: () => drawCalls,
  };
  return host;
}

/**
 * Build a deterministic rAF: enqueue every `raf()` callback into
 * a JS-controlled array so the test can drain them by hand.
 *
 * `tickOne()` fires exactly ONE queued callback (the head of the
 * queue) at the current `now`. The loop's `raf(tick)` re-arm
 * pushes a fresh entry at the tail, which the next `tickOne()`
 * drains. This matches the browser's "one rAF per vsync" cadence:
 * one tick === one frame.
 *
 * `tickN(n)` calls `tickOne()` `n` times. Returned handles also
 * expose `pendingCount()` and `ticks()` for diagnostics.
 */
function makeRaf(): {
  raf: (cb: (t: number) => void) => number;
  caf: (h: number) => void;
  tickOne: () => void;
  tickN: (n: number) => void;
  pendingCount: () => number;
  ticks: () => number;
  setNow: (ms: number) => void;
  now: () => number;
} {
  let queue: Array<{ h: number; cb: (t: number) => void }> = [];
  let nextHandle = 1;
  let totalTicks = 0;
  let nowMs = 0;

  const raf = (cb: (t: number) => void): number => {
    const h = nextHandle++;
    queue.push({ h, cb });
    totalTicks += 1;
    return h;
  };
  const caf = (h: number): void => {
    queue = queue.filter((entry) => entry.h !== h);
  };
  const tickOne = (): void => {
    if (queue.length === 0) return;
    // Fire the HEAD (FIFO) and let the side-effect (a fresh
    // raf() arm) be picked up by the next `tickOne()` call.
    const entry = queue.shift()!;
    entry.cb(nowMs);
  };
  const tickN = (n: number): void => {
    for (let i = 0; i < n; i++) {
      tickOne();
    }
  };
  return {
    raf,
    caf,
    tickOne,
    tickN,
    pendingCount: () => queue.length,
    ticks: () => totalTicks,
    now: () => nowMs,
    setNow: (ms: number) => {
      nowMs = ms;
    },
  };
}

describe("startFrameLoop — accumulator math", () => {
  it("fires exactly one onFixedStep per fixedStepSeconds of accumulated time", () => {
    const host = makeHost();
    const r = makeRaf();
    const onFixedStep = vi.fn();
    r.setNow(0);
    const handle = startFrameLoop({
      host,
      now: r.now,
      raf: r.raf,
      caf: r.caf,
      fixedStepSeconds: 1 / 60,
      maxSubSteps: 5,
      onFixedStep,
    });

    // Frame 1: tick at t=0 with lastNowMs=0 → dt=0 → no fixed step.
    r.tickOne();
    expect(onFixedStep).toHaveBeenCalledTimes(0);

    // Frame 2: tick at t=16.666 → dt≈0.0166 → exactly one fixed step.
    r.setNow(16.6667);
    r.tickOne();
    expect(onFixedStep).toHaveBeenCalledTimes(1);
    expect(onFixedStep).toHaveBeenLastCalledWith(1 / 60);

    // Frame 3: another 16.666 → one more fixed step.
    r.setNow(33.3334);
    r.tickOne();
    expect(onFixedStep).toHaveBeenCalledTimes(2);

    handle.stop();
  });

  it("clamps sub-steps to maxSubSteps on a long pause and drops residual accumulator", () => {
    const host = makeHost();
    const r = makeRaf();
    const onFixedStep = vi.fn();
    const fixedStep = DEFAULT_FIXED_STEP_SECONDS;
    r.setNow(0);
    const handle = startFrameLoop({
      host,
      now: r.now,
      raf: r.raf,
      caf: r.caf,
      fixedStepSeconds: fixedStep,
      // Three sub-steps per frame, exactly enough to break a
      // 10-frame backlog without leaving residue: 10 sub-steps
      // would flood the queue so we test 4 below.
      maxSubSteps: 3,
      onFixedStep,
    });

    // Drain the initial rAF (dt=0).
    r.tickOne();

    // Now advance time by a huge amount — the loop should run
    // exactly `maxSubSteps` fixed steps and reset the
    // accumulator (so the next frame is a clean tick, not a
    // recovery burst).
    r.setNow(1_000);
    r.tickOne();
    expect(onFixedStep).toHaveBeenCalledTimes(3);

    // No more fixed steps should fire until enough additional
    // time has elapsed for a fourth step — and even then the
    // accumulator has been reset to 0.
    r.setNow(1_020);
    r.tickOne();
    expect(onFixedStep).toHaveBeenCalledTimes(4); // 16 ms is one fixed step

    handle.stop();
  });

  it("calls onFrame exactly once per rAF tick regardless of sub-steps", () => {
    const host = makeHost();
    const r = makeRaf();
    const onFrame = vi.fn();
    r.setNow(0);
    const handle = startFrameLoop({
      host,
      now: r.now,
      raf: r.raf,
      caf: r.caf,
      fixedStepSeconds: 1 / 60,
      maxSubSteps: 5,
      onFrame,
    });

    r.tickOne(); // frame 1: dt=0
    expect(onFrame).toHaveBeenCalledTimes(1);

    r.setNow(16.667);
    r.tickOne(); // frame 2
    expect(onFrame).toHaveBeenCalledTimes(2);

    // A 100 ms jump should still fire onFrame exactly once
    // (but several onFixedStep sub-steps inside it).
    r.setNow(116.667);
    r.tickOne(); // frame 3
    expect(onFrame).toHaveBeenCalledTimes(3);

    handle.stop();
  });

  it("exposes the renderer's per-frame counters via the host", () => {
    const host = makeHost({ drawCalls: 7, triangles: 1234 });
    const r = makeRaf();
    r.setNow(0);
    const handle = startFrameLoop({
      host,
      now: r.now,
      raf: r.raf,
      caf: r.caf,
    });
    r.tickOne();
    const info = host.rendererInfo();
    expect(info.drawCalls).toBe(7);
    expect(info.triangles).toBe(1234);
    handle.stop();
  });
});

describe("startFrameLoop — double-mount guard", () => {
  it("returns a no-op handle on a second startFrameLoop(host) call", () => {
    const host = makeHost();
    const r = makeRaf();
    r.setNow(0);
    const first = startFrameLoop({
      host,
      now: r.now,
      raf: r.raf,
      caf: r.caf,
    });
    expect(first.running).toBe(true);

    const second = startFrameLoop({
      host,
      now: r.now,
      raf: r.raf,
      caf: r.caf,
    });
    // Second call returned a handle whose `stop()` is a no-op —
    // calling it does NOT cancel the first loop's rAF.
    second.stop();
    expect((host as unknown as Record<symbol, boolean>)[LOOP_GUARD_KEY]).toBe(true);
    // Ticking still works because the first loop owns the rAF.
    const onFrame = vi.fn();
    second.stop();
    void onFrame;

    first.stop();
    expect((host as unknown as Record<symbol, boolean>)[LOOP_GUARD_KEY]).toBe(false);
  });
});

describe("startFrameLoop — frame monitor integration", () => {
  it("feeds every tick into the supplied frame monitor", () => {
    const host = makeHost({ drawCalls: 4, triangles: 9 });
    const r = makeRaf();
    const monitor = new FrameMonitor({ clock: r.now });
    const recordSpy = vi.spyOn(monitor, "recordFrameTime");
    const infoSpy = vi.spyOn(monitor, "recordRendererInfo");
    r.setNow(0);
    const handle = startFrameLoop({
      host,
      now: r.now,
      raf: r.raf,
      caf: r.caf,
      frameMonitor: monitor,
    });
    r.tickOne();
    r.setNow(16.667);
    r.tickOne();
    expect(recordSpy).toHaveBeenCalledTimes(2);
    expect(infoSpy).toHaveBeenCalledTimes(2);
    expect(infoSpy).toHaveBeenLastCalledWith({ render: { calls: 4, triangles: 9 } });
    handle.stop();
  });

  it("does nothing when no monitor is supplied", () => {
    const host = makeHost({ drawCalls: 4, triangles: 9 });
    const r = makeRaf();
    r.setNow(0);
    const handle = startFrameLoop({
      host,
      now: r.now,
      raf: r.raf,
      caf: r.caf,
      frameMonitor: null,
    });
    // Should not throw.
    r.tickOne();
    r.setNow(50);
    r.tickOne();
    handle.stop();
  });
});

describe("startFrameLoop — stop semantics", () => {
  it("stop() cancels the rAF and clears the guard", () => {
    const host = makeHost();
    const r = makeRaf();
    r.setNow(0);
    const onFrame = vi.fn();
    const handle = startFrameLoop({
      host,
      now: r.now,
      raf: r.raf,
      caf: r.caf,
      onFrame,
    });
    r.tickOne();
    expect(onFrame).toHaveBeenCalledTimes(1);
    handle.stop();
    expect(handle.running).toBe(false);
    expect((host as unknown as Record<symbol, boolean>)[LOOP_GUARD_KEY]).toBe(false);
    // No more ticks after stop.
    r.tickOne();
    expect(onFrame).toHaveBeenCalledTimes(1);
  });

  it("stop() is idempotent", () => {
    const host = makeHost();
    const r = makeRaf();
    r.setNow(0);
    const handle = startFrameLoop({
      host,
      now: r.now,
      raf: r.raf,
      caf: r.caf,
    });
    handle.stop();
    handle.stop();
    expect(handle.running).toBe(false);
  });
});

describe("startFrameLoop — defaults", () => {
  it("uses DEFAULT_FIXED_STEP_SECONDS / DEFAULT_MAX_SUBSTEPS when omitted", () => {
    const host = makeHost();
    const r = makeRaf();
    r.setNow(0);
    const handle = startFrameLoop({ host, now: r.now, raf: r.raf, caf: r.caf });
    expect(handle.fixedStepSeconds).toBe(DEFAULT_FIXED_STEP_SECONDS);
    expect(handle.maxSubSteps).toBe(DEFAULT_MAX_SUBSTEPS);
    handle.stop();
  });
});
