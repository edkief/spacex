/**
 * GuidanceHint component unit tests (TASK-56).
 *
 * Mounts the overlay against a real `GuidanceStore` driven by a
 * stubbed localStorage. Covers:
 *
 *   - renders the current step's copy,
 *   - advances through the four hints on the event sequence,
 *   - the finale auto-hides after 5 s,
 *   - the X button dispatches `dismiss`,
 *   - a dismissed store never re-shows the hint line.
 *
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { GuidanceStore, GUIDANCE_STORAGE_KEY } from "../guidance.js";
import { GuidanceHint } from "./GuidanceHint.js";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

class MemoryStorage {
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
}

let container: HTMLDivElement;
let root: Root;
let storage: MemoryStorage;
let guidanceStore: GuidanceStore;
const nowMs = 1_700_000_000_000;

function mountHint(): HTMLElement {
  act(() => {
    root.render(<GuidanceHint store={guidanceStore} />);
  });
  return container;
}

beforeEach(() => {
  storage = new MemoryStorage();
  guidanceStore = new GuidanceStore({
    storage,
    now: () => nowMs,
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("GuidanceHint — initial render", () => {
  it("mounts with the STEP_FLY copy for a fresh player", () => {
    mountHint();
    const hint = container.querySelector('[data-testid="drift-guidance-hint"]');
    expect(hint).not.toBeNull();
    expect(hint?.getAttribute("data-step")).toBe("0");
    expect(hint?.textContent).toMatch(/Hold W to fly/);
  });

  it("renders the finale copy for a returning player at step 3", () => {
    // A returning player lands at the persisted step (3 = finale);
    // the overlay shows the finale line on the first frame and the
    // 5 s auto-hide timer subsequently clears it.
    storage.setItem(GUIDANCE_STORAGE_KEY, JSON.stringify({ step: 3 }));
    const pastStore = new GuidanceStore({ storage, now: () => nowMs });
    act(() => {
      root.render(<GuidanceHint store={pastStore} />);
    });
    const hint = container.querySelector('[data-testid="drift-guidance-hint"]');
    expect(hint).not.toBeNull();
    expect(hint?.getAttribute("data-step")).toBe("3");
    expect(hint?.textContent).toMatch(/drifting/);
  });

  it("renders nothing when the player has dismissed the hint", () => {
    guidanceStore.recordEvent("dismiss");
    act(() => {
      root.render(<GuidanceHint store={guidanceStore} />);
    });
    expect(container.querySelector('[data-testid="drift-guidance-hint"]')).toBeNull();
  });
});

describe("GuidanceHint — event progression", () => {
  it("updates the copy when the underlying store advances", () => {
    mountHint();
    expect(container.querySelector('[data-testid="drift-guidance-hint"]')?.textContent).toMatch(
      /Hold W/,
    );
    act(() => {
      guidanceStore.recordEvent("docked");
    });
    expect(container.querySelector('[data-testid="drift-guidance-hint"]')?.textContent).toMatch(
      /Press E at a docked/,
    );
    expect(
      container.querySelector('[data-testid="drift-guidance-hint"]')?.getAttribute("data-step"),
    ).toBe("1");
  });
});

describe("GuidanceHint — dismiss button", () => {
  it("the dismiss button clears the overlay", () => {
    mountHint();
    expect(container.querySelector('[data-testid="drift-guidance-hint"]')).not.toBeNull();
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="drift-guidance-hint-dismiss"]',
    );
    if (!button) throw new Error("no dismiss button");
    act(() => {
      button.click();
    });
    expect(container.querySelector('[data-testid="drift-guidance-hint"]')).toBeNull();
    expect(storage.getItem(GUIDANCE_STORAGE_KEY)).toBeNull();
  });
});

describe("GuidanceHint — finale auto-hide", () => {
  it("the finale hides after the 5 s timer", () => {
    vi.useFakeTimers();
    try {
      mountHint();
      act(() => {
        guidanceStore.recordEvent("docked");
      });
      act(() => {
        guidanceStore.recordEvent("disembark");
      });
      act(() => {
        guidanceStore.recordEvent("firstSale");
      });
      const before = container.querySelector('[data-testid="drift-guidance-hint"]');
      expect(before).not.toBeNull();
      expect(before?.getAttribute("data-step")).toBe("3");
      act(() => {
        vi.advanceTimersByTime(5_500);
      });
      expect(container.querySelector('[data-testid="drift-guidance-hint"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
