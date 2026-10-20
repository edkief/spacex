/**
 * LiveRegion component test — TASK-54.
 *
 * Asserts the screen-reader contract:
 *   - the status region is `aria-live="polite"` and carries the
 *     HUD summary sentence,
 *   - the region refreshes at 1 Hz (not the 10 Hz HUD cadence),
 *   - the announcement region carries queued announcements.
 */
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { LiveRegion } from "./LiveRegion.js";
import { Announcer } from "./announcer.js";

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
  vi.useRealTimers();
});

/** The live region nodes. */
function statusNode(): HTMLElement | null {
  return container.querySelector('[data-testid="drift-live-status"]');
}
function announceNode(): HTMLElement | null {
  return container.querySelector('[data-testid="drift-live-announce"]');
}

describe("LiveRegion", () => {
  it("renders a polite status region and a polite announcement region", () => {
    act(() => {
      root.render(<LiveRegion readSummary={() => ({ speedMps: 120, hull: 80 })} />);
    });
    const status = statusNode();
    expect(status).not.toBeNull();
    expect(status?.getAttribute("aria-live")).toBe("polite");
    expect(status?.getAttribute("role")).toBe("status");
    expect(announceNode()?.getAttribute("aria-live")).toBe("polite");
  });

  it("speaks the HUD summary sentence", () => {
    act(() => {
      root.render(<LiveRegion readSummary={() => ({ speedMps: 120, hull: 80 })} />);
    });
    expect(statusNode()?.textContent).toBe("Speed 120 meters per second. Hull 80 percent.");
  });

  it("refreshes the status region at 1 Hz", () => {
    vi.useFakeTimers();
    let speed = 100;
    act(() => {
      root.render(<LiveRegion readSummary={() => ({ speedMps: speed })} />);
    });
    expect(statusNode()?.textContent).toBe("Speed 100 meters per second.");
    // Nine 100 ms ticks (0.9 s) must NOT have refreshed the text.
    act(() => {
      vi.advanceTimersByTime(900);
    });
    expect(statusNode()?.textContent).toBe("Speed 100 meters per second.");
    // The tenth tick crosses the 1 s boundary → the summary updates.
    speed = 150;
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(statusNode()?.textContent).toBe("Speed 150 meters per second.");
  });

  it("renders a queued announcement in the announcement region", () => {
    const queue = new Announcer({ minIntervalMs: 0 });
    act(() => {
      root.render(<LiveRegion queue={queue} />);
    });
    act(() => {
      queue.announce("target locked", "combat", 1_000);
    });
    expect(announceNode()?.textContent).toBe("target locked");
  });

  it("keeps the announcement region quiet until the queue drains", () => {
    const queue = new Announcer({ minIntervalMs: 2_000 });
    act(() => {
      root.render(<LiveRegion queue={queue} readSummary={() => ({})} />);
    });
    act(() => {
      queue.announce("first", "navigation", 1_000);
      queue.announce("second", "navigation", 1_100);
    });
    expect(announceNode()?.textContent).toBe("first");
  });
});
