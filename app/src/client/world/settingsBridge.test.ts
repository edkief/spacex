/**
 * Settings-bridge tests — TASK-55.
 *
 * The bridge is the mechanism behind "apply a preset live": the
 * chunk pipeline reads `current()` on every tick and every chunk
 * generation, so these tests drive a real `ChunkPipeline` and assert
 * the *geometry* changes (no reload, no re-init) rather than just
 * the params object.
 */
import { describe, expect, it } from "vitest";

import { ChunkPipeline } from "./pipeline.js";
import { SettingsBridge } from "./settingsBridge.js";
import { QUALITY_PRESETS, type Settings } from "@shared/settings.js";
import type { Planet } from "@shared/galaxy/types.js";

const PLANET = { id: "p-settings", radiusM: 6_000_000 } as unknown as Planet;

/** A settings record with only the fields the pipeline reads. */
function settings(quality: Settings["quality"], sensitivity = 1): Settings {
  return { quality, sensitivity, reducedMotion: false };
}

describe("SettingsBridge", () => {
  it("starts on the high preset", () => {
    expect(new SettingsBridge().current()).toBe(QUALITY_PRESETS.high);
  });

  it("re-tunes when a preset is applied and notifies once", () => {
    const bridge = new SettingsBridge();
    let calls = 0;
    bridge.subscribe(() => {
      calls += 1;
    });
    bridge.apply(settings("low"));
    expect(bridge.current()).toBe(QUALITY_PRESETS.low);
    expect(bridge.quality()).toBe("low");
    expect(calls).toBe(1);
  });

  it("is a no-op when the same preset is applied twice", () => {
    const bridge = new SettingsBridge();
    let calls = 0;
    bridge.subscribe(() => {
      calls += 1;
    });
    bridge.apply(settings("low"));
    bridge.apply(settings("low"));
    expect(calls).toBe(1);
  });

  it("survives a faulty listener", () => {
    const bridge = new SettingsBridge();
    bridge.subscribe(() => {
      throw new Error("boom");
    });
    expect(() => bridge.apply(settings("medium"))).not.toThrow();
    expect(bridge.current()).toBe(QUALITY_PRESETS.medium);
  });

  it("unsubscribes cleanly", () => {
    const bridge = new SettingsBridge();
    let calls = 0;
    const off = bridge.subscribe(() => {
      calls += 1;
    });
    off();
    bridge.apply(settings("low"));
    expect(calls).toBe(0);
  });
});

describe("pipeline re-tune on preset change", () => {
  it("generates the new detail on the next chunk without a re-init", () => {
    const bridge = new SettingsBridge();
    const mounted: { triangles: number }[] = [];
    const pipeline = new ChunkPipeline({
      seed: "seed",
      planet: PLANET,
      clock: () => 0,
      params: () => bridge.current(),
      callbacks: {
        onMount: (chunk) => mounted.push({ triangles: chunk.totalTriangles }),
      },
    });

    pipeline.setPlayerPosition(0, 0, 0);
    pipeline.tick();
    const highTris = mounted[0]?.triangles ?? 0;
    expect(highTris).toBeGreaterThan(0);

    // Switch preset *after* construction — the pipeline is not
    // rebuilt, no reload, no re-init.
    bridge.apply(settings("low"));

    // Move one chunk away so a *new* chunk key is generated.
    pipeline.setPlayerPosition(512, 0, 0);
    pipeline.tick();
    pipeline.tick();
    const lowTris = mounted[mounted.length - 1]?.triangles ?? 0;
    expect(lowTris).toBeLessThan(highTris);
  });

  it("shrinks the draw distance: far chunks leave the active set", () => {
    const bridge = new SettingsBridge();
    const pipeline = new ChunkPipeline({
      seed: "seed",
      planet: PLANET,
      clock: () => 0,
      params: () => bridge.current(),
    });

    // Stand far enough out that a 4 km draw distance excludes the
    // ring a 8 km one would still keep.
    pipeline.setPlayerPosition(5_000, 5_000, 0);
    pipeline.tick();
    const highActive = pipeline.getStats().activeSetSize;

    bridge.apply(settings("low"));
    pipeline.tick();
    const lowActive = pipeline.getStats().activeSetSize;
    expect(lowActive).toBeLessThanOrEqual(highActive);
  });

  it("keeps the bridge's draw distance equal to the preset's", () => {
    const bridge = new SettingsBridge();
    bridge.apply(settings("medium"));
    expect(bridge.current().drawDistanceM).toBe(QUALITY_PRESETS.medium.drawDistanceM);
    expect(bridge.current().drawDistanceM).toBe(6_000);
  });
});
