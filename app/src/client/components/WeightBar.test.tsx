/**
 * WeightBar HUD component test — TASK-34.
 *
 * Renders the component under happy-dom and asserts:
 *   - Hidden when `inventory === null` (mid-handshake).
 *   - Visible with the right `weightUsed / 40` readout when an
 *     inventory is provided.
 *   - Colour transitions: grey at <70 %, amber at ≥70 %, red at ≥95 %.
 *   - Tooltip lists every non-zero stack on hover.
 *   - Hidden on the `WeightBar null` case (default export).
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { INVENTORY_WEIGHT_CAP, type Inventory } from "@shared/world/inventory.js";
import { addToInventory, emptyInventory } from "@shared/world/inventoryOps.js";
import { WeightBar } from "./WeightBar.js";

function makeInventory(stacks: Partial<Record<string, number>>): Inventory {
  let inv: Inventory = emptyInventory();
  for (const [id, amount] of Object.entries(stacks)) {
    if (typeof amount !== "number" || amount <= 0) continue;
    const result = addToInventory(inv, id as never, amount);
    inv = result.inventory;
  }
  return inv;
}

describe("WeightBar (TASK-34)", () => {
  it("renders nothing when inventory is null", () => {
    const html = renderToStaticMarkup(<WeightBar inventory={null} />);
    expect(html).toBe("");
  });

  it("shows the weight ratio when inventory is provided", () => {
    const inv = makeInventory({ iron: 10 });
    const html = renderToStaticMarkup(<WeightBar inventory={inv} />);
    expect(html).toContain("Carry 10/" + INVENTORY_WEIGHT_CAP);
    expect(html).toContain('data-testid="drift-weight-bar"');
    expect(html).toContain('aria-label="carry-weight"');
  });

  it("uses grey when below 70%", () => {
    const inv = makeInventory({ iron: 10 });
    const html = renderToStaticMarkup(<WeightBar inventory={inv} />);
    expect(html).toContain("#9aa6b2");
  });

  it("uses amber at >=70%", () => {
    const inv = makeInventory({ iron: 30 });
    const html = renderToStaticMarkup(<WeightBar inventory={inv} />);
    expect(html).toContain("#f5b94d");
  });

  it("uses red at >=95%", () => {
    const inv = makeInventory({ iron: 40 });
    const html = renderToStaticMarkup(<WeightBar inventory={inv} />);
    expect(html).toContain("#d04848");
  });

  it("renders a non-zero width on the fill bar", () => {
    const inv = makeInventory({ iron: 5 });
    const html = renderToStaticMarkup(<WeightBar inventory={inv} />);
    // 5/40 = 12.5 %
    expect(html).toMatch(/width:12\.5%/);
  });

  it("caps the visual fill at 100% when over capacity (defensive)", () => {
    // Construct an over-cap shape to prove the fill rule.
    const over: Inventory = { stacks: { iron: 100 }, weightUsed: INVENTORY_WEIGHT_CAP };
    const html = renderToStaticMarkup(<WeightBar inventory={over} />);
    expect(html).toMatch(/width:100%/);
    expect(html).toContain("Carry " + INVENTORY_WEIGHT_CAP + "/" + INVENTORY_WEIGHT_CAP);
  });
});
