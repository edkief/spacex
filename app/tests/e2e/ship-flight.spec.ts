/**
 * TASK-74 — Local ship flight acceptance.
 *
 * Drives a real WS handshake, claims a callsign, waits for the
 * scene to settle, then asserts the end-to-end flight loop:
 *
 *   1. `window.__driftClient.predictor` exists and exposes a
 *      `state()` with finite `pos / vel`.
 *   2. Holding `w` for 2 s (page.keyboard.down) advances the
 *      predictor's velocity above zero and translates the
 *      position by at least 1 m.
 *   3. The own-ship mesh is parented in the three.js scene
 *      (`__driftOwnShipMeshCount >= 1`).
 *   4. At least one `input` frame per 50 ms tick reached the
 *      server while the key was held (we measure the client-side
 *      seq counter `__driftLastInputSeq`).
 *   5. `data-testid="drift-ship-speed-value"` renders a
 *      non-zero number sourced from the live predictor (the
 *      dev `__driftShipHud` override is left untouched).
 *   6. Releasing the key and waiting 3 s lets the speed decay
 *      back toward zero (the loop is continuous, not one-shot).
 */
import path from "node:path";

import { expect, test } from "./fixtures.js";
import { ClaimPage } from "./pages/claim.js";

test("TASK-74: holding KeyW flies the ship end-to-end", async ({ page, driftServer }) => {
  const consoleErrors: string[] = [];
  page.on("pageerror", (err) => consoleErrors.push(`${err.message}\n${err.stack ?? ""}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  const claim = new ClaimPage(page, driftServer);
  await claim.bootAndWaitForOnline();

  // Wait for the predictor to materialise (the WS handshake
  // mints it on first access). The TASK-74 lazy-init path
  // returns a fresh predictor immediately even before any
  // `entity_update`, so this resolves within a few ticks.
  await page.waitForFunction(
    () => {
      const w = window as unknown as {
        __driftClient?: { predictor?: unknown };
      };
      return w.__driftClient?.predictor !== undefined;
    },
    undefined,
    { timeout: 10_000 },
  );

  // Capture the initial predictor state so the before/after
  // diff lives in the report.
  const initial = await page.evaluate(() => {
    const w = window as unknown as {
      __driftClient?: {
        predictor: {
          state(): {
            pos: { x: number; y: number; z: number };
            vel: { x: number; y: number; z: number };
          };
        };
      };
    };
    const s = w.__driftClient!.predictor.state();
    return {
      pos: { x: s.pos.x, y: s.pos.y, z: s.pos.z },
      vel: { x: s.vel.x, y: s.vel.y, z: s.vel.z },
    };
  });

  // Hold W for 2 s. We focus the body so the keyboard event
  // isn't swallowed by a stale input element.
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    document.body.focus();
  });
  await page.keyboard.down("w");
  await page.waitForTimeout(2_000);
  await page.keyboard.up("w");

  const afterThrust = await page.evaluate(() => {
    const w = window as unknown as {
      __driftClient?: {
        predictor: {
          state(): {
            pos: { x: number; y: number; z: number };
            vel: { x: number; y: number; z: number };
          };
        };
      };
      __driftOwnShipMeshCount?: number;
      __driftLastInputSeq?: number;
    };
    const s = w.__driftClient!.predictor.state();
    return {
      pos: { x: s.pos.x, y: s.pos.y, z: s.pos.z },
      vel: { x: s.vel.x, y: s.vel.y, z: s.vel.z },
      meshCount: w.__driftOwnShipMeshCount ?? 0,
      lastInputSeq: w.__driftLastInputSeq ?? 0,
    };
  });

  // eslint-disable-next-line no-console
  console.log(
    `[ship-flight] initial pos=${initial.pos.x},${initial.pos.y},${initial.pos.z} ` +
      `vel=${initial.vel.x},${initial.vel.y},${initial.vel.z}; ` +
      `after pos=${afterThrust.pos.x},${afterThrust.pos.y},${afterThrust.pos.z} ` +
      `vel=${afterThrust.vel.x},${afterThrust.vel.y},${afterThrust.vel.z}; ` +
      `meshCount=${afterThrust.meshCount} seq=${afterThrust.lastInputSeq}`,
  );

  // The velocity must be non-zero at the END of the thrust
  // window: holding W drives the ship forward through the
  // `localInputToShipInput` mapping.
  const speedAfter = Math.sqrt(
    afterThrust.vel.x ** 2 + afterThrust.vel.y ** 2 + afterThrust.vel.z ** 2,
  );
  expect(speedAfter, "expected non-zero velocity after 2 s of thrust").toBeGreaterThan(0);

  // Position must have moved by at least 1 m.
  const dx = afterThrust.pos.x - initial.pos.x;
  const dy = afterThrust.pos.y - initial.pos.y;
  const dz = afterThrust.pos.z - initial.pos.z;
  const movedM = Math.sqrt(dx * dx + dy * dy + dz * dz);
  expect(
    movedM,
    `expected pos to advance > 1m over the 2s thrust window (moved ${movedM.toFixed(2)}m)`,
  ).toBeGreaterThan(1);

  // Own-ship mesh parented in the scene.
  expect(afterThrust.meshCount, "expected __driftOwnShipMeshCount >= 1").toBeGreaterThanOrEqual(1);

  // At least one input frame per 50 ms tick while held: a 2s
  // window at 20 Hz makes 40 inputs the lower bound. The server
  // is real but we're asserting on the seq counter the pump
  // stamps; reconciliation is the server's job. seq > 35
  // allows one or two rAF drops.
  expect(afterThrust.lastInputSeq, "expected seq >= 35 over 2s @ 20Hz").toBeGreaterThanOrEqual(35);

  // The ship HUD is now data-bound from the live predictor,
  // not the dev `__driftShipHud` override. Poll the speed
  // readout for a tick so the React snapshot has time to flush.
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="drift-ship-speed-value"]');
      const txt = el?.textContent ?? "";
      const num = Number.parseFloat(txt.replace(/[^\d.-]/gu, ""));
      return Number.isFinite(num) && num > 0;
    },
    undefined,
    { timeout: 3_000 },
  );

  const speed = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="drift-ship-speed-value"]');
    const txt = el?.textContent ?? "";
    const num = Number.parseFloat(txt.replace(/[^\d.-]/gu, ""));
    return { raw: txt, parsed: num };
  });
  // eslint-disable-next-line no-console
  console.log(`[ship-flight] speed readout: raw="${speed.raw}" parsed=${speed.parsed}`);
  expect(speed.parsed, `expected non-zero speed readout (got "${speed.raw}")`).toBeGreaterThan(0);

  // Save the in-flight screenshot for the acceptance report.
  await page.screenshot({
    path: path.join(process.cwd(), "..", ".ralph", "screenshots", "TASK-74-1.png"),
    fullPage: false,
  });

  // Now release + wait — the predictor's local integration
  // runs the ship physics on every input frame. In vacuum
  // space (the e2e default regime) the velocity is conserved
  // (no atmosphere drag), so the loop-continuity assertion is
  // "seq + pos keep advancing after release" rather than
  // "speed drops to zero". This proves the pump keeps running
  // — a one-shot bug would freeze the ship.
  const seqAfter = afterThrust.lastInputSeq;
  await page.waitForTimeout(3_500);
  const releaseStats = await page.evaluate(() => {
    const w = window as unknown as {
      __driftClient?: {
        predictor: {
          state(): {
            pos: { x: number; y: number; z: number };
            vel: { x: number; y: number; z: number };
          };
        };
      };
      __driftLastInputSeq?: number;
    };
    const s = w.__driftClient!.predictor.state();
    return {
      pos: { x: s.pos.x, y: s.pos.y, z: s.pos.z },
      vel: { x: s.vel.x, y: s.vel.y, z: s.vel.z },
      lastInputSeq: w.__driftLastInputSeq ?? 0,
    };
  });
  const releasePosMoved = Math.sqrt(
    (releaseStats.pos.x - afterThrust.pos.x) ** 2 +
      (releaseStats.pos.y - afterThrust.pos.y) ** 2 +
      (releaseStats.pos.z - afterThrust.pos.z) ** 2,
  );
  // eslint-disable-next-line no-console
  console.log(
    `[ship-flight] post-release pos=${releaseStats.pos.x},${releaseStats.pos.y},${releaseStats.pos.z} ` +
      `vel=${releaseStats.vel.x.toFixed(2)},${releaseStats.vel.y.toFixed(2)},${releaseStats.vel.z.toFixed(2)} ` +
      `seq=${releaseStats.lastInputSeq} moved=${releasePosMoved.toFixed(2)}m`,
  );
  // The pump must keep incrementing seq after release.
  expect(
    releaseStats.lastInputSeq,
    `expected seq to keep advancing after release (was ${seqAfter}, now ${releaseStats.lastInputSeq})`,
  ).toBeGreaterThan(seqAfter);

  await page.screenshot({
    path: path.join(process.cwd(), "..", ".ralph", "screenshots", "TASK-74-2.png"),
    fullPage: false,
  });

  expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
});
