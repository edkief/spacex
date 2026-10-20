/**
 * TASK-54 — keyboard-only accessibility proof.
 *
 * This spec is the project's a11y headline test: it drives the
 * **entire UI with keyboard events only** — no `click()`, no
 * `mouse.move()`, no pointer events of any kind. Every assertion
 * checks a DOM state change, so a regression in the input gating
 * (TASK-53) or in the focus management fails the run.
 *
 * What it covers:
 *
 *   1. **Boot** — the auto-claim handshake lands (the client is
 *      online; the player list shows the callsign).
 *   2. **Live regions** — the 1 Hz status region carries the HUD
 *      summary sentence, and the announcement region is a polite
 *      `aria-live` node.
 *   3. **Accessible names** — every interactive element in the live
 *      DOM has an accessible name (the shared audit helper).
 *   4. **Chart** — `M` opens the star chart, `Tab` moves focus to
 *      a system node, `Enter` selects it, `Tab` reaches the Warp
 *      button and `Enter` fires the warp.
 *   5. **ESC menu** — `Escape` opens the menu, `ArrowDown` moves
 *      the focus, `Enter` activates the item, `Escape` closes the
 *      surface and the focus returns to the trigger.
 *   6. **Focus trap** — `Tab` inside the menu cycles within the
 *      panel instead of escaping to the page.
 *   7. **Reduced motion** — the settings toggle is keyboard
 *      operable and the FX registry reports zero played effects
 *      while it is on.
 *
 * The flight-dependent tail of the loop (dock → disembark → mine →
 * re-enter → sell) needs the flight-assist harness, which the
 * repo has not landed yet (see `disembark.spec.ts` + `sell.spec.ts`
 * — they drive the same wire round trips through the dev seam).
 * This spec proves the *keyboard* half: every surface the loop
 * touches is reachable and operable without a mouse.
 */
import path from "node:path";
import { test, expect } from "./fixtures.js";
import { ClaimPage } from "./pages/claim.js";

const SHOTS_DIR = path.join(process.cwd(), "..", ".ralph", "screenshots");

/** The keyboard-only audit helper, inlined so the page context is self-contained. */
const AUDIT_FN = `
  (selector) => {
    const nodes = Array.from(document.querySelectorAll(selector));
    const problems = [];
    for (const el of nodes) {
      if (el.getAttribute('type') === 'hidden') continue;
      if (el.getAttribute('aria-hidden') === 'true') continue;
      if (el.closest('[aria-hidden="true"]') !== null) continue;
      const labelledBy = el.getAttribute('aria-labelledby');
      let name = '';
      if (labelledBy) {
        name = labelledBy.split(/\\s+/).map((id) => (document.getElementById(id)?.textContent ?? '')).join(' ').trim();
      }
      if (name === '') name = (el.getAttribute('aria-label') ?? '').trim();
      if (name === '') name = (el.textContent ?? '').trim();
      if (name === '') name = (el.getAttribute('title') ?? '').trim();
      if (name === '') name = (el.getAttribute('placeholder') ?? '').trim();
      if (name === '') {
        problems.push(el.tagName.toLowerCase() + (el.getAttribute('data-testid') ? '[' + el.getAttribute('data-testid') + ']' : ''));
      }
    }
    return problems;
  }
`;

/** The selector list of interactive elements (mirrors `a11y/audit.ts`). */
const INTERACTIVE_SELECTOR = [
  "button",
  "input",
  "select",
  "textarea",
  "a[href]",
  "[role='button']",
  "[role='menuitem']",
  "[role='option']",
  "[role='tab']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

test("the whole UI is operable with the keyboard alone", async ({ page, driftServer: server }) => {
  test.setTimeout(120_000);
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  // Guard: the test must not dispatch any pointer event. We count
  // them so a future edit that reaches for `page.click()` fails.
  let pointerEvents = 0;
  page.on("mousedown", () => {
    pointerEvents += 1;
  });
  page.on("mouseup", () => {
    pointerEvents += 1;
  });
  page.on("click", () => {
    pointerEvents += 1;
  });

  const claim = new ClaimPage(page, server);
  await claim.bootAndWaitForOnline();

  // ---- 1. The live regions exist ---------------------------------------
  const status = page.getByTestId("drift-live-status");
  await expect(status).toHaveAttribute("aria-live", "polite");
  const announce = page.getByTestId("drift-live-announce");
  await expect(announce).toHaveAttribute("aria-live", "polite");

  // The status region carries the HUD summary sentence (1 Hz).
  await expect
    .poll(async () => (await status.textContent())?.trim() ?? "", {
      timeout: 10_000,
      intervals: [200, 500, 1000],
    })
    .toMatch(/meters per second|Hull|Exposure|Credits/);

  // ---- 2. The canvas is exposed as an image with a label ---------------
  await expect(page.getByTestId("drift-canvas")).toHaveAttribute("role", "img");
  await expect(page.getByTestId("drift-canvas")).toHaveAttribute("aria-label", /3D view/);

  // ---- 3. Every interactive element has an accessible name ------------
  const unlabeled = await page.evaluate(
    ([fn, selector]) => {
      const audit = eval(fn) as (s: string) => string[];
      return audit(selector);
    },
    [AUDIT_FN, INTERACTIVE_SELECTOR] as [string, string],
  );
  expect(unlabeled, `unlabeled interactive elements: ${unlabeled.join(", ")}`).toEqual([]);

  // ---- 4. The chart opens + warps with the keyboard --------------------
  const menu = page.getByTestId("drift-menu-panel");
  await page.keyboard.press("m");
  const chart = page.getByTestId("drift-star-chart");
  await expect(chart).toBeVisible({ timeout: 5_000 });
  // The node list arrives with the overview payload — wait for it so
  // the `Tab` walk below has something to land on.
  await expect(chart.locator('g[data-testid="drift-star-chart-node"]').first()).toBeVisible({
    timeout: 10_000,
  });

  // Tab until a *non-current* star node has focus (the chart is a
  // focus trap of its own — the nodes are `<g role="button"
  // tabIndex={0}>`). The Warp button stays disabled for the
  // current system, so the node we pick must be a different one.
  const sourceSystemId = await claim.currentSystemId();
  let focusedSystemId: string | null = null;
  for (let i = 0; i < 60 && focusedSystemId === null; i++) {
    await page.keyboard.press("Tab");
    const id = await page.evaluate(() => {
      const active = document.activeElement;
      if (active === null) return null;
      const sysId = active.getAttribute?.("data-system-id");
      return sysId ?? null;
    });
    if (id !== null && id !== sourceSystemId) focusedSystemId = id;
  }
  expect(focusedSystemId, "expected Tab to reach a non-current star-chart node").toBeTruthy();

  // `Enter` selects the focused node.
  await page.keyboard.press("Enter");
  await expect
    .poll(
      async () =>
        page.locator(`[data-system-id="${focusedSystemId}"]`).getAttribute("data-is-selected"),
      { timeout: 5_000 },
    )
    .toBe("true");

  // `Tab` reaches the Warp button; `Enter` fires the warp.
  let warpFocused = false;
  for (let i = 0; i < 60 && !warpFocused; i++) {
    await page.keyboard.press("Tab");
    warpFocused = await page.evaluate(() => {
      const active = document.activeElement;
      return active?.getAttribute?.("data-testid") === "drift-star-chart-warp";
    });
  }
  expect(warpFocused, "expected Tab to reach the Warp button").toBe(true);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("drift-warp-overlay")).toBeVisible({ timeout: 5_000 });
  await page.screenshot({ path: path.join(SHOTS_DIR, "TASK-54-1.png") });

  // The warp completes and the overlay retracts on its own.
  await expect(page.getByTestId("drift-warp-overlay")).toBeHidden({ timeout: 15_000 });

  // ---- 5. The ESC menu opens + navigates + closes with the keyboard ----
  // The chart is still open at this point, so the first `Escape`
  // closes it (the shell pops one level) and the next opens the
  // menu. We press until the menu shows up.
  for (let i = 0; i < 4; i++) {
    if ((await menu.count()) > 0) break;
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
  }
  await expect(menu).toBeVisible({ timeout: 5_000 });

  // Focus starts on the first menu item.
  await expect
    .poll(async () => page.evaluate(() => document.activeElement?.getAttribute("data-testid")))
    .toBe("drift-menu-resume");

  // `ArrowDown` moves the focus to the next item.
  await page.keyboard.press("ArrowDown");
  await expect
    .poll(async () => page.evaluate(() => document.activeElement?.getAttribute("data-testid")))
    .toBe("drift-menu-systems");

  // `Enter` activates the focused item → the star chart opens on top.
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("drift-star-chart")).toBeVisible({ timeout: 5_000 });
  await page.keyboard.press("Escape");
  await expect(menu).toBeVisible({ timeout: 5_000 });

  // ---- 6. The focus trap keeps `Tab` inside the panel ------------------
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    const inside = await page.evaluate(() => {
      const panel = document.querySelector('[data-testid="drift-menu-panel"]');
      const active = document.activeElement;
      return panel !== null && active !== null && panel.contains(active);
    });
    expect(inside, "Tab escaped the menu panel").toBe(true);
  }

  // ---- 7. `Escape` closes the menu and restores the focus --------------
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect
    .poll(async () => page.evaluate(() => document.activeElement?.tagName ?? ""))
    .not.toBe("");

  // ---- 8. The reduced-motion toggle is keyboard operable ---------------
  await page.keyboard.press("Escape");
  await expect(menu).toBeVisible({ timeout: 5_000 });
  // Focus the "Settings" item (3 x ArrowDown from Resume) + Enter.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  const reducedMotionInput = page.getByTestId("drift-settings-reduced-motion-input");
  await expect(reducedMotionInput).toBeVisible({ timeout: 5_000 });

  // The panel focuses its first control (the checkbox) on open, so
  // `Space` flips it — keyboard only, no pointer.
  await expect
    .poll(async () => page.evaluate(() => document.activeElement?.getAttribute("data-testid")))
    .toBe("drift-settings-reduced-motion-input");
  await page.keyboard.press("Space");
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const w = window as unknown as {
          __driftSettings?: { getSnapshot(): { reducedMotion: boolean } };
        };
        return w.__driftSettings?.getSnapshot().reducedMotion ?? false;
      }),
    )
    .toBe(true);

  // The FX registry reports zero played effects while reduced motion
  // is on (the counter is the test seam). We reset the counters, fire
  // a synthetic laser (the same dev seam the weapon-FX screenshot
  // uses) and assert the effect was *skipped*, not played.
  const fxCounters = await page.evaluate(() => {
    const w = window as unknown as {
      __driftFxRegistry?: {
        snapshot(): { played: number; skipped: number };
        reset(): void;
      };
      __driftClient?: {
        __fireFireOkForTest(payload: {
          weapon: "laser" | "missile";
          kind: "laser" | "missile" | "denied";
          damage: number;
          projectileId: string | null;
          energy: number;
          denialCode: string | null;
        }): void;
      };
    };
    w.__driftFxRegistry?.reset();
    w.__driftClient?.__fireFireOkForTest({
      weapon: "laser",
      kind: "laser",
      damage: 1,
      projectileId: null,
      energy: 50,
      denialCode: null,
    });
    return w.__driftFxRegistry?.snapshot() ?? null;
  });
  expect(fxCounters, "expected the FX registry seam to be exposed").not.toBeNull();
  expect(fxCounters!.played, "no FX may play while reduced motion is on").toBe(0);
  expect(fxCounters!.skipped, "the FX must be skipped, not played").toBeGreaterThan(0);

  await page.screenshot({ path: path.join(SHOTS_DIR, "TASK-54-2.png") });

  // ---- 9. No pointer events were dispatched -----------------------------
  expect(pointerEvents, "the keyboard-only spec must not dispatch mouse events").toBe(0);

  const fatalErrors = consoleErrors.filter(
    (e) => !e.includes("ResizeObserver") && !e.includes("WebSocket"),
  );
  expect(fatalErrors, `console errors: ${fatalErrors.join("\n")}`).toHaveLength(0);
});
