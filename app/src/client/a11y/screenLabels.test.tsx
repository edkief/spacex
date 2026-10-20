/**
 * Screen-state aria-label coverage test — TASK-54.
 *
 * Renders every screen the client can show and asserts that no
 * interactive element is missing an accessible name. This is the
 * unit-level twin of the DOM walk in the keyboard-only e2e (which
 * covers the live, running app).
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Window } from "happy-dom";

import { findUnlabeledInteractive } from "./audit.js";
import { MenuPanel } from "../ui/menu/MenuPanel.js";
import { MenuShellProvider } from "../ui/menu/MenuShell.js";
import { SettingsPanel } from "../ui/menu/SettingsPanel.js";
import { PanelShell } from "../ui/ship/PanelShell.js";
import { SellTab } from "../ui/ship/SellTab.js";
import { OverviewTab } from "../ui/ship/OverviewTab.js";

/** Render markup + audit it. Returns the offending descriptions. */
function audit(markup: string): string[] {
  const win = new Window();
  const doc = win.document;
  doc.body.innerHTML = markup;
  return findUnlabeledInteractive(doc as never).map((p) => `${p.description}: ${p.reason}`);
}

/** The screen states the client can show. */
const SCREENS: ReadonlyArray<{ name: string; markup: () => string }> = [
  {
    name: "ESC menu",
    markup: () =>
      renderToStaticMarkup(
        <MenuShellProvider>
          <MenuPanel callsign="Drift-1" credits={500} onSelect={() => {}} />
        </MenuShellProvider>,
      ),
  },
  {
    name: "settings panel",
    markup: () => renderToStaticMarkup(<SettingsPanel />),
  },
  {
    name: "ship panel shell",
    markup: () =>
      renderToStaticMarkup(
        <PanelShell
          title="Ship"
          testId="drift-ship-panel"
          tabs={["overview", "cargo", "repair", "sell"] as never}
          activeTab={"overview" as never}
          onTab={() => {}}
          onClose={() => {}}
        >
          <button type="button">Repair</button>
        </PanelShell>,
      ),
  },
];

describe("screen-state accessible-name coverage", () => {
  for (const screen of SCREENS) {
    it(`${screen.name}: every interactive element has an accessible name`, () => {
      expect(audit(screen.markup())).toEqual([]);
    });
  }

  it("the sell tab's row buttons are labelled", () => {
    const markup = renderToStaticMarkup(
      <SellTab
        rows={[
          {
            id: "iron",
            total: 3,
            invAmount: 1,
            cargoAmount: 2,
            price: 10,
          },
        ]}
        onSellOne={() => {}}
        onSellAll={() => {}}
        canSell
        testIdPrefix="drift-ship-panel"
      />,
    );
    expect(audit(markup)).toEqual([]);
    expect(markup).toContain("Sell 1 iron");
    expect(markup).toContain("Sell all iron");
  });

  it("the overview tab's livery pickers are labelled", () => {
    const markup = renderToStaticMarkup(
      <OverviewTab
        ship={{
          id: "s1",
          classId: "scout",
          hull: 80,
          shields: 50,
          livery: { primary: "#ff0000", secondary: "#00ff00", accent: "#0000ff" },
          state: "docked",
        }}
        energy={40}
        onLiveryChange={() => {}}
        testIdPrefix="drift-ship-panel"
      />,
    );
    expect(audit(markup)).toEqual([]);
  });
});
