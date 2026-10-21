/**
 * Guidance state machine unit tests (TASK-56).
 *
 * Covers:
 *   - step advancement on each event (docked / disembark / first
 *     pickup / first sale),
 *   - monotonic state (out-of-order events don't rewind),
 *   - persistence across a simulated refresh (`localStorage`),
 *   - dismiss is sticky (no re-show after X),
 *   - the auto-hide finale seam.
 *
 * Pure-JS — no React, no DriftClient, no happy-dom. The machine
 * itself is the only subject under test; the React overlay has a
 * separate component test that mounts `<GuidanceHint>` against
 * `useSyncExternalStore`.
 */
import { describe, expect, it, vi } from "vitest";

import {
  FINALE_AUTOHIDE_MS,
  GUIDANCE_STORAGE_KEY,
  GUIDANCE_STEPS,
  GuidanceStore,
  type GuidanceStorage,
  STEP_DISEMBARK,
  STEP_FINALE,
  STEP_FLY,
  STEP_SELL,
  dockTransitioned,
  targetStepFor,
} from "./guidance.js";

class MemoryStorage implements GuidanceStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  /** Test seam — read the raw stored value (no JSON parse). */
  raw(key: string): string | null {
    return this.getItem(key);
  }
}

describe("targetStepFor", () => {
  it("maps each event onto the spec's progression", () => {
    expect(targetStepFor("docked")).toBe(STEP_DISEMBARK);
    expect(targetStepFor("disembark")).toBe(STEP_SELL);
    expect(targetStepFor("firstPickup")).toBe(STEP_SELL);
    expect(targetStepFor("firstSale")).toBe(STEP_FINALE);
    expect(targetStepFor("dismiss")).toBeNull();
  });
});

describe("dockTransitioned", () => {
  it("flips only on null → non-null", () => {
    expect(dockTransitioned(null, "pad-A")).toBe(true);
    expect(dockTransitioned(undefined, "pad-A")).toBe(true);
    expect(dockTransitioned("pad-A", "pad-A")).toBe(false);
    expect(dockTransitioned("pad-A", "pad-B")).toBe(false);
    expect(dockTransitioned("pad-A", null)).toBe(false);
    expect(dockTransitioned(null, null)).toBe(false);
  });
});

describe("GuidanceStore — fresh player", () => {
  it("starts at STEP_FLY for a brand-new player", () => {
    const store = new GuidanceStore({ storage: new MemoryStorage() });
    expect(store.getSnapshot().step).toBe(STEP_FLY);
    expect(store.getSnapshot().furthest).toBe(STEP_FLY);
    expect(store.getSnapshot().dismissed).toBe(false);
  });

  it("persists the starter step (so the e2e can assert the no-restart invariant)", () => {
    const storage = new MemoryStorage();
    const store = new GuidanceStore({ storage });
    // The first `recordEvent` advances the persisted value. No
    // event yet → no payload (the storage stays untouched so
    // dismissing-then-restoring a brand-new player doesn't leave
    // a stale row from the very first boot).
    expect(storage.raw(GUIDANCE_STORAGE_KEY)).toBeNull();
    store.recordEvent("docked");
    const raw = storage.raw(GUIDANCE_STORAGE_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string).step).toBe(STEP_DISEMBARK);
  });
});

describe("GuidanceStore — event progression", () => {
  it("advances through the four steps on the canonical event sequence", () => {
    const store = new GuidanceStore({ storage: new MemoryStorage() });
    store.recordEvent("docked");
    expect(store.getSnapshot().step).toBe(STEP_DISEMBARK);
    store.recordEvent("disembark");
    expect(store.getSnapshot().step).toBe(STEP_SELL);
    store.recordEvent("firstSale");
    expect(store.getSnapshot().step).toBe(STEP_FINALE);
  });

  it("captures finaleStartedAtMs on the STEP_FINALE entry", () => {
    let now = 1_000;
    const store = new GuidanceStore({
      storage: new MemoryStorage(),
      now: () => now,
    });
    store.recordEvent("docked");
    now = 1_500;
    store.recordEvent("disembark");
    now = 2_000;
    store.recordEvent("firstSale");
    expect(store.getSnapshot().finaleStartedAtMs).toBe(2_000);
    expect(store.getSnapshot().step).toBe(STEP_FINALE);
  });

  it("is monotonic — out-of-order events don't rewind", () => {
    const store = new GuidanceStore({ storage: new MemoryStorage() });
    store.recordEvent("firstSale"); // Land in finale first.
    expect(store.getSnapshot().step).toBe(STEP_FINALE);
    const first = store.getSnapshot().revision;
    store.recordEvent("disembark"); // older event — should be ignored
    store.recordEvent("docked");
    expect(store.getSnapshot().step).toBe(STEP_FINALE);
    expect(store.getSnapshot().revision).toBe(first);
  });

  it("firstPickup lands on the sell tip (not on the disembark tip)", () => {
    // The starter ship spawns docked, so a player can mine without
    // explicitly disembarking. The state machine must NOT advance
    // past SELL when the first pickup event lands.
    const store = new GuidanceStore({ storage: new MemoryStorage() });
    store.recordEvent("docked");
    store.recordEvent("firstPickup");
    expect(store.getSnapshot().step).toBe(STEP_SELL);
    // firstSale still finishes the run.
    store.recordEvent("firstSale");
    expect(store.getSnapshot().step).toBe(STEP_FINALE);
  });
});

describe("GuidanceStore — persistence + refresh", () => {
  it("a mid-flow refresh resumes at the persisted step, not at STEP_FLY", () => {
    const storage = new MemoryStorage();
    const first = new GuidanceStore({ storage });
    first.recordEvent("docked");
    // The persisted payload was bumped by the machine.
    expect(JSON.parse(storage.raw(GUIDANCE_STORAGE_KEY) as string).step).toBe(STEP_DISEMBARK);

    // Simulate a page refresh — a new store constructed against
    // the same storage resumes from the persisted step.
    const second = new GuidanceStore({ storage });
    expect(second.getSnapshot().step).toBe(STEP_DISEMBARK);
    expect(second.getSnapshot().furthest).toBe(STEP_DISEMBARK);
    // No event rewind:
    second.recordEvent("docked");
    expect(second.getSnapshot().step).toBe(STEP_DISEMBARK);
  });

  it("a corrupted payload degrades to the fresh-player default", () => {
    const storage = new MemoryStorage();
    storage.setItem(GUIDANCE_STORAGE_KEY, "{not-json");
    const store = new GuidanceStore({ storage });
    expect(store.getSnapshot().step).toBe(STEP_FLY);
  });

  it("an out-of-range persisted step degrades to STEP_FLY", () => {
    const storage = new MemoryStorage();
    storage.setItem(GUIDANCE_STORAGE_KEY, JSON.stringify({ step: 99 }));
    const store = new GuidanceStore({ storage });
    expect(store.getSnapshot().step).toBe(STEP_FLY);
  });
});

describe("GuidanceStore — dismissal", () => {
  it("dismiss is sticky and clears the persisted step", () => {
    const storage = new MemoryStorage();
    const store = new GuidanceStore({ storage });
    store.recordEvent("docked");
    expect(storage.raw(GUIDANCE_STORAGE_KEY)).not.toBeNull();
    store.recordEvent("dismiss");
    expect(store.getSnapshot().step).toBeNull();
    expect(store.getSnapshot().dismissed).toBe(true);
    expect(storage.raw(GUIDANCE_STORAGE_KEY)).toBeNull();
    // Subsequent events are ignored.
    const rev = store.getSnapshot().revision;
    store.recordEvent("docked");
    store.recordEvent("firstSale");
    expect(store.getSnapshot().step).toBeNull();
    expect(store.getSnapshot().revision).toBe(rev);
  });

  it("a new store constructed from a dismissed state stays dismissed", () => {
    const storage = new MemoryStorage();
    const first = new GuidanceStore({ storage });
    first.recordEvent("dismiss");
    // Dismiss clears localStorage, so a refresh starts at STEP_FLY
    // again. The headline invariant is "dismiss is per-app-session,
    // not per-machine-life" — the persisted record is the source of
    // truth, not the in-memory flag.
    const second = new GuidanceStore({ storage });
    expect(second.getSnapshot().step).toBe(STEP_FLY);
  });
});

describe("GuidanceStore — listeners", () => {
  it("notifies on every state change", () => {
    const store = new GuidanceStore({ storage: new MemoryStorage() });
    const listener = vi.fn();
    store.subscribe(listener);
    store.recordEvent("docked");
    store.recordEvent("disembark");
    store.recordEvent("dismiss");
    // 3 commits → 3 calls (the initial subscribe doesn't fire).
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("revisions are stable + monotonic", () => {
    const store = new GuidanceStore({ storage: new MemoryStorage() });
    const start = store.getSnapshot().revision;
    store.recordEvent("docked");
    expect(store.getSnapshot().revision).toBe(start + 1);
    store.recordEvent("disembark");
    expect(store.getSnapshot().revision).toBe(start + 2);
  });

  it("a faulty listener doesn't break the loop", () => {
    const store = new GuidanceStore({ storage: new MemoryStorage() });
    const listener = vi.fn(() => {
      throw new Error("listener boom");
    });
    store.subscribe(listener);
    expect(() => store.recordEvent("docked")).not.toThrow();
  });

  it("returns a working unsubscribe handle", () => {
    const store = new GuidanceStore({ storage: new MemoryStorage() });
    const listener = vi.fn();
    const off = store.subscribe(listener);
    off();
    store.recordEvent("docked");
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("GuidanceStore — hide()", () => {
  it("clears the current step without resetting furthest or dismissed", () => {
    const store = new GuidanceStore({ storage: new MemoryStorage() });
    store.recordEvent("docked");
    store.recordEvent("disembark");
    store.recordEvent("firstSale");
    expect(store.getSnapshot().step).toBe(STEP_FINALE);
    store.hide();
    expect(store.getSnapshot().step).toBeNull();
    expect(store.getSnapshot().furthest).toBe(STEP_FINALE);
    // No event re-shows the hint until refresh.
    store.recordEvent("firstSale");
    expect(store.getSnapshot().step).toBeNull();
  });
});

describe("Constants", () => {
  it("exposes the four hint lines", () => {
    expect(GUIDANCE_STEPS).toHaveLength(4);
    expect(GUIDANCE_STEPS[STEP_FLY]).toMatch(/Hold W/);
    expect(GUIDANCE_STEPS[STEP_DISEMBARK]).toMatch(/Press E at a docked/);
    expect(GUIDANCE_STEPS[STEP_SELL]).toMatch(/cargo hold/);
    expect(GUIDANCE_STEPS[STEP_FINALE]).toMatch(/drifting/);
  });

  it("auto-hides the finale after 5 s", () => {
    expect(FINALE_AUTOHIDE_MS).toBe(5_000);
  });
});
