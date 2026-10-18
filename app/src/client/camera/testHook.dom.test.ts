/**
 * Dev-only test hook (TASK-27) — happy-dom smoke.
 *
 * The test hook installs a `window.__driftCameraRig` global for
 * the e2e smoke to drive the rig from Playwright. The hook
 * itself runs under Node for the component tests, but the e2e
 * drives it from a real browser context. This file proves the
 * hook survives the browser's `window` object: we install the
 * hook in a happy-dom environment, exercise the public surface,
 * and tear it down on completion.
 *
 * Why a separate file?
 *   - happy-dom is only loaded for files that opt in via the
 *     `@vitest-environment happy-dom` pragma. Keeping this test
 *     out of `CameraRig.test.ts` (Node) means the rest of the
 *     rig suite stays three.js-free and runs in < 1 s.
 *
 * @see ./testHook.ts          — the hook itself.
 * @see ./CameraRig.test.ts    — the Node-side component tests.
 */

// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { IDENTITY } from "@shared/physics/vec.js";

import { HANDOFF_DURATION_MS, CameraRig } from "./CameraRig.js";
import { installCameraRigTestHook, uninstallCameraRigTestHook } from "./testHook.js";
import type { CharacterState, ShipState } from "./types.js";

const SHIP: ShipState = { pos: { x: 0, y: 0, z: 0 }, quat: IDENTITY };
const CHAR: CharacterState = { pos: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0 };

describe("testHook — happy-dom (browser-shape) integration", () => {
  afterEach(() => {
    uninstallCameraRigTestHook();
  });

  it("installs the hook on the browser's window object", () => {
    const rig = new CameraRig({ aspect: 16 / 9 });
    const hook = installCameraRigTestHook(rig);
    expect((globalThis as unknown as { __driftCameraRig?: unknown }).__driftCameraRig).toBe(hook);
    expect(hook.mode()).toBe("cockpit");
    expect(hook.isHandoffInFlight()).toBe(false);
  });
  it("the hook drives a full cockpit → onfoot → cockpit cycle in the browser-shape env", () => {
    const rig = new CameraRig({ aspect: 16 / 9 });
    rig.setShip(SHIP);
    rig.setCharacter(CHAR);
    const hook = installCameraRigTestHook(rig);
    // cockpit → onfoot
    hook.setMode("onfoot");
    expect(hook.isHandoffInFlight()).toBe(true);
    hook.tick(HANDOFF_DURATION_MS / 1000);
    expect(hook.isHandoffInFlight()).toBe(false);
    expect(hook.handoffCompletedCount()).toBe(1);
    // Settle the smoothing tail.
    hook.tick(1);
    const onfootPos = hook.cameraPosition();
    expect(onfootPos.y).toBeCloseTo(1.6, 2);
    expect(onfootPos.z).toBeCloseTo(-4, 2);
    // onfoot → cockpit (reverse handoff)
    hook.setMode("cockpit");
    expect(hook.isHandoffInFlight()).toBe(true);
    hook.tick(HANDOFF_DURATION_MS / 1000);
    hook.tick(1);
    const cockpitPos = hook.cameraPosition();
    expect(cockpitPos.y).toBeCloseTo(0.5, 2);
    expect(cockpitPos.z).toBeCloseTo(1.2, 2);
  });
  it("uninstalling the hook removes the global (re-installable)", () => {
    const rig = new CameraRig({ aspect: 16 / 9 });
    installCameraRigTestHook(rig);
    uninstallCameraRigTestHook();
    expect(
      (globalThis as unknown as { __driftCameraRig?: unknown }).__driftCameraRig,
    ).toBeUndefined();
    // Re-install with a fresh rig.
    const rig2 = new CameraRig({ aspect: 16 / 9 });
    const hook2 = installCameraRigTestHook(rig2);
    expect((globalThis as unknown as { __driftCameraRig?: unknown }).__driftCameraRig).toBe(hook2);
  });
});
