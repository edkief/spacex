/**
 * ExposureMeter component test — TASK-52.
 *
 * Verifies the initial render output of the vertical meter:
 *
 *   - Hidden via the `initialEmpty` test seam.
 *   - Vertical bar shape (height-driven fill).
 *   - Colour thresholds (green / amber / red) plus the
 *     `data-low` flag.
 *   - Hazard icon fan-out (radiation / storm / drones / neutral).
 *   - Recovering state badge + countdown + frozen-bar `data-recovering`.
 *
 * The countdown tick math is covered by `onFoot.test.ts`
 * (`recoveringState`); the React re-render path is throttled by a
 * `setInterval` heartbeat that only matters at runtime so we don't
 * drag a renderer / `act()` into this test.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { HazardStore } from "../world/hazards.js";
import { ExposureMeter } from "./ExposureMeter.js";

describe("ExposureMeter (TASK-52)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-20T00:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders nothing in the `initialEmpty` test path", () => {
    const store = new HazardStore();
    const html = renderToStaticMarkup(<ExposureMeter store={store} initialEmpty />);
    expect(html).toBe("");
  });

  it("uses the vertical bar shape (height-driven fill)", () => {
    const store = new HazardStore();
    store.applyHazardUpdate({ exposure: 50, recoveringUntilMs: 0, inHazard: false });
    const html = renderToStaticMarkup(<ExposureMeter store={store} />);
    expect(html).toContain("EXPOSURE");
    expect(html).toContain('data-testid="drift-exposure-track"');
    // 100% fill at full exposure.
    expect(html).toContain("height:100%");
    // Width comes from CSS, but ensure the fill has `width:100%`.
    expect(html).toContain("width:100%");
  });

  it("uses the green colour above 25 and clears `data-low`", () => {
    const store = new HazardStore();
    store.applyHazardUpdate({ exposure: 40, recoveringUntilMs: 0, inHazard: false });
    const html = renderToStaticMarkup(<ExposureMeter store={store} />);
    expect(html).toContain("#34d399");
    expect(html).toContain('data-low="false"');
  });

  it("uses the amber colour at 20 (between 10-25)", () => {
    const store = new HazardStore();
    store.applyHazardUpdate({ exposure: 20, recoveringUntilMs: 0, inHazard: true });
    const html = renderToStaticMarkup(<ExposureMeter store={store} />);
    expect(html).toContain("#f59e0b");
  });

  it("uses the red colour below 10 and flips `data-low`", () => {
    const store = new HazardStore();
    store.applyHazardUpdate({ exposure: 5, recoveringUntilMs: 0, inHazard: true });
    const html = renderToStaticMarkup(<ExposureMeter store={store} />);
    expect(html).toContain("#ff3344");
    expect(html).toContain('data-low="true"');
  });

  it("renders the radiation icon inside a rad zone", () => {
    const store = new HazardStore();
    store.applyHazardUpdate({
      exposure: 30,
      recoveringUntilMs: 0,
      inHazard: true,
      currentHazard: {
        hazardId: "h-1",
        kind: "radzone",
        pos: [0, 0, 0],
        radius: 200,
        intensity: 5,
      },
    });
    const html = renderToStaticMarkup(<ExposureMeter store={store} />);
    expect(html).toContain('data-kind="radzone"');
    expect(html).toContain("#7CFF6B");
  });

  it("renders the storm icon inside a storm cell", () => {
    const store = new HazardStore();
    store.applyHazardUpdate({
      exposure: 30,
      recoveringUntilMs: 0,
      inHazard: true,
      currentHazard: {
        hazardId: "h-2",
        kind: "storm",
        pos: [0, 0, 0],
        radius: 200,
        intensity: 2,
      },
    });
    const html = renderToStaticMarkup(<ExposureMeter store={store} />);
    expect(html).toContain('data-kind="storm"');
  });

  it("renders the drones icon inside a drone cell", () => {
    const store = new HazardStore();
    store.applyHazardUpdate({
      exposure: 30,
      recoveringUntilMs: 0,
      inHazard: true,
      currentHazard: {
        hazardId: "h-3",
        kind: "drones",
        pos: [0, 0, 0],
        radius: 150,
        intensity: 0,
      },
    });
    const html = renderToStaticMarkup(<ExposureMeter store={store} />);
    expect(html).toContain('data-kind="drones"');
  });

  it("renders the neutral triangle when out of hazards", () => {
    const store = new HazardStore();
    store.applyHazardUpdate({ exposure: 50, recoveringUntilMs: 0, inHazard: false });
    const html = renderToStaticMarkup(<ExposureMeter store={store} />);
    expect(html).toContain('data-kind="neutral"');
  });

  it("flips to RECOVERING + data-recovering=true when the timer is in the future", () => {
    const store = new HazardStore();
    const now = Date.now();
    store.applyHazardUpdate({
      exposure: 0,
      recoveringUntilMs: now + 5_000,
      inHazard: false,
    });
    const html = renderToStaticMarkup(<ExposureMeter store={store} />);
    expect(html).toContain('data-recovering="true"');
    expect(html).toContain("RECOVERING");
    expect(html).toContain('data-testid="drift-exposure-recovering-badge"');
    expect(html).toContain('data-testid="drift-exposure-recovering-countdown"');
    // 5 s ceiling-up readout, frozen clock at start.
    expect(html).toContain("5s");
    // The border should pulse red during recover.
    expect(html).toContain("rgba(255, 51, 68, 0.7)");
  });

  it("stays in normal mode once the recovering timer has elapsed", () => {
    const store = new HazardStore();
    const now = Date.now();
    store.applyHazardUpdate({
      exposure: 30,
      recoveringUntilMs: now - 100,
      inHazard: false,
    });
    const html = renderToStaticMarkup(<ExposureMeter store={store} />);
    expect(html).toContain('data-recovering="false"');
    expect(html).not.toContain('data-testid="drift-exposure-recovering-badge"');
  });

  it("reflects the current hazard kind on the meter root", () => {
    const store = new HazardStore();
    store.applyHazardUpdate({
      exposure: 25,
      recoveringUntilMs: 0,
      inHazard: true,
      currentHazard: {
        hazardId: "h",
        kind: "radzone",
        pos: [0, 0, 0],
        radius: 200,
        intensity: 5,
      },
    });
    const html = renderToStaticMarkup(<ExposureMeter store={store} />);
    expect(html).toContain('data-current-hazard-kind="radzone"');
  });
});
