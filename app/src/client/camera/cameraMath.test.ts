/**
 * Unit tests for the pure-math camera helpers (TASK-27).
 *
 * Covers the spec's required unit cases:
 *   - Pose lerp math (`lerpPose`, end-to-end start/mid/end).
 *   - Pitch clamp (`clampPitch`, with NaN guard).
 *   - Collision-nudge path (analytic terrain, the spec calls
 *     out "sample 5 points against heightAt").
 *   - 600 ms handoff duration constant (the spec pins it).
 *   - Smoothing factor (`expSmoothFactor`) gives the 100 ms
 *     "feel" for k=8 and dt=0.1.
 *
 * All tests run under Node (no three.js, no DOM). The math is
 * pure data so the suite can stay environment-agnostic.
 */

import { describe, expect, it } from "vitest";

import {
  COCKPIT_OFFSET_M,
  FOV_DEG,
  HANDOFF_DURATION_MS,
  HANDOFF_PATH_SAMPLES,
  ON_FOOT_BACK_OFFSET_M,
  ON_FOOT_HEIGHT_OFFSET_M,
  ON_FOOT_LOOK_AHEAD_M,
  PITCH_MAX_DEG,
  PITCH_MAX_RAD,
  SMOOTHING_K,
  TERRAIN_CLEARANCE_M,
  clampPitch,
  cockpitPose,
  collisionNudge,
  easeInOutCubic,
  expSmoothFactor,
  lerpPose,
  onFootPose,
  targetPoseFor,
} from "./cameraMath.js";
import { buildHandoffPath, lookQuatsFromPoses, sampleHandoffPath } from "./handoffPath.js";
import { IDENTITY, quatFromEuler, quatRotateVector } from "@shared/physics/vec.js";

import type {
  CameraPose,
  CharacterState,
  HeightAtFn,
  QuatLike,
  ShipState,
  Vec3Like,
} from "./types.js";

// ---------------------------------------------------------------------------
// Constants — the spec pins every one of these.
// ---------------------------------------------------------------------------

describe("camera constants", () => {
  it("FOV is 75 degrees (spec constant for v1)", () => {
    expect(FOV_DEG).toBe(75);
  });
  it("handoff duration is 600 ms (spec acceptance criterion)", () => {
    expect(HANDOFF_DURATION_MS).toBe(600);
  });
  it("handoff samples is 5 (spec acceptance criterion)", () => {
    expect(HANDOFF_PATH_SAMPLES).toBe(5);
  });
  it("smoothing rate k=8/s (spec constant — gives the 100 ms feel)", () => {
    expect(SMOOTHING_K).toBe(8);
  });
  it("pitch clamp is ±80 degrees (spec constant)", () => {
    expect(PITCH_MAX_DEG).toBe(80);
    // 80° in radians = ~1.3963
    expect(PITCH_MAX_RAD).toBeCloseTo((80 * Math.PI) / 180, 10);
  });
  it("cockpit offset is 0.5 m up, 1.2 m forward", () => {
    expect(COCKPIT_OFFSET_M).toEqual({ x: 0, y: 0.5, z: 1.2 });
  });
  it("on-foot camera is 4 m behind, 1.6 m up (spec)", () => {
    expect(ON_FOOT_BACK_OFFSET_M).toBe(4);
    expect(ON_FOOT_HEIGHT_OFFSET_M).toBe(1.6);
  });
  it("on-foot look-ahead is 5 m (matches the cockpit look-ahead scale)", () => {
    expect(ON_FOOT_LOOK_AHEAD_M).toBe(5);
  });
  it("terrain clearance is 1.5 m (a comfortable ground margin)", () => {
    expect(TERRAIN_CLEARANCE_M).toBe(1.5);
  });
});

// ---------------------------------------------------------------------------
// clampPitch
// ---------------------------------------------------------------------------

describe("clampPitch", () => {
  it("clamps a positive pitch to +PITCH_MAX_RAD", () => {
    expect(clampPitch(Math.PI)).toBeCloseTo(PITCH_MAX_RAD, 10);
  });
  it("clamps a negative pitch to -PITCH_MAX_RAD", () => {
    expect(clampPitch(-Math.PI)).toBeCloseTo(-PITCH_MAX_RAD, 10);
  });
  it("leaves an in-range pitch untouched", () => {
    expect(clampPitch(0.25)).toBe(0.25);
    expect(clampPitch(-0.5)).toBe(-0.5);
    expect(clampPitch(0)).toBe(0);
  });
  it("coerces NaN to 0 (defensive guard against a faulty input source)", () => {
    expect(clampPitch(Number.NaN)).toBe(0);
  });
  it("coerces Infinity to PITCH_MAX_RAD (still finite-clamped)", () => {
    expect(clampPitch(Number.POSITIVE_INFINITY)).toBe(PITCH_MAX_RAD);
    expect(clampPitch(Number.NEGATIVE_INFINITY)).toBe(-PITCH_MAX_RAD);
  });
});

// ---------------------------------------------------------------------------
// cockpitPose
// ---------------------------------------------------------------------------

describe("cockpitPose", () => {
  it("places the camera at ship.pos + quat * (0, 0.5, 1.2) for identity quat", () => {
    const ship: ShipState = { pos: { x: 10, y: 0, z: 0 }, quat: IDENTITY };
    const pose = cockpitPose(ship);
    expect(pose.pos).toEqual({ x: 10, y: 0.5, z: 1.2 });
  });
  it("look-at sits 10 m in the +Z direction (ship forward) for identity quat", () => {
    const ship: ShipState = { pos: { x: 0, y: 0, z: 0 }, quat: IDENTITY };
    const pose = cockpitPose(ship);
    expect(pose.lookAt.x).toBeCloseTo(0, 10);
    expect(pose.lookAt.y).toBeCloseTo(0.5, 10);
    expect(pose.lookAt.z).toBeCloseTo(1.2 + 10, 10);
  });
  it("rotates the cockpit offset with the ship quat (yaw 90° → +X forward)", () => {
    const ship: ShipState = { pos: { x: 0, y: 0, z: 0 }, quat: quatFromEuler(Math.PI / 2, 0, 0) };
    const pose = cockpitPose(ship);
    // 90° yaw: forward = +X, up = +Y. Cockpit offset (0, 0.5, 1.2) becomes (1.2, 0.5, 0).
    expect(pose.pos.x).toBeCloseTo(1.2, 10);
    expect(pose.pos.y).toBeCloseTo(0.5, 10);
    expect(pose.pos.z).toBeCloseTo(0, 10);
    // Look-at 10 m further along the rotated +Z (=+X).
    expect(pose.lookAt.x).toBeCloseTo(1.2 + 10, 9);
    expect(pose.lookAt.z).toBeCloseTo(0, 9);
  });
  it("returns a non-NaN pose even with an all-zero quat (defensive)", () => {
    const ship: ShipState = { pos: { x: 5, y: 5, z: 5 }, quat: { x: 0, y: 0, z: 0, w: 0 } };
    const pose = cockpitPose(ship);
    // All-zero quat is treated as identity by the helper functions.
    expect(pose.pos.x).toBeGreaterThan(0);
    expect(pose.lookAt.z).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// onFootPose
// ---------------------------------------------------------------------------

describe("onFootPose", () => {
  it("places the camera 4 m behind + 1.6 m up for identity look (yaw 0, pitch 0)", () => {
    const character: CharacterState = { pos: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0 };
    const pose = onFootPose(character);
    // Forward = +Z → camera is 4 m back (z = -4), 1.6 m up.
    expect(pose.pos).toEqual({ x: 0, y: 1.6, z: -4 });
  });
  it("look-at is 5 m in front of the character (along forward)", () => {
    const character: CharacterState = { pos: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0 };
    const pose = onFootPose(character);
    expect(pose.lookAt).toEqual({ x: 0, y: 0, z: 5 });
  });
  it("clamps the pitch defensively (NaN → 0 forward, no skyward snap)", () => {
    const character: CharacterState = { pos: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: Number.NaN };
    const pose = onFootPose(character);
    expect(pose.lookAt).toEqual({ x: 0, y: 0, z: 5 });
  });
  it("follows yaw 180° (character faces -Z → camera in +Z)", () => {
    const character: CharacterState = { pos: { x: 0, y: 0, z: 0 }, yaw: Math.PI, pitch: 0 };
    const pose = onFootPose(character);
    expect(pose.pos.x).toBeCloseTo(0, 10);
    expect(pose.pos.z).toBeCloseTo(4, 10);
    expect(pose.lookAt.z).toBeCloseTo(-5, 10);
  });
  it("lifts the look-at when the pitch is positive (look up)", () => {
    const character: CharacterState = {
      pos: { x: 0, y: 0, z: 0 },
      yaw: 0,
      pitch: Math.PI / 4, // 45°
    };
    const pose = onFootPose(character);
    // The look direction is rotated upward; y of look-at > 0.
    expect(pose.lookAt.y).toBeGreaterThan(0);
    // Camera position is still on the world Y axis (the rig uses
    // world up for the camera height, not the look direction).
    expect(pose.pos.x).toBeCloseTo(0, 10);
    expect(pose.pos.y).toBe(1.6);
    // Camera is still "behind" the character (closer to the
    // character than ON_FOOT_BACK_OFFSET_M because the look
    // direction has tilted upward; the camera is closer on z).
    expect(pose.pos.z).toBeLessThan(0);
    expect(pose.pos.z).toBeGreaterThan(-ON_FOOT_BACK_OFFSET_M);
  });
  it("clamps the pitch before computing the look direction", () => {
    const character: CharacterState = {
      pos: { x: 0, y: 0, z: 0 },
      yaw: 0,
      pitch: 100, // way past +80°
    };
    const pose = onFootPose(character);
    // The pitch clamp applies to the character's look direction,
    // so the angle from the CHARACTER (not the camera) to the
    // look-at point must equal PITCH_MAX_RAD.
    const dy = pose.lookAt.y - character.pos.y;
    const dz = pose.lookAt.z - character.pos.z;
    const angle = Math.atan2(dy, Math.abs(dz));
    expect(angle).toBeCloseTo(PITCH_MAX_RAD, 6);
  });
});

// ---------------------------------------------------------------------------
// targetPoseFor
// ---------------------------------------------------------------------------

describe("targetPoseFor", () => {
  it("returns the cockpit pose in cockpit mode", () => {
    const ship: ShipState = { pos: { x: 1, y: 2, z: 3 }, quat: IDENTITY };
    const pose = targetPoseFor("cockpit", ship, null);
    expect(pose).toEqual(cockpitPose(ship));
  });
  it("returns the on-foot pose in onfoot mode", () => {
    const character: CharacterState = { pos: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0 };
    const pose = targetPoseFor("onfoot", null, character);
    expect(pose).toEqual(onFootPose(character));
  });
  it("returns null when the mode's required state is null", () => {
    expect(targetPoseFor("cockpit", null, null)).toBeNull();
    expect(targetPoseFor("onfoot", null, null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// lerpPose
// ---------------------------------------------------------------------------

describe("lerpPose", () => {
  const a: CameraPose = {
    pos: { x: 0, y: 0, z: 0 },
    lookAt: { x: 0, y: 0, z: 1 },
  };
  const b: CameraPose = {
    pos: { x: 10, y: 20, z: 30 },
    lookAt: { x: 0, y: 0, z: 11 },
  };

  it("returns a exactly at t=0", () => {
    const pose = lerpPose(a, b, 0);
    expect(pose.pos).toEqual(a.pos);
    expect(pose.lookAt).toEqual(a.lookAt);
  });
  it("returns b exactly at t=1", () => {
    const pose = lerpPose(a, b, 1);
    expect(pose.pos).toEqual(b.pos);
    expect(pose.lookAt).toEqual(b.lookAt);
  });
  it("returns the midpoint at t=0.5 (component-wise)", () => {
    const pose = lerpPose(a, b, 0.5);
    expect(pose.pos).toEqual({ x: 5, y: 10, z: 15 });
    expect(pose.lookAt).toEqual({ x: 0, y: 0, z: 6 });
  });
  it("does not alias the input poses (mutate the output, inputs unchanged)", () => {
    const pose = lerpPose(a, b, 0.5);
    pose.pos.x = 999;
    expect(a.pos.x).toBe(0);
    expect(b.pos.x).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// expSmoothFactor — the 100 ms feel
// ---------------------------------------------------------------------------

describe("expSmoothFactor", () => {
  it("returns 0 for dt=0 (no time, no progress)", () => {
    expect(expSmoothFactor(SMOOTHING_K, 0)).toBe(0);
  });
  it("returns ~0.55 for k=8 and dt=0.1 s (the 100 ms feel)", () => {
    // 1 - exp(-8 * 0.1) = 1 - exp(-0.8) ≈ 0.5507
    expect(expSmoothFactor(SMOOTHING_K, 0.1)).toBeCloseTo(1 - Math.exp(-0.8), 10);
    expect(expSmoothFactor(SMOOTHING_K, 0.1)).toBeCloseTo(0.5507, 3);
  });
  it("approaches 1 as dt grows large (full catch-up)", () => {
    expect(expSmoothFactor(SMOOTHING_K, 10)).toBeCloseTo(1, 6);
  });
  it("clamps NaN/Infinity dt to 0 (defensive guard)", () => {
    expect(expSmoothFactor(SMOOTHING_K, Number.NaN)).toBe(0);
    expect(expSmoothFactor(SMOOTHING_K, Number.POSITIVE_INFINITY)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// easeInOutCubic
// ---------------------------------------------------------------------------

describe("easeInOutCubic", () => {
  it("f(0) = 0 (smooth start)", () => {
    expect(easeInOutCubic(0)).toBe(0);
  });
  it("f(1) = 1 (smooth end)", () => {
    expect(easeInOutCubic(1)).toBe(1);
  });
  it("f(0.5) = 0.5 (symmetric midpoint)", () => {
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 10);
  });
  it("clamps t<0 to 0", () => {
    expect(easeInOutCubic(-0.5)).toBe(0);
  });
  it("clamps t>1 to 1", () => {
    expect(easeInOutCubic(1.5)).toBe(1);
  });
  it("has zero derivative at the endpoints (no jerk)", () => {
    // Sample a few values around the endpoints and check the
    // slope is near zero.
    const eps = 0.01;
    const f0 = easeInOutCubic(0);
    const fEps = easeInOutCubic(eps);
    expect(fEps - f0).toBeLessThan(eps * 0.05); // ~ 3e-3 * eps
    const f1 = easeInOutCubic(1);
    const f1mEps = easeInOutCubic(1 - eps);
    expect(f1 - f1mEps).toBeLessThan(eps * 0.05);
  });
});

// ---------------------------------------------------------------------------
// collisionNudge — analytic terrain
// ---------------------------------------------------------------------------

describe("collisionNudge", () => {
  it("returns 0 when no heightAt is provided (assumes flat / no terrain)", () => {
    const from: Vec3Like = { x: 0, y: 5, z: 0 };
    const to: Vec3Like = { x: 0, y: 5, z: 10 };
    const lift = collisionNudge(from, to, undefined, null, TERRAIN_CLEARANCE_M, 5);
    expect(lift).toBe(0);
  });
  it("returns 0 when the path is already well above flat terrain (y=0)", () => {
    const from: Vec3Like = { x: 0, y: 10, z: 0 };
    const to: Vec3Like = { x: 0, y: 10, z: 10 };
    const heightAt: HeightAtFn = () => 0;
    const lift = collisionNudge(from, to, heightAt, null, TERRAIN_CLEARANCE_M, 5);
    expect(lift).toBe(0);
  });
  it("lifts the path to clear a hill at the midpoint (analytic terrain)", () => {
    // The handoff starts at (0, 2, 0) and ends at (0, 2, 20).
    // A triangular hill is centred at z=10 with a 10 m peak
    // (the peak is at z=10, terrain=0 at z=5 and z=15).
    // With 5 samples the rig hits z=4, 8, 12, 16 — the highest
    // sampled terrain is 6 (at z=8 or z=12, halfway up the
    // triangle). Path y is 2 throughout. Lift = 6 + 1.5 - 2 = 5.5.
    const from: Vec3Like = { x: 0, y: 2, z: 0 };
    const to: Vec3Like = { x: 0, y: 2, z: 20 };
    const heightAt: HeightAtFn = (_x: number, z: number) => {
      // Triangular hill centred at z=10, peak 10 m, base from z=5 to z=15.
      const t = Math.abs(z - 10) / 5;
      return Math.max(0, 10 * (1 - t));
    };
    const lift = collisionNudge(from, to, heightAt, null, TERRAIN_CLEARANCE_M, 5);
    // Sample at i=2 (t=0.4, z=8): terrain = 10 * (1 - 0.4) = 6.
    // Lift = (0 + 6 + 1.5) - 2 = 5.5.
    expect(lift).toBeCloseTo(5.5, 5);
  });
  it("lifts relative to a non-zero planet centre (the world Y of the floor)", () => {
    // Planet centre at y=100; terrain heightAt is a flat 0 (so
    // the world Y of the floor is 100). Camera handoff at y=100
    // sits 0 m above the floor; with a 1.5 m clearance it needs
    // a 1.5 m lift.
    const from: Vec3Like = { x: 0, y: 100, z: 0 };
    const to: Vec3Like = { x: 0, y: 100, z: 10 };
    const heightAt: HeightAtFn = () => 0;
    const planetCenter: Vec3Like = { x: 0, y: 100, z: 0 };
    const lift = collisionNudge(from, to, heightAt, planetCenter, TERRAIN_CLEARANCE_M, 5);
    expect(lift).toBeCloseTo(TERRAIN_CLEARANCE_M, 5);
  });
  it("takes the max lift across all 5 samples (a spike at the endpoint lifts the whole path)", () => {
    const from: Vec3Like = { x: 0, y: 5, z: 0 };
    const to: Vec3Like = { x: 0, y: 5, z: 20 };
    const heightAt: HeightAtFn = (_x: number, z: number) => (z > 15 ? 20 : 0);
    // At t=1, z=20, terrain=20, path y=5 → lift = (0+20+1.5)-5 = 16.5.
    // At t=0, z=0, terrain=0, path y=5 → lift = (0+0+1.5)-5 = -3.5 → max stays 16.5.
    const lift = collisionNudge(from, to, heightAt, null, TERRAIN_CLEARANCE_M, 5);
    expect(lift).toBeCloseTo(16.5, 5);
  });
  it("is monotonic in clearance (more clearance → more lift)", () => {
    const from: Vec3Like = { x: 0, y: 0, z: 0 };
    const to: Vec3Like = { x: 0, y: 0, z: 10 };
    const heightAt: HeightAtFn = (_x: number, z: number) => (z > 4 && z < 6 ? 5 : 0);
    const a = collisionNudge(from, to, heightAt, null, 1, 5);
    const b = collisionNudge(from, to, heightAt, null, 5, 5);
    expect(b).toBeGreaterThan(a);
  });
});

// ---------------------------------------------------------------------------
// buildHandoffPath + sampleHandoffPath
// ---------------------------------------------------------------------------

describe("buildHandoffPath", () => {
  const from: CameraPose = {
    pos: { x: 0, y: 0, z: 0 },
    lookAt: { x: 0, y: 0, z: 10 },
  };
  const to: CameraPose = {
    pos: { x: 0, y: 0, z: 10 },
    lookAt: { x: 0, y: 0, z: 20 },
  };

  it("produces N+1 samples (5 samples by default → 6 vertices)", () => {
    const path = buildHandoffPath(
      from,
      to,
      IDENTITY as QuatLike,
      IDENTITY as QuatLike,
      undefined,
      null,
      TERRAIN_CLEARANCE_M,
      HANDOFF_PATH_SAMPLES,
      HANDOFF_DURATION_MS,
    );
    expect(path.positions.length).toBe(HANDOFF_PATH_SAMPLES + 1);
    expect(path.lookAts.length).toBe(HANDOFF_PATH_SAMPLES + 1);
  });
  it("starts at `from` and ends at `to` (the un-nudged endpoints)", () => {
    const path = buildHandoffPath(
      from,
      to,
      IDENTITY as QuatLike,
      IDENTITY as QuatLike,
      undefined,
      null,
      TERRAIN_CLEARANCE_M,
      HANDOFF_PATH_SAMPLES,
      HANDOFF_DURATION_MS,
    );
    expect(path.positions[0]).toEqual(from.pos);
    expect(path.positions[path.positions.length - 1]).toEqual(to.pos);
  });
  it("stamps the handoff duration", () => {
    const path = buildHandoffPath(
      from,
      to,
      IDENTITY as QuatLike,
      IDENTITY as QuatLike,
      undefined,
      null,
      TERRAIN_CLEARANCE_M,
      HANDOFF_PATH_SAMPLES,
      HANDOFF_DURATION_MS,
    );
    expect(path.durationMs).toBe(HANDOFF_DURATION_MS);
  });
  it("applies the lift uniformly to every position (the entire path rises together)", () => {
    const fromBelow: CameraPose = { pos: { x: 0, y: 0, z: 0 }, lookAt: { x: 0, y: 0, z: 10 } };
    const toBelow: CameraPose = { pos: { x: 0, y: 0, z: 10 }, lookAt: { x: 0, y: 0, z: 20 } };
    const heightAt: HeightAtFn = (_x: number, _z: number) => 50; // solid floor at 50 m
    const path = buildHandoffPath(
      fromBelow,
      toBelow,
      IDENTITY as QuatLike,
      IDENTITY as QuatLike,
      heightAt,
      null,
      TERRAIN_CLEARANCE_M,
      HANDOFF_PATH_SAMPLES,
      HANDOFF_DURATION_MS,
    );
    // Every sample must clear terrainY (50) + clearance (1.5) = 51.5.
    for (const p of path.positions) {
      expect(p.y).toBeGreaterThanOrEqual(50 + TERRAIN_CLEARANCE_M - 1e-6);
    }
    // The recorded `lift` matches the difference between the
    // path's y and the un-nudged lerp.
    expect(path.lift).toBeGreaterThan(0);
    // First and last samples have the same y because the from
    // and to poses share y=0; the lift is added uniformly.
    expect(path.positions[0]!.y).toBeCloseTo(path.lift, 6);
    expect(path.positions[path.positions.length - 1]!.y).toBeCloseTo(path.lift, 6);
  });
});

describe("sampleHandoffPath", () => {
  const from: CameraPose = {
    pos: { x: 0, y: 0, z: 0 },
    lookAt: { x: 0, y: 0, z: 10 },
  };
  const to: CameraPose = {
    pos: { x: 0, y: 0, z: 10 },
    lookAt: { x: 0, y: 0, z: 20 },
  };

  function makePath(): ReturnType<typeof buildHandoffPath> {
    return buildHandoffPath(
      from,
      to,
      IDENTITY as QuatLike,
      IDENTITY as QuatLike,
      undefined,
      null,
      TERRAIN_CLEARANCE_M,
      HANDOFF_PATH_SAMPLES,
      HANDOFF_DURATION_MS,
    );
  }

  it("t=0 returns the first sample exactly", () => {
    const path = makePath();
    const pose = sampleHandoffPath(path, 0);
    expect(pose.pos).toEqual(path.positions[0]);
  });
  it("t=1 returns the last sample exactly", () => {
    const path = makePath();
    const pose = sampleHandoffPath(path, 1);
    expect(pose.pos).toEqual(path.positions[path.positions.length - 1]);
  });
  it("t=0.5 (after easing) lands in the middle of the path (between samples 2 and 3)", () => {
    const path = makePath();
    const pose = sampleHandoffPath(path, 0.5);
    // For a 5-sample path, eased(0.5) = 0.5, so we sample the
    // midpoint of the path's third segment (index 2-3).
    const mid = (path.positions[2]!.z + path.positions[3]!.z) / 2;
    expect(pose.pos.z).toBeCloseTo(mid, 6);
  });
  it("clamps t<0 to the start and t>1 to the end (no runaway samples)", () => {
    const path = makePath();
    expect(sampleHandoffPath(path, -1).pos).toEqual(path.positions[0]);
    expect(sampleHandoffPath(path, 2).pos).toEqual(path.positions[path.positions.length - 1]);
  });
});

// ---------------------------------------------------------------------------
// lookQuatsFromPoses — the slerp input for the handoff
// ---------------------------------------------------------------------------

describe("lookQuatsFromPoses", () => {
  it("produces a look quaternion that rotates +Z to the pose's forward", () => {
    const pose: CameraPose = {
      pos: { x: 0, y: 0, z: 0 },
      lookAt: { x: 1, y: 0, z: 0 }, // look in +X
    };
    const { from } = lookQuatsFromPoses(pose, pose);
    const rotated = quatRotateVector(from, { x: 0, y: 0, z: 1 });
    expect(rotated.x).toBeCloseTo(1, 6);
    expect(rotated.y).toBeCloseTo(0, 6);
    expect(rotated.z).toBeCloseTo(0, 6);
  });
  it("round-trips a +Y look (look up)", () => {
    const pose: CameraPose = {
      pos: { x: 0, y: 0, z: 0 },
      lookAt: { x: 0, y: 1, z: 0 },
    };
    const { from } = lookQuatsFromPoses(pose, pose);
    const rotated = quatRotateVector(from, { x: 0, y: 0, z: 1 });
    // The atan2(1, 0) = π/2 case is exactly +Y, so the rotated
    // forward should be (0, 1, 0).
    expect(rotated.x).toBeCloseTo(0, 6);
    expect(rotated.y).toBeCloseTo(1, 6);
    expect(rotated.z).toBeCloseTo(0, 6);
  });
});
