/**
 * Settings store test — TASK-54 (reduced motion flag).
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS, STORAGE_KEY, SettingsStore } from "./settings.js";

/** A tiny in-memory storage double. */
function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string): string | null => map.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      map.set(key, value);
    },
    map,
  };
}

describe("SettingsStore", () => {
  it("defaults reduced motion to off", () => {
    const store = new SettingsStore({ storage: null });
    expect(store.getSnapshot().reducedMotion).toBe(false);
    expect(DEFAULT_SETTINGS.reducedMotion).toBe(false);
  });

  it("notifies subscribers when the flag flips", () => {
    const store = new SettingsStore({ storage: null });
    let calls = 0;
    const off = store.subscribe(() => {
      calls += 1;
    });
    store.setReducedMotion(true);
    expect(calls).toBe(1);
    expect(store.getSnapshot().reducedMotion).toBe(true);
    off();
    store.setReducedMotion(false);
    expect(calls).toBe(1);
  });

  it("does not notify when the value is unchanged", () => {
    const store = new SettingsStore({ storage: null });
    let calls = 0;
    store.subscribe(() => {
      calls += 1;
    });
    store.setReducedMotion(false);
    expect(calls).toBe(0);
  });

  it("toggles the flag", () => {
    const store = new SettingsStore({ storage: null });
    store.toggleReducedMotion();
    expect(store.getSnapshot().reducedMotion).toBe(true);
    store.toggleReducedMotion();
    expect(store.getSnapshot().reducedMotion).toBe(false);
  });

  it("persists the flag under the shared storage key", () => {
    const storage = fakeStorage();
    const store = new SettingsStore({ storage });
    store.setReducedMotion(true);
    expect(storage.map.get(STORAGE_KEY)).toContain("true");
  });

  it("reads a persisted flag back", () => {
    const storage = fakeStorage({ [STORAGE_KEY]: JSON.stringify({ reducedMotion: true }) });
    const store = new SettingsStore({ storage });
    expect(store.getSnapshot().reducedMotion).toBe(true);
  });

  it("ignores a corrupt persisted payload", () => {
    const storage = fakeStorage({ [STORAGE_KEY]: "{not json" });
    const store = new SettingsStore({ storage });
    expect(store.getSnapshot().reducedMotion).toBe(false);
  });

  it("survives a faulty subscriber", () => {
    const store = new SettingsStore({ storage: null });
    store.subscribe(() => {
      throw new Error("boom");
    });
    expect(() => store.setReducedMotion(true)).not.toThrow();
    expect(store.getSnapshot().reducedMotion).toBe(true);
  });
});
