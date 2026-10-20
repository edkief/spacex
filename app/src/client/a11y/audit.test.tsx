/**
 * Accessible-name audit test — TASK-54.
 *
 * Walks the DOM of the rendered screens and asserts that no
 * interactive element is missing an accessible name.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Window } from "happy-dom";

import { findUnlabeledInteractive, accessibleName } from "./audit.js";
import { MenuPanel } from "../ui/menu/MenuPanel.js";
import { MenuShellProvider } from "../ui/menu/MenuShell.js";
import { PanelShell } from "../ui/ship/PanelShell.js";

/** Parse a markup string into a live DOM and audit it. */
function audit(markup: string): string[] {
  const win = new Window();
  const doc = win.document;
  doc.body.innerHTML = markup;
  return findUnlabeledInteractive(doc as never).map((p) => `${p.description}: ${p.reason}`);
}

describe("accessibleName", () => {
  it("prefers aria-label", () => {
    const win = new Window();
    const el = win.document.createElement("button");
    el.setAttribute("aria-label", "Close panel");
    el.textContent = "X";
    expect(accessibleName(el as never)).toBe("Close panel");
  });

  it("falls back to the text content", () => {
    const win = new Window();
    const el = win.document.createElement("button");
    el.textContent = "Resume";
    expect(accessibleName(el as never)).toBe("Resume");
  });

  it("resolves aria-labelledby", () => {
    const win = new Window();
    const doc = win.document;
    doc.body.innerHTML = '<span id="lbl">Systems</span><button aria-labelledby="lbl"></button>';
    const btn = doc.querySelector("button")!;
    expect(accessibleName(btn as never, doc as never)).toBe("Systems");
  });
});

describe("findUnlabeledInteractive", () => {
  it("passes the ESC menu panel", () => {
    const markup = renderToStaticMarkup(
      <MenuShellProvider>
        <MenuPanel callsign="Drift-1" credits={500} onSelect={() => {}} />
      </MenuShellProvider>,
    );
    expect(audit(markup)).toEqual([]);
  });

  it("passes the ship panel shell", () => {
    const markup = renderToStaticMarkup(
      <PanelShell
        title="Ship"
        testId="drift-ship-panel"
        tabs={["overview", "cargo"] as never}
        activeTab={"overview" as never}
        onTab={() => {}}
        onClose={() => {}}
      >
        <button type="button">Repair</button>
      </PanelShell>,
    );
    expect(audit(markup)).toEqual([]);
  });

  it("flags an unlabeled button", () => {
    const problems = audit('<button type="button"></button>');
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain("button");
  });

  it("ignores hidden inputs and aria-hidden subtrees", () => {
    const problems = audit(
      '<input type="hidden" /><div aria-hidden="true"><button></button></div>',
    );
    expect(problems).toEqual([]);
  });
});
