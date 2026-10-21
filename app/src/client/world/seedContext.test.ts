/**
 * Galaxy seed context — TASK-76.
 *
 * The acceptance criterion this pins: the client reads the galaxy
 * seed from the **production** `GET /api/health` route, not through
 * the `import.meta.env.DEV`-guarded debug seam. The last case reads
 * the module source and fails if a build guard ever creeps back in.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ensureGalaxySeed,
  getGalaxySeed,
  getGalaxySeedError,
  isGalaxySeedLoaded,
  resetGalaxySeedCache,
  subscribeGalaxySeed,
} from "./seedContext.js";

/** Fake fetch returning a `HealthPayload`-shaped body. */
function okFetch(seed: string): { impl: typeof fetch; calls: () => number } {
  const spy = vi.fn(async () =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: async () => Promise.resolve({ ok: true, galaxySeed: seed }),
    }),
  );
  return {
    impl: spy as unknown as typeof fetch,
    calls: (): number => spy.mock.calls.length,
  };
}

afterEach(() => {
  resetGalaxySeedCache();
});

describe("seedContext", () => {
  it("fetches /api/health once and caches the seed", async () => {
    const fetchImpl = okFetch("DRIFT-SEED-0001");
    expect(getGalaxySeed()).toBeNull();

    const seed = await ensureGalaxySeed({ fetchImpl: fetchImpl.impl, baseUrl: "" });
    expect(seed).toBe("DRIFT-SEED-0001");
    expect(getGalaxySeed()).toBe("DRIFT-SEED-0001");
    expect(getGalaxySeedError()).toBeNull();
    expect(isGalaxySeedLoaded()).toBe(true);
    expect(fetchImpl.calls()).toBe(1);

    // Second call is served from the cache — no second request.
    expect(await ensureGalaxySeed({ fetchImpl: fetchImpl.impl, baseUrl: "" })).toBe(
      "DRIFT-SEED-0001",
    );
    expect(fetchImpl.calls()).toBe(1);
  });

  it("de-duplicates concurrent fetches", async () => {
    const fetchImpl = okFetch("DRIFT-SEED-0002");
    const [a, b, c] = await Promise.all([
      ensureGalaxySeed({ fetchImpl: fetchImpl.impl, baseUrl: "" }),
      ensureGalaxySeed({ fetchImpl: fetchImpl.impl, baseUrl: "" }),
      ensureGalaxySeed({ fetchImpl: fetchImpl.impl, baseUrl: "" }),
    ]);
    expect([a, b, c]).toEqual(["DRIFT-SEED-0002", "DRIFT-SEED-0002", "DRIFT-SEED-0002"]);
    expect(fetchImpl.calls()).toBe(1);
  });

  it("resolves to null (never rejects) on a failed response and stays retryable", async () => {
    const failing = (async () =>
      Promise.resolve({
        ok: false,
        status: 503,
        json: async () => Promise.resolve({ ok: false }),
      })) as unknown as typeof fetch;
    expect(await ensureGalaxySeed({ fetchImpl: failing, baseUrl: "" })).toBeNull();
    expect(getGalaxySeed()).toBeNull();
    expect(getGalaxySeedError()).toContain("503");

    // A later attempt (next session start) can still succeed.
    const good = okFetch("DRIFT-SEED-0003").impl;
    expect(await ensureGalaxySeed({ fetchImpl: good, baseUrl: "" })).toBe("DRIFT-SEED-0003");
  });

  it("notifies subscribers on resolve and stops after unsubscribe", async () => {
    const seen: Array<string | null> = [];
    const unsubscribe = subscribeGalaxySeed((seed) => seen.push(seed));
    // Immediate call with the current (unresolved) value.
    expect(seen).toEqual([null]);

    await ensureGalaxySeed({ fetchImpl: okFetch("DRIFT-SEED-0004").impl, baseUrl: "" });
    expect(seen).toEqual([null, "DRIFT-SEED-0004"]);

    unsubscribe();
    resetGalaxySeedCache();
    await ensureGalaxySeed({ fetchImpl: okFetch("DRIFT-SEED-0005").impl, baseUrl: "" });
    expect(seen).toEqual([null, "DRIFT-SEED-0004"]);
  });

  it("survives a throwing subscriber", async () => {
    const bad = subscribeGalaxySeed(() => {
      throw new Error("boom");
    });
    const good = vi.fn();
    subscribeGalaxySeed(good);
    await expect(
      ensureGalaxySeed({ fetchImpl: okFetch("DRIFT-SEED-0006").impl, baseUrl: "" }),
    ).resolves.toBe("DRIFT-SEED-0006");
    expect(good).toHaveBeenCalledWith("DRIFT-SEED-0006");
    bad();
  });

  it("ships without an import.meta.env.DEV guard (production-safe path)", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./seedContext.ts", import.meta.url)),
      "utf8",
    );
    // Strip comments so the *doc* reference to the DEV guard does
    // not trip the check — only executable code matters here.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    expect(code).not.toContain("import.meta.env");
    // The public health route is the documented source.
    expect(source).toContain("/api/health");
  });
});
