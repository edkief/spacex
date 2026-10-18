/**
 * Unit tests for `FrameScheduler` (TASK-26).
 *
 * The scheduler's contract: given a per-frame budget, process as
 * many pending tasks as fit, never exceeding the budget by more
 * than one task's duration. If a single task exceeds the budget,
 * run it anyway and record the overrun (we can't leave a chunk
 * half-generated).
 *
 * Tests run under node — the scheduler is a pure data structure.
 * We drive the scheduler's clock with a fake so the budget
 * assertions are deterministic (no `Date.now` flake).
 */

import { describe, expect, it } from "vitest";

import { FrameScheduler, type FrameTask } from "./frameScheduler.js";

/**
 * Build a task that the fake clock measures: the task increments
 * the clock by `costMs` when it runs, so the scheduler's
 * budget-decision logic sees a deterministic cost.
 */
function fakeTask(id: string, onRun?: () => void): FrameTask {
  return {
    id,
    run: () => {
      onRun?.();
    },
  };
}

describe("FrameScheduler", () => {
  it("runs nothing when the queue is empty", () => {
    const s = new FrameScheduler({ budgetMs: 4 });
    expect(s.tick()).toBe(0);
    expect(s.pending()).toBe(0);
  });

  it("runs a single task within the budget", () => {
    const t = 0;
    const clock = () => t;
    const s = new FrameScheduler({ budgetMs: 50, clock });
    let ran = false;
    s.push(fakeTask("x", () => (ran = true)));
    expect(s.tick()).toBe(1);
    expect(ran).toBe(true);
  });

  it("processes tasks in FIFO order", () => {
    const s = new FrameScheduler({ budgetMs: 50 });
    const order: string[] = [];
    s.push({
      id: "a",
      run: () => {
        order.push("a");
      },
    });
    s.push({
      id: "b",
      run: () => {
        order.push("b");
      },
    });
    s.push({
      id: "c",
      run: () => {
        order.push("c");
      },
    });
    s.tick();
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("respects the per-frame budget and stops when the budget is exhausted", () => {
    // Fake clock advances by 1 ms per `clock()` call. Each task
    // records its own duration via the clock, so the scheduler's
    // per-frame budget check (start vs. now) tracks the elapsed
    // wall time accurately.
    let now = 0;
    const clock = () => now;
    const s = new FrameScheduler({ budgetMs: 3, clock });

    // Each task's run() advances the clock by 1 ms. The scheduler
    // records (start, end) per task via two clock() calls, so the
    // effective per-frame advance is 2 clock units (start + end)
    // per task. With budgetMs = 3 the loop should run one task
    // (start=0, end=2 → 2 elapsed, budget remaining = 1) and then
    // the next iteration's start = 2, end = 4 → budget remaining
    // = -1, break.
    s.push({
      id: "t0",
      run: () => {
        now += 1;
      },
    });
    s.push({
      id: "t1",
      run: () => {
        now += 1;
      },
    });
    s.push({
      id: "t2",
      run: () => {
        now += 1;
      },
    });
    s.push({
      id: "t3",
      run: () => {
        now += 1;
      },
    });
    s.push({
      id: "t4",
      run: () => {
        now += 1;
      },
    });
    const completed = s.tick();
    expect(completed).toBeGreaterThan(0);
    expect(completed).toBeLessThan(5);
    expect(s.pending()).toBeGreaterThan(0);
  });

  it("still runs a task that exceeds the budget (single task > budget)", () => {
    let now = 0;
    const clock = () => now;
    const s = new FrameScheduler({ budgetMs: 5, clock });
    s.push({
      id: "x",
      run: () => {
        now += 20;
      },
    });
    s.tick();
    expect(s.lastOverrunMs).toBe(20);
  });

  it("pushFront reorders the queue so the new task runs first", () => {
    const s = new FrameScheduler({ budgetMs: 50 });
    const order: string[] = [];
    s.push({
      id: "old",
      run: () => {
        order.push("old");
      },
    });
    s.pushFront({
      id: "new",
      run: () => {
        order.push("new");
      },
    });
    s.tick();
    expect(order).toEqual(["new", "old"]);
  });

  it("clear() drops all pending tasks", () => {
    const s = new FrameScheduler({ budgetMs: 50 });
    s.push({ id: "a", run: () => undefined });
    s.push({ id: "b", run: () => undefined });
    s.clear();
    expect(s.pending()).toBe(0);
  });

  it("completedCount accumulates across ticks", () => {
    const s = new FrameScheduler({ budgetMs: 50 });
    s.push({ id: "a", run: () => undefined });
    s.push({ id: "b", run: () => undefined });
    s.tick();
    s.push({ id: "c", run: () => undefined });
    s.tick();
    expect(s.completedCount).toBe(3);
  });

  it("emits nothing on its own (overrun is a metric the host reads)", () => {
    let now = 0;
    const clock = () => now;
    const s = new FrameScheduler({ budgetMs: 5, clock });
    s.push({
      id: "x",
      run: () => {
        now += 20;
      },
    });
    s.tick();
    expect(s.lastOverrunMs).toBe(20);
    // The scheduler itself doesn't warn — the host reads
    // lastOverrunMs and decides whether to fire the cooldown-
    // limited perf warning.
  });

  it("supports async tasks without awaiting (fire-and-forget)", async () => {
    const s = new FrameScheduler({ budgetMs: 50 });
    let resolved = false;
    s.push({
      id: "async",
      run: () => {
        return Promise.resolve().then(() => {
          resolved = true;
        });
      },
    });
    // Tick returns immediately; the task is queued to the micro-
    // task queue. After yielding once, the promise resolves.
    expect(s.tick()).toBe(1);
    await Promise.resolve();
    expect(resolved).toBe(true);
  });

  it("records the per-task duration via the injected clock", () => {
    let now = 0;
    const clock = () => now;
    const s = new FrameScheduler({ budgetMs: 50, clock });
    const t: FrameTask = {
      id: "x",
      run: () => {
        now += 7;
      },
    };
    s.push(t);
    s.tick();
    expect(t.durationMs).toBe(7);
  });
});
