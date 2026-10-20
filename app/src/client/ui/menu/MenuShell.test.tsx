/**
 * Menu shell — TASK-53 component tests.
 *
 * Covers:
 *   - `ESC` opens the menu, `ESC` closes it again,
 *   - `ESC` pops one level (panel → menu),
 *   - game input is suppressed while a surface is open,
 *   - the focus is trapped inside the panel and restored on close.
 */
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";

import { MenuShellProvider, useMenuShell } from "./MenuShell.js";
import { MenuPanel } from "./MenuPanel.js";

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

/** Dispatch a keydown on the body so the window capture phase runs. */
function pressKey(key: string): void {
  act(() => {
    document.body.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

/**
 * The harness mirrors the real shell: it renders the menu panel
 * when the `menu` surface is on top and a dummy panel for the
 * `systems` surface. It also installs a "game" key listener —
 * the stand-in for the game's own window-level input handling.
 */
function Harness({ onGameKey }: { onGameKey: (key: string) => void }): React.JSX.Element {
  const shell = useMenuShell();
  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => onGameKey(ev.key);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onGameKey]);
  return (
    <div>
      <button type="button" data-testid="game-button">
        game
      </button>
      {shell.top === "menu" ? (
        <MenuPanel
          callsign="PILOT"
          credits={1234}
          onSelect={(item) => {
            if (item === "systems") shell.open("systems");
            else shell.close();
          }}
        />
      ) : null}
      {shell.top === "systems" ? <div data-testid="systems-panel">systems</div> : null}
    </div>
  );
}

function mount(onGameKey: (key: string) => void): void {
  act(() => {
    root.render(
      <MenuShellProvider>
        <Harness onGameKey={onGameKey} />
      </MenuShellProvider>,
    );
  });
}

describe("MenuShell (TASK-53)", () => {
  it("opens the menu on ESC and closes it on the next ESC", () => {
    const seen: string[] = [];
    mount((key) => seen.push(key));
    expect(container.querySelector('[data-testid="drift-menu-panel"]')).toBeNull();

    pressKey("Escape");
    expect(container.querySelector('[data-testid="drift-menu-panel"]')).not.toBeNull();

    pressKey("Escape");
    expect(container.querySelector('[data-testid="drift-menu-panel"]')).toBeNull();
    // The game's own listener never saw the ESC keys (they were
    // swallowed by the shell's capture handler).
    expect(seen).toEqual([]);
  });

  it("pops one level per ESC (panel → menu → closed)", () => {
    mount(() => undefined);
    pressKey("Escape");
    expect(container.querySelector('[data-testid="drift-menu-panel"]')).not.toBeNull();

    // Open the systems panel from the menu.
    act(() => {
      const systems = container.querySelector<HTMLButtonElement>(
        '[data-testid="drift-menu-systems"]',
      );
      systems?.click();
    });
    expect(container.querySelector('[data-testid="systems-panel"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="drift-menu-panel"]')).toBeNull();

    // ESC pops the panel → the menu is back.
    pressKey("Escape");
    expect(container.querySelector('[data-testid="drift-menu-panel"]')).not.toBeNull();

    // ESC pops the menu → closed.
    pressKey("Escape");
    expect(container.querySelector('[data-testid="drift-menu-panel"]')).toBeNull();
  });

  it("suppresses game input while a surface is open", () => {
    const seen: string[] = [];
    mount((key) => seen.push(key));

    // While closed the game sees the key.
    pressKey("1");
    expect(seen).toEqual(["1"]);

    pressKey("Escape");
    seen.length = 0;

    // While the menu is open the game must not see any key.
    pressKey("1");
    pressKey("w");
    pressKey("t");
    expect(seen).toEqual([]);
  });

  it("suppresses game input even when the focus sits inside the panel", () => {
    const seen: string[] = [];
    mount((key) => seen.push(key));
    pressKey("Escape");
    seen.length = 0;

    const resume = container.querySelector<HTMLButtonElement>('[data-testid="drift-menu-resume"]');
    expect(resume).not.toBeNull();
    act(() => {
      resume?.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "1", bubbles: true, cancelable: true }),
      );
    });
    expect(seen).toEqual([]);
  });

  it("traps the focus inside the panel and restores it on close", () => {
    mount(() => undefined);
    const gameButton = container.querySelector<HTMLButtonElement>('[data-testid="game-button"]');
    gameButton?.focus();
    expect(document.activeElement).toBe(gameButton);

    pressKey("Escape");
    const panel = container.querySelector<HTMLElement>('[data-testid="drift-menu-panel"]');
    expect(panel).not.toBeNull();
    // The menu focuses its first item on mount.
    const resume = container.querySelector<HTMLButtonElement>('[data-testid="drift-menu-resume"]');
    expect(document.activeElement).toBe(resume);

    // Tab cycles inside the panel — the focus never leaves it.
    act(() => {
      resume?.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
      );
    });
    expect(panel?.contains(document.activeElement)).toBe(true);

    // Closing the menu restores the previously focused element.
    pressKey("Escape");
    expect(document.activeElement).toBe(gameButton);
  });
});
