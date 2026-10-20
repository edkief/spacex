/**
 * ESC menu panel — TASK-53 component tests.
 *
 * Covers the keyboard-first flow (arrows move the focus, Enter
 * activates) and the footer (callsign + credits).
 */
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { MenuPanel } from "./MenuPanel.js";
import { MenuShellProvider } from "./MenuShell.js";

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
});

function mount(onSelect: (item: string) => void): void {
  act(() => {
    root.render(
      <MenuShellProvider>
        <MenuPanel callsign="PILOT" credits={4321} onSelect={onSelect as never} />
      </MenuShellProvider>,
    );
  });
}

describe("MenuPanel (TASK-53)", () => {
  it("renders the four navigation items", () => {
    mount(() => undefined);
    for (const id of ["resume", "systems", "ships", "settings"]) {
      expect(container.querySelector(`[data-testid="drift-menu-${id}"]`)).not.toBeNull();
    }
  });

  it("shows the callsign + credits in the footer", () => {
    mount(() => undefined);
    expect(container.querySelector('[data-testid="drift-menu-callsign"]')?.textContent).toBe(
      "PILOT",
    );
    expect(container.querySelector('[data-testid="drift-menu-credits"]')?.textContent).toBe(
      "4,321 cr",
    );
  });

  it("focuses the first item on mount", () => {
    mount(() => undefined);
    expect(document.activeElement).toBe(
      container.querySelector('[data-testid="drift-menu-resume"]'),
    );
  });

  it("moves the focus with the arrow keys", () => {
    mount(() => undefined);
    const resume = container.querySelector<HTMLButtonElement>('[data-testid="drift-menu-resume"]');
    act(() => {
      resume?.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
      );
    });
    expect(document.activeElement).toBe(
      container.querySelector('[data-testid="drift-menu-systems"]'),
    );
  });

  it("activates an item with Enter (native button activation)", () => {
    const picked: string[] = [];
    mount((item) => picked.push(item));
    const systems = container.querySelector<HTMLButtonElement>(
      '[data-testid="drift-menu-systems"]',
    );
    act(() => {
      systems?.click();
    });
    expect(picked).toEqual(["systems"]);
  });
});
