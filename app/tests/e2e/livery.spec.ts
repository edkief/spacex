/**
 * TASK-21 livery smoke test (now using the TASK-70 fixture).
 *
 * Verifies the end-to-end persistence + broadcast flow for ship
 * livery customization:
 *
 *   1. Claim a callsign (mint starter ship + session token).
 *   2. POST /api/ships/livery with a valid hex triple.
 *   3. GET /api/ships to confirm the colours stuck.
 *
 * The fixture spawns `npm run dev` with a random free port and
 * a fresh sqlite DB in a tmp dir, so the test is self-contained.
 */
import { test, expect } from "./fixtures.js";

const NEW_LIVERY = {
  primary: "#ff8800",
  secondary: "#222244",
  accent: "#ffff00",
};

test("livery endpoint persists paint colors end-to-end", async ({
  request,
  page,
  driftServer: server,
}) => {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  // Step 1: claim a callsign. Use a unique suffix so re-runs
  // against the same worker don't collide.
  const callsign = `LIVERY-${Date.now().toString(36).toUpperCase()}`;
  const claim = await request.post(`${server.apiURL}/api/callsigns`, {
    data: { callsign },
  });
  expect(claim.status(), `claim body: ${await claim.text()}`).toBe(200);
  const claimBody = (await claim.json()) as { token: string; playerId: string };
  expect(claimBody.token.length).toBeGreaterThan(0);

  // Step 2: set the livery.
  const paint = await request.post(`${server.apiURL}/api/ships/livery`, {
    headers: { authorization: `Bearer ${claimBody.token}` },
    data: { colors: NEW_LIVERY },
  });
  expect(paint.status()).toBe(200);
  const paintBody = (await paint.json()) as {
    ship: { livery: typeof NEW_LIVERY };
  };
  expect(paintBody.ship.livery).toEqual(NEW_LIVERY);

  // Step 3: re-read the ship row to confirm persistence.
  const get = await request.get(`${server.apiURL}/api/ships`, {
    headers: { authorization: `Bearer ${claimBody.token}` },
  });
  expect(get.status()).toBe(200);
  const getBody = (await get.json()) as {
    ship: { livery: typeof NEW_LIVERY };
  };
  expect(getBody.ship.livery).toEqual(NEW_LIVERY);

  // Also exercise an invalid-hex rejection path through the same route.
  const bad = await request.post(`${server.apiURL}/api/ships/livery`, {
    headers: { authorization: `Bearer ${claimBody.token}` },
    data: { colors: { primary: "blue", secondary: "#000000", accent: "#ffffff" } },
  });
  expect(bad.status()).toBe(400);

  // Capture a screenshot of the shell so the task log has a UI snapshot.
  await page.goto(`${server.baseURL}/`);
  await expect(page).toHaveTitle(/Drift/);
  await page.screenshot({
    path: "../.ralph/screenshots/TASK-21-1.png",
    fullPage: true,
  });

  // Fail loudly on uncaught console errors.
  expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
});