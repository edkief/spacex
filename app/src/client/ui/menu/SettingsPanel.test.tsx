/**
 * Settings panel test — TASK-54 + TASK-55.
 *
 * TASK-54 (a11y): focus management, the Tab trap, the reduced-motion
 * checkbox, the `data-menu-surface` declaration.
 *
 * TASK-55 (settings page): the four sections render, the preset
 * switch **re-tunes the streaming pipeline** (the bridge + a real
 * `ChunkPipeline` see the new params), the sensitivity slider
 * applies live and debounces 5 drags into 1 request, and Reset
 * restores the defaults.
 */
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { SettingsPanel } from "./SettingsPanel.js";
import { settingsStore } from "../../a11y/settings.js";
import { connectSettingsBridge, settingsBridge } from "../../world/settingsBridge.js";
import { ChunkPipeline } from "../../world/pipeline.js";
import { QUALITY_PRESETS } from "@shared/settings.js";
import type { Planet } from "@shared/galaxy/types.js";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  settingsStore.reset();
  vi.restoreAllMocks();
});

const PLANET = { id: "p-panel", radiusM: 6_000_000 } as unknown as Planet;

/**
 * Drive the range input the way a real drag does: React tracks the
 * DOM value through its own setter, so the native setter has to be
 * used before dispatching `input` (same trick as the ship panel's
 * livery picker test).
 */
function dragSlider(slider: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(slider, value);
  slider.dispatchEvent(new window.Event("input", { bubbles: true }));
}

describe("SettingsPanel", () => {
  it("renders a dialog with the reduced-motion toggle", () => {
    act(() => {
      root.render(<SettingsPanel />);
    });
    const panel = container.querySelector('[data-testid="drift-settings-panel"]');
    expect(panel).not.toBeNull();
    expect(panel?.getAttribute("role")).toBe("dialog");
    expect(panel?.getAttribute("data-menu-surface")).toBe("settings");
    expect(
      container.querySelector('[data-testid="drift-settings-reduced-motion-input"]'),
    ).not.toBeNull();
  });

  it("focuses the first control when it opens (the quality group)", () => {
    act(() => {
      root.render(<SettingsPanel />);
    });
    expect(document.activeElement?.getAttribute("data-testid")).toBe("drift-settings-quality-high");
  });

  it("flips the shared settings flag from the checkbox", () => {
    act(() => {
      root.render(<SettingsPanel />);
    });
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="drift-settings-reduced-motion-input"]',
    )!;
    act(() => {
      input.click();
    });
    expect(settingsStore.getSnapshot().reducedMotion).toBe(true);
  });

  it("keeps Tab inside the panel", () => {
    act(() => {
      root.render(<SettingsPanel />);
    });
    const panel = container.querySelector('[data-testid="drift-settings-panel"]')!;
    for (let i = 0; i < 6; i++) {
      act(() => {
        panel.dispatchEvent(
          new window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
        );
      });
      expect(panel.contains(document.activeElement)).toBe(true);
    }
  });
});

describe("SettingsPanel — quality preset", () => {
  it("renders all four sections", () => {
    act(() => {
      root.render(<SettingsPanel />);
    });
    expect(container.querySelector('[data-testid="drift-settings-quality-low"]')).not.toBeNull();
    expect(
      container.querySelector('[data-testid="drift-settings-sensitivity-input"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="drift-settings-reduced-motion-input"]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-testid="drift-settings-keybinds"]')).not.toBeNull();
  });

  it("marks the active preset with aria-checked", () => {
    act(() => {
      root.render(<SettingsPanel />);
    });
    const low = container.querySelector('[data-testid="drift-settings-quality-low"]');
    expect(low?.getAttribute("aria-checked")).toBe("false");
    act(() => {
      (low as HTMLButtonElement).click();
    });
    expect(
      container
        .querySelector('[data-testid="drift-settings-quality-low"]')
        ?.getAttribute("aria-checked"),
    ).toBe("true");
    expect(settingsStore.getSnapshot().quality).toBe("low");
  });

  it("re-tunes the streaming pipeline live (no reload, no re-init)", () => {
    const mounted: number[] = [];
    const pipeline = new ChunkPipeline({
      seed: "seed",
      planet: PLANET,
      clock: () => 0,
      callbacks: { onMount: (chunk) => mounted.push(chunk.totalTriangles) },
    });
    pipeline.setPlayerPosition(0, 0, 0);
    pipeline.tick();
    const highTris = mounted[0];

    act(() => {
      root.render(<SettingsPanel />);
    });
    act(() => {
      (
        container.querySelector('[data-testid="drift-settings-quality-low"]') as HTMLButtonElement
      ).click();
    });

    // The bridge (which the pipeline reads per tick) sees the preset.
    expect(settingsBridge.current()).toBe(QUALITY_PRESETS.low);
    // Same pipeline instance: the next generated chunk is coarser.
    pipeline.setPlayerPosition(512, 0, 0);
    act(() => {
      pipeline.tick();
      pipeline.tick();
    });
    expect(mounted[mounted.length - 1]).toBeLessThan(highTris);
    pipeline.dispose();
  });

  it("PUTs the preset immediately (no debounce) and hydrates the store back", async () => {
    const put = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ settings: { quality: "low", sensitivity: 1, reducedMotion: false } }),
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", put);
    const seen: unknown[] = [];
    const off = connectSettingsBridge();
    off();

    act(() => {
      root.render(<SettingsPanel authToken="tok" />);
    });
    await act(async () => {
      (
        container.querySelector('[data-testid="drift-settings-quality-low"]') as HTMLButtonElement
      ).click();
    });
    expect(put).toHaveBeenCalledTimes(1);
    const init = (put as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toEqual({ quality: "low" });
    seen.push(settingsStore.getSnapshot().quality);
    expect(seen).toEqual(["low"]);
  });

  it("restores the defaults from the Reset button", () => {
    act(() => {
      root.render(<SettingsPanel />);
    });
    act(() => {
      (
        container.querySelector('[data-testid="drift-settings-quality-low"]') as HTMLButtonElement
      ).click();
    });
    const slider = container.querySelector<HTMLInputElement>(
      '[data-testid="drift-settings-sensitivity-input"]',
    )!;
    act(() => {
      dragSlider(slider, "0.6");
    });
    expect(settingsStore.getSnapshot().sensitivity).toBe(0.6);

    act(() => {
      (
        container.querySelector('[data-testid="drift-settings-reset"]') as HTMLButtonElement
      ).click();
    });
    expect(settingsStore.getSnapshot()).toEqual({
      quality: "high",
      sensitivity: 1,
      reducedMotion: false,
    });
  });
});

describe("SettingsPanel — sensitivity slider", () => {
  it("applies on the input frame and shows the value", () => {
    act(() => {
      root.render(<SettingsPanel />);
    });
    const slider = container.querySelector<HTMLInputElement>(
      '[data-testid="drift-settings-sensitivity-input"]',
    )!;
    act(() => {
      dragSlider(slider, "1.7");
    });
    expect(settingsStore.getSnapshot().sensitivity).toBe(1.7);
    expect(
      container.querySelector('[data-testid="drift-settings-sensitivity-value"]')?.textContent,
    ).toBe("1.7×");
  });

  it("debounces five drags into a single request", async () => {
    vi.useFakeTimers();
    try {
      const put = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          settings: { quality: "high", sensitivity: 1.5, reducedMotion: false },
        }),
      }));
      vi.stubGlobal("fetch", put);

      act(() => {
        root.render(<SettingsPanel authToken="tok" />);
      });
      const slider = container.querySelector<HTMLInputElement>(
        '[data-testid="drift-settings-sensitivity-input"]',
      )!;
      for (const value of ["1.1", "1.2", "1.3", "1.4", "1.5"]) {
        act(() => {
          dragSlider(slider, value);
        });
        // 5 drags spread over 100 ms each — all inside one 300 ms
        // quiet window, so they must collapse into ONE request.
        vi.advanceTimersByTime(100);
      }
      expect(put).toHaveBeenCalledTimes(0);
      await act(async () => {
        vi.advanceTimersByTime(300);
      });
      expect(put).toHaveBeenCalledTimes(1);
      const init = (put.mock.calls[0] as unknown as [string, RequestInit])[1];
      expect(JSON.parse(String(init.body))).toEqual({ sensitivity: 1.5 });
    } finally {
      vi.useRealTimers();
    }
  });
});
