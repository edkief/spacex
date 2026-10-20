/**
 * OnFootHUD assembly test — TASK-52.
 *
 * Asserts the on-foot HUD:
 *   - Mounts the exposure meter, weight bar, and interaction line.
 *   - Renders the bottom-right exposure meter (`data-testid`).
 *   - Renders the bottom-right weight bar only when the inventory
 *     is present (TASK-34 stays the source of truth).
 *   - Carries a `data-mode="character"` marker so the e2e suite
 *     can confirm the OnFootHUD subtree is the active one.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { OnFootHUD } from "./OnFootHUD.js";
import { HazardStore } from "../world/hazards.js";
import type { Interactable } from "../input/interaction.js";

function makeInteractor() {
  return { pos: { x: 0, y: 0, z: 0 }, forward: { x: 1, y: 0, z: 0 } };
}

const ironDeposit: Interactable = {
  id: "dep-iron",
  kind: "deposit",
  pos: { x: 1, y: 0, z: 0 },
};

describe("OnFootHUD (TASK-52)", () => {
  it("mounts the three on-foot regions together", () => {
    const store = new HazardStore();
    const html = renderToStaticMarkup(
      <OnFootHUD
        hazardStore={store}
        interactor={makeInteractor()}
        interactables={[ironDeposit]}
        onInteract={() => {}}
        enabled
      />,
    );
    expect(html).toContain('data-testid="drift-on-foot-hud"');
    expect(html).toContain('data-mode="character"');
    expect(html).toContain('data-testid="drift-exposure-meter"');
    expect(html).toContain('data-testid="drift-interaction-line"');
  });

  it("hides the weight bar when the inventory hasn't populated yet (TASK-34 contract)", () => {
    // The WeightBar's own `useOwnInventory()` polls
    // `window.__driftClient.getInventory?.() ?? null`, which is
    // unavailable in the SSR path so the bar stays hidden. Render
    // the tree statically and verify the WeightBar element is not
    // present.
    const store = new HazardStore();
    const html = renderToStaticMarkup(
      <OnFootHUD
        hazardStore={store}
        interactor={null}
        interactables={[]}
        onInteract={() => {}}
        enabled={false}
      />,
    );
    expect(html).not.toContain('data-testid="drift-weight-bar"');
  });

  it("renders a recovering-state exposure meter when the hazard says so", () => {
    const store = new HazardStore();
    const now = Date.now();
    store.applyHazardUpdate({
      exposure: 0,
      recoveringUntilMs: now + 5_000,
      inHazard: false,
    });
    const html = renderToStaticMarkup(
      <OnFootHUD
        hazardStore={store}
        interactor={null}
        interactables={[]}
        onInteract={() => {}}
        enabled={false}
      />,
    );
    expect(html).toContain("RECOVERING");
  });

  it("does NOT render any ship-HUD region (mode coherence)", () => {
    const store = new HazardStore();
    const html = renderToStaticMarkup(
      <OnFootHUD
        hazardStore={store}
        interactor={makeInteractor()}
        interactables={[ironDeposit]}
        onInteract={() => {}}
        enabled
      />,
    );
    // Sanity: not a single ship-HUD test id should leak into the
    // on-foot subtree (the mode switch test enforces the inverse
    // direction in App.tsx's branch swap).
    expect(html).not.toContain('data-testid="drift-speed-readout"');
    expect(html).not.toContain('data-testid="drift-altitude-readout"');
    expect(html).not.toContain('data-testid="drift-regime-tag"');
    expect(html).not.toContain('data-testid="drift-nav-readout"');
    expect(html).not.toContain('data-testid="drift-vitals-bar"');
    expect(html).not.toContain('data-testid="drift-docked-tag"');
    // And the prompt is exclusive to the on-foot subtree.
    expect(html).toContain('data-testid="drift-interact-prompt"');
  });
});
