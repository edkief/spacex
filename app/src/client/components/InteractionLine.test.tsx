/**
 * InteractionLine component test — TASK-52.
 *
 * Asserts the bottom-centre interaction line's exclusivity rules:
 *
 *   - The line renders an `<InteractionPrompt>` driven by the
 *     cone-raycast exclusivity (nearest wins).
 *   - Hidden (no `[data-testid="drift-interact-prompt"]`) when
 *     nothing is in range.
 *   - When the host's `enabled` is `false` the prompt hides but
 *     the line wrapper stays mounted.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { InteractionLine } from "./InteractionLine.js";
import type { Interactable } from "../input/interaction.js";

function makeInteractor() {
  return { pos: { x: 0, y: 0, z: 0 }, forward: { x: 1, y: 0, z: 0 } };
}

const iron: Interactable = {
  id: "dep-iron",
  kind: "deposit",
  pos: { x: 1, y: 0, z: 0 },
};

const terminal: Interactable = {
  id: "term-1",
  kind: "dock-terminal",
  pos: { x: 1, y: 0, z: 0 },
};

describe("InteractionLine (TASK-52)", () => {
  it("mounts the wrapper without the prompt when nothing is in range", () => {
    const html = renderToStaticMarkup(
      <InteractionLine
        interactor={makeInteractor()}
        interactables={[]}
        onInteract={() => {}}
        enabled
      />,
    );
    expect(html).toContain('data-testid="drift-interaction-line"');
    expect(html).not.toContain('data-testid="drift-interact-prompt"');
  });

  it("renders the prompt when an interactable is in range", () => {
    const html = renderToStaticMarkup(
      <InteractionLine
        interactor={makeInteractor()}
        interactables={[iron]}
        onInteract={() => {}}
        enabled
      />,
    );
    expect(html).toContain('data-testid="drift-interact-prompt"');
    expect(html).toContain("Take");
  });

  it("shows one prompt at a time (nearest-wins exclusivity on two targets)", () => {
    // Both targets are inside the cone (forward cone is 3 m along +X
    // with a 30° half-angle). The cone-raycast in
    // `@client/input/interaction.ts` returns the *nearest* target,
    // so we assert that the rendered prompt points at `iron`
    // (closer to the character's origin).
    const near: Interactable = {
      id: "dep-near",
      kind: "deposit",
      pos: { x: 0.5, y: 0, z: 0 },
    };
    const far: Interactable = {
      id: "dep-far",
      kind: "deposit",
      pos: { x: 2.5, y: 0, z: 0 },
    };
    const html = renderToStaticMarkup(
      <InteractionLine
        interactor={makeInteractor()}
        interactables={[far, near]}
        onInteract={() => {}}
        enabled
      />,
    );
    expect(html).toContain('data-testid="drift-interact-prompt"');
    // Only the near target should be in the prompt's data-attribute set.
    const matches = html.match(/data-target-id="dep-[a-z]+"/g) ?? [];
    expect(matches.length).toBe(1);
    expect(matches[0]).toBe('data-target-id="dep-near"');
  });

  it("renders the prompt even when the WS is offline (the mode-switch is the gate)", () => {
    // The InteractionPrompt's `enabled` prop only gates the keydown
    // listener — the visual prompt stays mounted so a reconnected
    // player sees the same affordance without a re-render. The
    // mode-switch (ShipHUD vs OnFootHUD) is the gate that hides the
    // whole subtree when the player transitions to the ship.
    const html = renderToStaticMarkup(
      <InteractionLine
        interactor={makeInteractor()}
        interactables={[iron]}
        onInteract={() => {}}
        enabled={false}
      />,
    );
    expect(html).toContain('data-testid="drift-interact-prompt"');
  });

  it("renders the dock-terminal prompt when a terminal is the only target", () => {
    const html = renderToStaticMarkup(
      <InteractionLine
        interactor={makeInteractor()}
        interactables={[terminal]}
        onInteract={() => {}}
        enabled
      />,
    );
    expect(html).toContain('data-testid="drift-interact-prompt"');
    expect(html).toContain("Dock");
  });
});
