/**
 * TASK-75 — two-context remote-entity mesh smoke.
 *
 * Follows the pattern in `presence.spec.ts`: two browser contexts
 * boot the app, claim, and are driven into one clean system. The
 * assertions here are about the renderer, not the presence list:
 *
 *   1. Each context's `window.__driftRenderHost.remoteMeshCount()`
 *      reaches >= 1 within 3 s — i.e. the other context's ship
 *      (and whatever world props the shard broadcasts) produced a
 *      pooled mesh.
 *   2. The other context's callsign is listed in each page's
 *      player list (sanity: the mesh belongs to a real peer).
 *   3. Closing context B removes its mesh from context A within
 *      2 s — the stale window (`REMOTE_STALE_MS` = 1 s) hides
 *      the impostor rather than leaving it frozen in space.
 *
 * Screenshots land in `.ralph/screenshots/TASK-75-{1,2}.png`.
 */
import { test, expect, type Page } from "./fixtures.js";
import { ClaimPage } from "./pages/claim.js";

/** Read the live pooled-remote-mesh count off the render host. */
async function remoteMeshCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __driftRenderHost?: { remoteMeshCount?: () => number };
    };
    return w.__driftRenderHost?.remoteMeshCount?.() ?? -1;
  });
}

/**
 * Point the chase camera at a live remote mesh so the screenshot
 * shows geometry rather than an empty starfield. The rig is frozen
 * (its `update` is a no-op) which is safe here: no later assertion
 * depends on the camera.
 */
async function frameRemoteMesh(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __driftRenderHost?: {
        cameraRig: { update(dt: number): void };
        camera: {
          position: { x: number; y: number; z: number };
          lookAt(x: number, y: number, z: number): void;
        };
        render(): void;
      };
      __driftRemoteEntityLayer?: {
        root: {
          children: Array<{
            visible: boolean;
            position: { x: number; y: number; z: number };
          }>;
        };
      };
    };
    const host = w.__driftRenderHost;
    const layer = w.__driftRemoteEntityLayer;
    if (host === undefined || layer === undefined) return null;
    const target = layer.root.children.find((child) => child.visible);
    if (target === undefined) return null;
    host.cameraRig.update = () => {};
    const cam = host.camera;
    cam.position.set(target.position.x + 7, target.position.y + 4, target.position.z + 7);
    cam.lookAt(target.position.x, target.position.y, target.position.z);
    host.render();
    return `${target.position.x.toFixed(1)},${target.position.y.toFixed(1)},${target.position.z.toFixed(1)}`;
  });
}

test("two clients each render the other's mesh and lose it on disconnect", async ({
  browser,
  request,
  driftServer: server,
}) => {
  // A pure-HTTP probe claim only tells us a system id to drive both
  // clients into (same trick as presence.spec.ts). The probe never
  // joins the shard, so the room starts empty.
  const probe = await request.post(`${server.apiURL}/api/callsigns`, {
    data: { callsign: `PROBE-${Date.now().toString(36)}` },
  });
  expect(probe.status()).toBe(200);
  const probeBody = (await probe.json()) as { homeSystemId: string };
  const sharedSystemId = probeBody.homeSystemId;
  expect(sharedSystemId, "expected a system id to drive both contexts into").toBeTruthy();

  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  const consoleErrorsA: string[] = [];
  const consoleErrorsB: string[] = [];
  pageA.on("console", (msg) => {
    if (msg.type() === "error") consoleErrorsA.push(msg.text());
  });
  pageB.on("console", (msg) => {
    if (msg.type() === "error") consoleErrorsB.push(msg.text());
  });

  const claimA = new ClaimPage(pageA, server);
  const claimB = new ClaimPage(pageB, server);
  await Promise.all([claimA.bootAndWaitForOnline(), claimB.bootAndWaitForOnline()]);
  await Promise.all([claimA.joinSystem(sharedSystemId!), claimB.joinSystem(sharedSystemId!)]);
  const callsignA = await claimA.currentCallsign();
  const callsignB = await claimB.currentCallsign();
  expect(callsignA).toBeTruthy();
  expect(callsignB).toBeTruthy();
  expect(callsignA).not.toBe(callsignB);

  // --- 1. each side renders at least one remote mesh.
  await expect.poll(() => remoteMeshCount(pageA), { timeout: 3_000 }).toBeGreaterThanOrEqual(1);
  await expect.poll(() => remoteMeshCount(pageB), { timeout: 3_000 }).toBeGreaterThanOrEqual(1);

  // --- 2. the peer is really there (guards against a phantom mesh).
  await expect(
    pageA.locator(`[data-testid="drift-player-list-row"][data-callsign="${callsignB}"]`),
  ).toHaveCount(1, { timeout: 10_000 });
  await expect(
    pageB.locator(`[data-testid="drift-player-list-row"][data-callsign="${callsignA}"]`),
  ).toHaveCount(1, { timeout: 10_000 });

  // Wait for the counts to settle (the shard may publish deposits /
  // terminals on top of the peer ship) so the drop assertion below
  // measures a real baseline.
  await pageA.waitForTimeout(500);
  const beforeLeave = await remoteMeshCount(pageA);
  expect(beforeLeave).toBeGreaterThanOrEqual(1);

  // Freeze the camera on a live remote so the screenshots show the
  // new geometry (an empty starfield proves nothing).
  const framedA = await frameRemoteMesh(pageA);
  expect(framedA, "expected a visible remote mesh to frame in context A").not.toBeNull();
  const framedB = await frameRemoteMesh(pageB);
  expect(framedB, "expected a visible remote mesh to frame in context B").not.toBeNull();
  await pageA.screenshot({ path: "../.ralph/screenshots/TASK-75-1.png", fullPage: true });
  await pageB.screenshot({ path: "../.ralph/screenshots/TASK-75-2.png", fullPage: true });

  // --- 3. context B leaves; A's mesh count must fall back.
  await contextB.close();
  await expect
    .poll(() => remoteMeshCount(pageA), { timeout: 2_000, intervals: [100, 200, 300] })
    .toBeLessThan(beforeLeave);

  expect(consoleErrorsA, consoleErrorsA.join("\n")).toEqual([]);
  await contextA.close();
});
