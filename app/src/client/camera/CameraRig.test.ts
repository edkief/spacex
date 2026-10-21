/**
 * Component tests for the `CameraRig` class (TASK-27).
 *
 * Covers the spec's "component test" acceptance criteria:
 *   - Mode switch triggers exactly ONE animation (the rig does
 *     not stack handoffs on top of each other).
 *   - Input is locked during a handoff (mouse-look is a no-op,
 *     and the current pose is driven by the precomputed path).
 *   - The 600 ms handoff duration is honoured.
 *   - A reverse handoff (onfoot → cockpit) uses the same rig
 *     and ends at the new mode's target.
 *   - The rig owns exactly one `PerspectiveCamera` for its
 *     lifetime ("never create a second camera for on-foot").
 *
 * The rig's `setMode` builds a fresh path from the current pose
 * to the new mode's target — a second `setMode` during a
 * handoff re-aims the destination (the spec's "cancellable only
 * by a second handoff" rule). The test "kickoff id" assertion
 * covers this: each `setMode` increments the kickoff counter,
 * and the live `_handoff.kickoffId` is the most recent counter.
 *
 * The test hook is exercised end-to-end in the `__testHook`
 * suite at the bottom — it runs under happy-dom so the hook
 * can install on `window`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Vector3 } from "three";

import { IDENTITY, quatFromEuler } from "@shared/physics/vec.js";

import {
  FOV_DEG,
  HANDOFF_DURATION_MS,
  ON_FOOT_BACK_OFFSET_M,
  ON_FOOT_HEIGHT_OFFSET_M,
  PITCH_MAX_RAD,
  SMOOTHING_K,
  CameraRig,
  clampPitch,
  cockpitPose,
  onFootPose,
} from "./CameraRig.js";
import {
  createCameraRigTestHook,
  installCameraRigTestHook,
  uninstallCameraRigTestHook,
} from "./testHook.js";
import type { CharacterState, ShipState } from "./types.js";

/** Build a rig with a square viewport. `aspect` is rarely exercised by the tests. */
function makeRig(opts: Partial<ConstructorParameters<typeof CameraRig>[0]> = {}): CameraRig {
  return new CameraRig({ aspect: 16 / 9, ...opts });
}

const SHIP_ORIGIN: ShipState = { pos: { x: 0, y: 0, z: 0 }, quat: IDENTITY };
const CHAR_ORIGIN: CharacterState = { pos: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0 };

describe("CameraRig — construction invariants", () => {
  it("owns exactly one PerspectiveCamera (the spec's zero-swap-risk rule)", () => {
    const rig = makeRig();
    const a = rig.perspectiveCamera;
    const b = rig.perspectiveCamera;
    expect(a).toBe(b);
    // The class never replaces the camera; we can assert the
    // identity is stable across many reads.
    for (let i = 0; i < 5; i++) {
      expect(rig.perspectiveCamera).toBe(a);
    }
  });
  it("uses the spec's pinned 75° FOV", () => {
    const rig = makeRig();
    expect(rig.perspectiveCamera.fov).toBe(FOV_DEG);
  });
  it("starts in cockpit mode with no handoff in flight", () => {
    const rig = makeRig();
    expect(rig.mode).toBe("cockpit");
    expect(rig.isHandoffInFlight).toBe(false);
    expect(rig.handoffKickoffCount).toBe(0);
    expect(rig.handoffCompletedCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// setMode / single-animation rule
// ---------------------------------------------------------------------------

describe("CameraRig.setMode — single-animation rule", () => {
  it("triggers exactly one animation on a mode change", () => {
    const rig = makeRig();
    rig.setShip(SHIP_ORIGIN);
    rig.setCharacter(CHAR_ORIGIN);
    rig.setMode("onfoot");
    expect(rig.isHandoffInFlight).toBe(true);
    expect(rig.handoffKickoffCount).toBe(1);
  });
  it("is a no-op when set to the current mode with no handoff in flight", () => {
    const rig = makeRig();
    rig.setMode("cockpit"); // already cockpit, no handoff
    expect(rig.handoffKickoffCount).toBe(0);
    expect(rig.isHandoffInFlight).toBe(false);
  });
  it("completes the handoff after 600 ms (the spec duration)", () => {
    const rig = makeRig();
    rig.setShip(SHIP_ORIGIN);
    rig.setCharacter(CHAR_ORIGIN);
    rig.setMode("onfoot");
    expect(rig.isHandoffInFlight).toBe(true);
    // Advance by the spec duration plus a small margin.
    rig.update(HANDOFF_DURATION_MS / 1000);
    expect(rig.isHandoffInFlight).toBe(false);
    expect(rig.handoffCompletedCount).toBe(1);
    expect(rig.mode).toBe("onfoot");
  });
  it("re-aims the destination on a second setMode during a handoff (cancellable only by a second handoff)", () => {
    const rig = makeRig();
    rig.setShip(SHIP_ORIGIN);
    rig.setCharacter(CHAR_ORIGIN);
    rig.setMode("onfoot");
    const firstId = rig.lastHandoffKickoffId;
    expect(rig.isHandoffInFlight).toBe(true);
    // Switch back to cockpit mid-animation.
    rig.setMode("cockpit");
    expect(rig.handoffKickoffCount).toBe(2);
    expect(rig.lastHandoffKickoffId).not.toBe(firstId);
    expect(rig.isHandoffInFlight).toBe(true);
  });
  it("the reverse handoff (onfoot → cockpit) ends at the cockpit target", () => {
    const rig = makeRig();
    rig.setShip(SHIP_ORIGIN);
    rig.setCharacter(CHAR_ORIGIN);
    // Start in cockpit, handoff to onfoot, then back.
    rig.setMode("onfoot");
    rig.update(HANDOFF_DURATION_MS / 1000);
    expect(rig.mode).toBe("onfoot");
    // Give the smoothing a moment to settle, then reverse.
    rig.update(1);
    rig.setMode("cockpit");
    expect(rig.isHandoffInFlight).toBe(true);
    rig.update(HANDOFF_DURATION_MS / 1000);
    expect(rig.mode).toBe("cockpit");
    expect(rig.isHandoffInFlight).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Smoothing
// ---------------------------------------------------------------------------

describe("CameraRig.update — smoothing toward the live target", () => {
  it("smooths the camera position toward the cockpit pose over the 100 ms time constant", () => {
    const rig = makeRig();
    rig.setShip(SHIP_ORIGIN);
    // Start at the origin; one update should move part-way toward
    // the cockpit target (0, 0.5, 1.2) with k=8, dt=0.1.
    rig.setPoseImmediate({ pos: { x: 0, y: 0, z: 0 }, lookAt: { x: 0, y: 0, z: 10 } });
    const before = rig.getCurrentPose().pos.z;
    rig.update(0.1);
    const after = rig.getCurrentPose().pos.z;
    // The smoothing factor is 1 - exp(-0.8) ≈ 0.55, so the
    // camera should have moved ~55% of the way from 0 to 1.2.
    expect(after - before).toBeCloseTo(1.2 * 0.55, 2);
  });
  it("the smoothing uses the spec's pinned rate (k=8/s)", () => {
    // We assert the same arithmetic as above but pull the rate
    // from the rig to be defensive against future tuning.
    const rig = makeRig();
    rig.setShip(SHIP_ORIGIN);
    rig.setPoseImmediate({ pos: { x: 0, y: 0, z: 0 }, lookAt: { x: 0, y: 0, z: 10 } });
    rig.update(0.1);
    const factor = 1 - Math.exp(-SMOOTHING_K * 0.1);
    const expected = 1.2 * factor;
    const actual = rig.getCurrentPose().pos.z;
    expect(actual).toBeCloseTo(expected, 6);
  });
});

// ---------------------------------------------------------------------------
// Mouse-look + input lock
// ---------------------------------------------------------------------------

describe("CameraRig.applyMouseLook — input lock during a handoff", () => {
  it("applies the mouse-look delta when no handoff is in flight", () => {
    const rig = makeRig();
    rig.setCharacter({ pos: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0 });
    rig.applyMouseLook(Math.PI / 2, 0);
    // The rig updates the internal character state. We assert
    // the side effect through the rig's `getCharacter` getter
    // so the test stays anchored to the rig's contract.
    const char = rig.getCharacter();
    expect(char).not.toBeNull();
    expect(char!.yaw).toBeCloseTo(Math.PI / 2, 10);
  });
  it("ignores the mouse-look delta during a handoff (no fight between animation and input)", () => {
    const rig = makeRig();
    rig.setShip(SHIP_ORIGIN);
    rig.setCharacter(CHAR_ORIGIN);
    // Snap to the cockpit pose so the handoff starts at a known
    // (and reproducible) point. The path then animates from the
    // cockpit pose to the on-foot pose.
    rig.setPoseImmediate(cockpitPose(SHIP_ORIGIN));
    rig.setMode("onfoot");
    const before = rig.getCurrentPose();
    // Try to apply mouse-look mid-handoff.
    rig.applyMouseLook(Math.PI, 0);
    rig.update(0.05);
    const mid = rig.getCurrentPose();
    // The pose should be on the precomputed path, NOT shifted by
    // the attempted mouse-look. The path is monotonic in z (the
    // cockpit camera is at z=1.2, the on-foot camera at z=-4);
    // if the input was honoured (yaw of π), the camera would
    // have moved sideways. The x should remain near 0.
    expect(Math.abs(mid.pos.x)).toBeLessThan(0.5);
    // The z should have moved toward the on-foot target (z=-4).
    expect(mid.pos.z).toBeLessThan(before.pos.z);
  });
  it("clamps the character's pitch to ±PITCH_MAX_RAD in setCharacter", () => {
    const rig = makeRig();
    rig.setCharacter({ pos: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 100 });
    expect(rig.getCharacter()!.pitch).toBe(PITCH_MAX_RAD);
  });
  it("clamps a negative oversized pitch in setCharacter", () => {
    const rig = makeRig();
    rig.setCharacter({ pos: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: -100 });
    expect(rig.getCharacter()!.pitch).toBe(-PITCH_MAX_RAD);
  });
  it("applyMouseLook clamps the accumulated pitch to ±PITCH_MAX_RAD", () => {
    const rig = makeRig();
    rig.setCharacter({ pos: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0 });
    // A single large delta must be clamped.
    rig.applyMouseLook(0, 10);
    expect(rig.getCharacter()!.pitch).toBe(PITCH_MAX_RAD);
    // A negative delta also clamps.
    rig.applyMouseLook(0, -20);
    expect(rig.getCharacter()!.pitch).toBe(-PITCH_MAX_RAD);
  });
});

// ---------------------------------------------------------------------------
// Handoff path correctness
// ---------------------------------------------------------------------------

describe("CameraRig — handoff path correctness", () => {
  it("the live pose at t=0 of the handoff matches the precomputed path start", () => {
    const rig = makeRig();
    rig.setShip(SHIP_ORIGIN);
    rig.setCharacter(CHAR_ORIGIN);
    // Snap the rig to the cockpit pose so the handoff starts
    // from the expected position.
    rig.setPoseImmediate(cockpitPose(SHIP_ORIGIN));
    rig.setMode("onfoot");
    rig.update(0); // dt=0 still samples the path at alpha=0
    const pose = rig.getCurrentPose();
    const expected = cockpitPose(SHIP_ORIGIN);
    expect(pose.pos.x).toBeCloseTo(expected.pos.x, 4);
    expect(pose.pos.y).toBeCloseTo(expected.pos.y, 4);
    expect(pose.pos.z).toBeCloseTo(expected.pos.z, 4);
  });
  it("the live pose at the end of the handoff matches the on-foot target", () => {
    const rig = makeRig();
    rig.setShip(SHIP_ORIGIN);
    rig.setCharacter(CHAR_ORIGIN);
    rig.setPoseImmediate(cockpitPose(SHIP_ORIGIN));
    rig.setMode("onfoot");
    rig.update(HANDOFF_DURATION_MS / 1000);
    const expected = onFootPose(CHAR_ORIGIN);
    // After the handoff the camera is at the on-foot pose
    // (±k=8 smoothing tail); we let the smoothing run a bit
    // longer so the rig has time to settle.
    rig.update(1);
    const settled = rig.getCurrentPose();
    expect(settled.pos.x).toBeCloseTo(expected.pos.x, 3);
    expect(settled.pos.y).toBeCloseTo(expected.pos.y, 3);
    expect(settled.pos.z).toBeCloseTo(expected.pos.z, 3);
  });
  it("the handoff path lifts above a hill in the terrain (collision nudge)", () => {
    const rig = makeRig({
      heightAt: () => 10, // solid floor at 10 m
      planetCenter: { x: 0, y: 0, z: 0 },
    });
    // Place the ship at y=0 and the character at y=0. The
    // handoff path would cross the floor; the nudge lifts it.
    rig.setShip({ pos: { x: 0, y: 0, z: 0 }, quat: IDENTITY });
    rig.setCharacter({ pos: { x: 0, y: 0, z: 10 }, yaw: 0, pitch: 0 });
    rig.setMode("onfoot");
    // Sample the pose at the midpoint of the handoff.
    rig.update(HANDOFF_DURATION_MS / 2000);
    const pose = rig.getCurrentPose();
    // The straight path sits at y=0; the nudge must lift it
    // above the floor (10) + clearance (1.5) = 11.5 m.
    expect(pose.pos.y).toBeGreaterThanOrEqual(11.5 - 0.01);
  });
});

// ---------------------------------------------------------------------------
// getCurrentPose / setPoseImmediate
// ---------------------------------------------------------------------------

describe("CameraRig — pose surface", () => {
  it("setPoseImmediate snaps the camera with no smoothing", () => {
    const rig = makeRig();
    rig.setPoseImmediate({
      pos: { x: 5, y: 6, z: 7 },
      lookAt: { x: 5, y: 6, z: 17 },
    });
    expect(rig.getCurrentPose().pos).toEqual({ x: 5, y: 6, z: 7 });
    expect(rig.perspectiveCamera.position).toMatchObject({ x: 5, y: 6, z: 7 });
  });
  it("getCurrentPose returns a copy (mutating the result does not affect the rig)", () => {
    const rig = makeRig();
    rig.setShip(SHIP_ORIGIN);
    rig.update(0.1);
    const pose = rig.getCurrentPose();
    pose.pos.x = 999;
    expect(rig.getCurrentPose().pos.x).not.toBe(999);
  });
  it("the rig's PerspectiveCamera position is updated every tick", () => {
    const rig = makeRig();
    rig.setShip(SHIP_ORIGIN);
    rig.update(0.05);
    const cam = rig.perspectiveCamera.position;
    // Camera should be somewhere between the origin and the
    // cockpit target (0, 0.5, 1.2). After 50 ms, the smoothing
    // factor is 1 - exp(-0.4) ≈ 0.33, so the position is
    // roughly 33% of the way.
    expect(cam.y).toBeGreaterThan(0);
    expect(cam.y).toBeLessThan(0.5);
  });
});

// ---------------------------------------------------------------------------
// Pose factories — sanity round-trip
// ---------------------------------------------------------------------------

describe("cockpitPose / onFootPose round-trip", () => {
  it("cockpit pose matches the rig's pose when the rig is in cockpit mode", () => {
    const rig = makeRig();
    rig.setShip(SHIP_ORIGIN);
    rig.update(10); // plenty of time to settle
    const expected = cockpitPose(SHIP_ORIGIN);
    const actual = rig.getCurrentPose();
    expect(actual.pos.x).toBeCloseTo(expected.pos.x, 4);
    expect(actual.pos.y).toBeCloseTo(expected.pos.y, 4);
    expect(actual.pos.z).toBeCloseTo(expected.pos.z, 4);
  });
  it("onFoot pose matches the rig's pose when the rig is in onfoot mode", () => {
    const rig = makeRig();
    rig.setShip(SHIP_ORIGIN);
    rig.setCharacter(CHAR_ORIGIN);
    rig.setMode("onfoot");
    rig.update(HANDOFF_DURATION_MS / 1000);
    rig.update(10); // settle
    const expected = onFootPose(CHAR_ORIGIN);
    const actual = rig.getCurrentPose();
    expect(actual.pos.x).toBeCloseTo(expected.pos.x, 3);
    expect(actual.pos.y).toBeCloseTo(expected.pos.y, 3);
    expect(actual.pos.z).toBeCloseTo(expected.pos.z, 3);
  });
  it("onFoot camera sits 4 m behind + 1.6 m up for a north-facing character", () => {
    const pose = onFootPose(CHAR_ORIGIN);
    expect(pose.pos.x).toBe(0);
    expect(pose.pos.y).toBe(ON_FOOT_HEIGHT_OFFSET_M);
    expect(pose.pos.z).toBe(-ON_FOOT_BACK_OFFSET_M);
  });
  it("cockpit camera sits 1.2 m forward + 0.5 m up of the ship origin", () => {
    const pose = cockpitPose(SHIP_ORIGIN);
    expect(pose.pos.x).toBe(0);
    expect(pose.pos.y).toBe(0.5);
    expect(pose.pos.z).toBe(1.2);
  });
});

// ---------------------------------------------------------------------------
// Vector3 sanity (imported to verify the three.js adapter is wired)
// ---------------------------------------------------------------------------

describe("three.js import sanity", () => {
  it("Vector3 is a real three.js class (smoke check for the camera adapter)", () => {
    const v = new Vector3(1, 2, 3);
    expect(v.x).toBe(1);
    expect(v.y).toBe(2);
    expect(v.z).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Test hook — drives the rig with a fake ship/character
// ---------------------------------------------------------------------------

describe("testHook (TASK-27 acceptance — exposed test hook)", () => {
  beforeEach(() => {
    uninstallCameraRigTestHook();
  });
  afterEach(() => {
    uninstallCameraRigTestHook();
  });

  it("installCameraRigTestHook attaches the hook to window.__driftCameraRig", () => {
    const rig = makeRig();
    const hook = installCameraRigTestHook(rig);
    expect(hook).toBeDefined();
    expect((globalThis as { __driftCameraRig?: unknown }).__driftCameraRig).toBe(hook);
  });
  it("createCameraRigTestHook mirrors the rig's public state (mode, handoff flags, position)", () => {
    const rig = makeRig();
    rig.setShip(SHIP_ORIGIN);
    rig.setCharacter(CHAR_ORIGIN);
    const hook = createCameraRigTestHook(rig);
    expect(hook.mode()).toBe("cockpit");
    expect(hook.isHandoffInFlight()).toBe(false);
    expect(hook.handoffKickoffCount()).toBe(0);
    hook.setMode("onfoot");
    expect(hook.isHandoffInFlight()).toBe(true);
    expect(hook.handoffKickoffCount()).toBe(1);
    // The rig commits to the destination mode at setMode time
    // so the post-handoff smoothing can read the right target.
    expect(hook.mode()).toBe("onfoot");
    hook.tick(HANDOFF_DURATION_MS / 1000);
    expect(hook.isHandoffInFlight()).toBe(false);
    expect(hook.handoffCompletedCount()).toBe(1);
    expect(hook.mode()).toBe("onfoot");
  });
  it("the hook's tick advances the rig and updates the camera position", () => {
    const rig = makeRig();
    rig.setShip(SHIP_ORIGIN);
    const hook = createCameraRigTestHook(rig);
    hook.snapPose({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 10 });
    hook.tick(0.1);
    const pos = hook.cameraPosition();
    expect(pos.x).toBe(0);
    expect(pos.y).toBeGreaterThan(0);
    expect(pos.z).toBeGreaterThan(0);
  });
  it("the hook's snapPose bypasses smoothing (used to seed the first frame)", () => {
    const rig = makeRig();
    const hook = createCameraRigTestHook(rig);
    hook.snapPose({ x: 7, y: 8, z: 9 }, { x: 7, y: 8, z: 19 });
    expect(hook.cameraPosition()).toMatchObject({ x: 7, y: 8, z: 9 });
  });
  it("uninstallCameraRigTestHook removes the global (idempotent)", () => {
    const rig = makeRig();
    installCameraRigTestHook(rig);
    uninstallCameraRigTestHook();
    uninstallCameraRigTestHook();
    expect((globalThis as { __driftCameraRig?: unknown }).__driftCameraRig).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// clampPitch re-exported
// ---------------------------------------------------------------------------

describe("clampPitch re-export from the rig module", () => {
  it("matches the cameraMath clampPitch", () => {
    expect(clampPitch(Math.PI)).toBeCloseTo(PITCH_MAX_RAD, 10);
  });
});

// ---------------------------------------------------------------------------
// Tick boundary — what happens at the start and end of the handoff
// ---------------------------------------------------------------------------

describe("CameraRig — handoff boundary conditions", () => {
  it("a sub-frame handoff (e.g. dt > duration) still completes in one update", () => {
    const rig = makeRig();
    rig.setShip(SHIP_ORIGIN);
    rig.setCharacter(CHAR_ORIGIN);
    rig.setMode("onfoot");
    // One update with dt = 10x the duration.
    rig.update((HANDOFF_DURATION_MS / 1000) * 10);
    expect(rig.isHandoffInFlight).toBe(false);
    expect(rig.handoffCompletedCount).toBe(1);
  });
  it("the rig is in the destination mode immediately after a sub-frame handoff", () => {
    const rig = makeRig();
    rig.setShip(SHIP_ORIGIN);
    rig.setCharacter(CHAR_ORIGIN);
    rig.setMode("onfoot");
    rig.update(10);
    expect(rig.mode).toBe("onfoot");
  });
  it("a dt=0 update does not advance the handoff (deterministic), but the camera still reflects the path at alpha=0", () => {
    const rig = makeRig();
    rig.setShip(SHIP_ORIGIN);
    rig.setCharacter(CHAR_ORIGIN);
    rig.setPoseImmediate(cockpitPose(SHIP_ORIGIN));
    rig.setMode("onfoot");
    rig.update(0);
    expect(rig.isHandoffInFlight).toBe(true);
    expect(rig.handoffCompletedCount).toBe(0);
    // The pose is still the start of the path.
    const pose = rig.getCurrentPose();
    const expected = cockpitPose(SHIP_ORIGIN);
    expect(pose.pos.z).toBeCloseTo(expected.pos.z, 4);
  });
});

// ---------------------------------------------------------------------------
// Ship rotation — the cockpit follows the ship quat
// ---------------------------------------------------------------------------

describe("CameraRig — TASK-74 external mode (chase camera)", () => {
  it("can be constructed already in 'external' mode", () => {
    const rig = makeRig({ initialMode: "external" });
    expect(rig.mode).toBe("external");
  });
  it("external mode pulls the ship into the chase pose", () => {
    const rig = makeRig({ initialMode: "external" });
    rig.setShip(SHIP_ORIGIN);
    rig.setPoseImmediate({ pos: { x: 0, y: 0, z: 0 }, lookAt: { x: 0, y: 0, z: 12 } });
    rig.update(1); // settle smoothing
    const pose = rig.getCurrentPose();
    // chase pose: 8 m back along -Z + 3 m up.
    expect(pose.pos.z).toBeCloseTo(-8, 1);
    expect(pose.pos.y).toBeCloseTo(3, 1);
  });
  it("external → onfoot triggers a handoff (single-animation rule)", () => {
    const rig = makeRig({ initialMode: "external" });
    rig.setShip(SHIP_ORIGIN);
    rig.setCharacter(CHAR_ORIGIN);
    rig.setMode("onfoot");
    expect(rig.isHandoffInFlight).toBe(true);
    rig.update(HANDOFF_DURATION_MS / 1000);
    expect(rig.mode).toBe("onfoot");
  });
});

describe("CameraRig — cockpit follows the ship quat", () => {
  it("a 90° yaw rotates the cockpit pose 90° in world space", () => {
    const rig = makeRig();
    rig.setShip({ pos: { x: 0, y: 0, z: 0 }, quat: quatFromEuler(Math.PI / 2, 0, 0) });
    rig.update(10); // settle
    const pose = rig.getCurrentPose();
    // 90° yaw: forward = +X, so the cockpit sits 1.2 m along +X
    // and the camera looks at +X.
    expect(pose.pos.x).toBeCloseTo(1.2, 3);
    expect(pose.pos.z).toBeCloseTo(0, 3);
  });
});

// Suppress an "unused" lint for the harness's three.js import — Vector3
// is exercised by the `three.js import sanity` test above.
void Vector3;
