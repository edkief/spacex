/**
 * TASK-53 — ESC menu shell smoke test.
 *
 * Boots the drift app, opens the ESC menu, and asserts that:
 *
 *   - `Escape` opens the centred menu panel (Resume / Systems /
 *     Ships / Settings) with the callsign + credits footer,
 *   - the game input is suppressed while the menu is open (a
 *     weapon-select key does not change the HUD's weapon pill),
 *   - `Systems` opens the star chart (TASK-07) on top of the menu,
 *   - `Escape` pops one level at a time (chart → menu → closed),
 *   - a screenshot of the open menu lands in
 *     `.ralph/screenshots/TASK-53-1.png`.
 */
import path from "node:path";
import { test, expect } from "./fixtures.js";
import { ClaimPage } from "./pages/claim.js";

const SHOTS_DIR = path.join(process.cwd(), "..", ".ralph", "screenshots");

test("opens the ESC menu, navigates to the star chart, and pops back out", async ({
  page,
  driftServer: server,
}) => {
  // The dev server boot + the first paint take a while; give the
  // smoke test room to breathe.
  test.setTimeout(90_000);
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  const claim = new ClaimPage(page, server);
  await claim.bootAndWaitForOnline();

  // The menu is closed by default.
  await expect(page.getByTestId("drift-menu-panel")).toHaveCount(0);

  // `Escape` opens the menu.
  await page.keyboard.press("Escape");
  const menu = page.getByTestId("drift-menu-panel");
  await expect(menu).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId("drift-menu-resume")).toBeVisible();
  await expect(page.getByTestId("drift-menu-systems")).toBeVisible();
  await expect(page.getByTestId("drift-menu-ships")).toBeVisible();
  await expect(page.getByTestId("drift-menu-settings")).toBeVisible();
  await expect(page.getByTestId("drift-menu-credits")).toContainText("cr");

  await page.screenshot({ path: path.join(SHOTS_DIR, "TASK-53-1.png") });

  // The game input is suppressed while the menu is open: pressing
  // `2` (missile select) must not change the weapon readout.
  const readWeapon = async (): Promise<string | null> =>
    page.evaluate(() => {
      const w = window as unknown as {
        __driftClient?: { getWeaponState?: () => { activeWeapon: string } | null };
      };
      return w.__driftClient?.getWeaponState?.()?.activeWeapon ?? null;
    });
  const weaponBefore = await readWeapon();
  await page.keyboard.press("2");
  await page.waitForTimeout(300);
  const weaponAfter = await readWeapon();
  expect(weaponAfter).toBe(weaponBefore);

  // `Systems` opens the star chart on top of the menu.
  await page.getByTestId("drift-menu-systems").click();
  await expect(page.getByTestId("drift-star-chart")).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId("drift-menu-panel")).toHaveCount(0);

  // `Escape` pops one level: the chart closes, the menu is back.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("drift-star-chart")).toHaveCount(0);
  await expect(page.getByTestId("drift-menu-panel")).toBeVisible();

  // `Escape` pops the menu → closed.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("drift-menu-panel")).toHaveCount(0);

  const fatalErrors = consoleErrors.filter(
    (e) => !e.includes("ResizeObserver") && !e.includes("WebSocket"),
  );
  expect(fatalErrors, `console errors: ${fatalErrors.join("\n")}`).toHaveLength(0);
});
