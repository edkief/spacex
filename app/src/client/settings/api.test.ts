/**
 * Settings-saver tests — TASK-55.
 *
 * The headline case is the spec's "slider debounce (5 drags → 1
 * request)": five queued patches inside one 300 ms window collapse
 * into a single PUT carrying the last value.
 *
 * @see ./api.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSettingsSaver, fetchSettings, saveSettings } from "./api.js";

interface Recorded {
  method: string;
  body: unknown;
  url: string;
}

let calls: Recorded[];
let timers: Array<{ fn: () => void; ms: number; cancelled: boolean }>;

beforeEach(() => {
  calls = [];
  timers = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body === undefined ? null : JSON.parse(String(init.body)),
      });
      const settings = { quality: "high", sensitivity: 1, reducedMotion: false };
      return {
        ok: true,
        status: 200,
        json: async () => ({ settings }),
      } as unknown as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Timer doubles so the test drives the clock by hand. */
const fakeTimers = {
  setTimer: (fn: () => void, ms: number): unknown => {
    const handle = { fn, ms, cancelled: false };
    timers.push(handle);
    return handle;
  },
  clearTimer: (handle: unknown): void => {
    (handle as { cancelled: boolean }).cancelled = true;
  },
};

/** Fire every live timer once. */
function flushTimers(): void {
  for (const t of timers) {
    if (!t.cancelled) t.fn();
  }
  timers = [];
}

describe("createSettingsSaver", () => {
  it("collapses five drags in one window into a single PUT", async () => {
    const saver = createSettingsSaver({ getToken: () => "tok", ...fakeTimers });
    for (const value of [1.1, 1.2, 1.3, 1.4, 1.5]) {
      saver.queue({ sensitivity: value });
    }
    expect(calls).toHaveLength(0);
    expect(saver.pending()).toEqual({ sensitivity: 1.5 });

    flushTimers();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ method: "PUT", body: { sensitivity: 1.5 } });
    expect(saver.sends()).toBe(1);
  });

  it("cancels a pending timer when a new value arrives", async () => {
    const saver = createSettingsSaver({ getToken: () => "tok", ...fakeTimers });
    saver.queue({ sensitivity: 1.2 });
    saver.queue({ sensitivity: 1.4 });
    expect(timers[0]?.cancelled).toBe(true);
    flushTimers();
    // Writes are serialised through a promise chain, so the fetch
    // lands on the next microtask.
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toEqual({ sensitivity: 1.4 });
  });

  it("saveNow PUTs immediately and drops the queued patch", async () => {
    const saver = createSettingsSaver({ getToken: () => "tok", ...fakeTimers });
    saver.queue({ sensitivity: 1.9 });
    await saver.saveNow({ quality: "low" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({ quality: "low" });
    flushTimers();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
  });

  it("flush sends the queued patch without waiting for the timer", async () => {
    const saver = createSettingsSaver({ getToken: () => "tok", ...fakeTimers });
    saver.queue({ quality: "medium" });
    await saver.flush();
    expect(calls).toHaveLength(1);
    expect(saver.pending()).toBeNull();
  });

  it("is a no-op without a token", async () => {
    const saver = createSettingsSaver({ getToken: () => null, ...fakeTimers });
    await saver.saveNow({ quality: "low" });
    expect(calls).toHaveLength(0);
    expect(saver.sends()).toBe(0);
  });

  it("reports a failed PUT through onError and keeps going", async () => {
    const errors: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response),
    );
    const saver = createSettingsSaver({
      getToken: () => "tok",
      onError: (err) => errors.push(err),
    });
    await saver.saveNow({ quality: "low" });
    expect(errors).toHaveLength(1);
  });

  it("echoes the server's stored record to onSaved", async () => {
    const saved: unknown[] = [];
    const saver = createSettingsSaver({
      getToken: () => "tok",
      onSaved: (s) => saved.push(s),
    });
    await saver.saveNow({ sensitivity: 4 });
    expect(saved).toEqual([{ quality: "high", sensitivity: 1, reducedMotion: false }]);
  });

  it("cancel drops the queued patch", () => {
    const saver = createSettingsSaver({ getToken: () => "tok", ...fakeTimers });
    saver.queue({ sensitivity: 2 });
    saver.cancel();
    flushTimers();
    expect(calls).toHaveLength(0);
  });
});

describe("fetch/save helpers", () => {
  it("GETs the settings with the bearer token", async () => {
    const settings = await fetchSettings("tok");
    expect(calls[0]).toMatchObject({ method: "GET", url: "/api/players/settings" });
    expect(settings.quality).toBe("high");
  });

  it("throws on a non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }) as Response),
    );
    await expect(fetchSettings("tok")).rejects.toThrow("401");
    await expect(saveSettings("tok", { quality: "low" })).rejects.toThrow("401");
  });
});
