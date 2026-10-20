/**
 * Shared ship / dock panel — TASK-53 component tests.
 *
 * Covers:
 *   - the context-driven tab set (docked / in-flight / dock),
 *   - the default tab per context,
 *   - arrow-key tab switching,
 *   - the docked-gated Repair button (enabled / disabled + reason),
 *   - the livery picker's 500 ms debounce (5 rapid edits → 1 request).
 */
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ShipPanel } from "./ShipPanel.js";
import type { ShipInfo } from "./shipApi.js";

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
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const dockedShip: ShipInfo = {
  id: "ship-1",
  classId: "scout",
  hull: 40,
  shields: 20,
  livery: { primary: "#112233", secondary: "#223344", accent: "#334455" },
  state: "docked",
};

const flyingShip: ShipInfo = { ...dockedShip, state: "flying" };

function mount(node: React.JSX.Element): void {
  act(() => {
    root.render(node);
  });
}

function panel(context: "docked-ship" | "in-flight" | "on-foot-dock", ship: ShipInfo | null) {
  return (
    <ShipPanel
      client={null}
      context={context}
      open
      onClose={() => undefined}
      inventory={null}
      cargo={null}
      balance={1000}
      ship={ship}
    />
  );
}

describe("ShipPanel (TASK-53)", () => {
  it("shows the context-driven tab set", () => {
    mount(panel("docked-ship", dockedShip));
    expect(container.querySelector('[data-testid="drift-ship-panel-tab-overview"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="drift-ship-panel-tab-cargo"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="drift-ship-panel-tab-repair"]')).not.toBeNull();
    // No Sell tab while docked in the ship.
    expect(container.querySelector('[data-testid="drift-ship-panel-tab-sell"]')).toBeNull();
  });

  it("hides the Repair tab while in flight", () => {
    mount(panel("in-flight", flyingShip));
    expect(container.querySelector('[data-testid="drift-ship-panel-tab-repair"]')).toBeNull();
    expect(container.querySelector('[data-testid="drift-ship-panel-tab-overview"]')).not.toBeNull();
  });

  it("adds the Sell tab in the on-foot dock context and opens on it", () => {
    mount(panel("on-foot-dock", dockedShip));
    const sellTab = container.querySelector<HTMLElement>(
      '[data-testid="drift-ship-panel-tab-sell"]',
    );
    expect(sellTab).not.toBeNull();
    expect(sellTab?.getAttribute("aria-selected")).toBe("true");
  });

  it("switches tabs with the arrow keys", () => {
    mount(panel("docked-ship", dockedShip));
    const overviewTab = container.querySelector<HTMLElement>(
      '[data-testid="drift-ship-panel-tab-overview"]',
    );
    expect(overviewTab?.getAttribute("aria-selected")).toBe("true");

    act(() => {
      overviewTab?.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
      );
    });
    const cargoTab = container.querySelector<HTMLElement>(
      '[data-testid="drift-ship-panel-tab-cargo"]',
    );
    expect(cargoTab?.getAttribute("aria-selected")).toBe("true");
  });

  it("enables the Repair button when docked and disables it otherwise", () => {
    mount(panel("docked-ship", dockedShip));
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="drift-ship-panel-tab-repair"]')
        ?.click();
    });
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="drift-ship-panel-repair-button"]',
    );
    expect(button?.disabled).toBe(false);
    expect(container.querySelector('[data-testid="drift-ship-panel-repair-reason"]')).toBeNull();

    // Now the same panel with a flying ship → disabled + a reason.
    act(() => root.render(panel("docked-ship", flyingShip)));
    const flyingButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="drift-ship-panel-repair-button"]',
    );
    expect(flyingButton?.disabled).toBe(true);
    expect(
      container.querySelector('[data-testid="drift-ship-panel-repair-reason"]')?.textContent,
    ).toContain("docked");
  });

  it("previews the repair cost from the live hull + shield values", () => {
    mount(panel("docked-ship", dockedShip));
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="drift-ship-panel-tab-repair"]')
        ?.click();
    });
    // scout: hull 40/100 → 6 points, shields 20/50 → 3 points → 9 cr.
    expect(
      container.querySelector('[data-testid="drift-ship-panel-repair-cost"]')?.textContent,
    ).toBe("9 cr");
  });

  it("debounces the livery pickers (5 rapid edits → 1 request)", () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ship: { ...dockedShip } }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    mount(
      <ShipPanel
        client={null}
        context="docked-ship"
        open
        onClose={() => undefined}
        inventory={null}
        cargo={null}
        balance={1000}
        ship={dockedShip}
        authToken="token-1"
      />,
    );

    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="drift-ship-panel-livery-primary"] input',
    );
    expect(input).not.toBeNull();

    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    for (let i = 0; i < 5; i++) {
      act(() => {
        setter?.call(input, `#00000${i}`);
        input?.dispatchEvent(new window.Event("input", { bubbles: true }));
      });
    }

    expect(fetchMock).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/ships/livery");
    expect(JSON.parse(String(init.body))).toEqual({
      colors: { primary: "#000004", secondary: "#223344", accent: "#334455" },
    });
  });
});
