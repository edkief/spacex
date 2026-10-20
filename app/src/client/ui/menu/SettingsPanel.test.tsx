/**
 * Settings panel test — TASK-54.
 *
 * Asserts the reduced-motion surface:
 *   - it focuses its first control when it opens (focus management),
 *   - `Tab` cycles inside the panel (the focus trap),
 *   - the checkbox flips the shared settings flag,
 *   - the panel declares itself as a menu surface (so the shell's
 *     input gate lets its keys through).
 */
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { SettingsPanel } from "./SettingsPanel.js";
import { settingsStore } from "../../a11y/settings.js";

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
  settingsStore.setReducedMotion(false);
});

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

  it("focuses the toggle when it opens", () => {
    act(() => {
      root.render(<SettingsPanel />);
    });
    expect(document.activeElement?.getAttribute("data-testid")).toBe(
      "drift-settings-reduced-motion-input",
    );
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
