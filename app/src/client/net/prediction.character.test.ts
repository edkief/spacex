/**
 * TASK-32 character predictor tests.
 *
 * Covers:
 *   - Local input stamping + integration (no perceptible lag).
 *   - Reconciliation: blend vs rewind thresholds.
 *   - Force-snap on queue overflow.
 *   - Determinism: identical input sequences produce identical paths.
 *   - Air-control guard: horizontal velocity is preserved across
 *     a jump (the shared integrator's no-air-control rule).
 *
 * Mirrors the structure of `prediction.test.ts` so the ship and
 * character predictors stay in lock-step on the reconciliation
 * API surface.
 */

import { describe, expect, it } from "vitest";

import { IDENTITY } from "@shared/physics/vec.js";

import {
  ClientCharacterPredictor,
  MAX_BLEND_POS_U,
  MAX_QUEUED_SECONDS,
  localInputToCharacterInput,
  type CharacterPredictorLite,
} from "./prediction.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FLAT = () => 0;

function mkLite(overrides: Partial<CharacterPredictorLite> = {}): CharacterPredictorLite {
  return {
    id: "char-1",
    pos: { x: 0, y: 0, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    quat: { ...IDENTITY },
    onFoot: true,
    onPad: "pad-0",
    ...overrides,
  };
}

/** Step the predictor N times with a fixed input shape. */
function stepN(
  pred: ClientCharacterPredictor,
  count: number,
  args: {
    thrust?: number;
    turn?: number;
    pitch?: number;
    yaw?: number;
    fire?: boolean;
    action?: string | null;
    dt?: number;
  },
  startMs = 1_000,
): void {
  const dt = args.dt ?? 0.05;
  for (let i = 0; i < count; i++) {
    pred.step({
      now: startMs + i * dt * 1000,
      thrust: args.thrust ?? 0,
      turn: args.turn ?? 0,
      pitch: args.pitch ?? 0,
      yaw: args.yaw ?? 0,
      fire: args.fire ?? false,
      action: args.action ?? null,
      dt,
    });
  }
}

// ---------------------------------------------------------------------------
// Basic shape
// ---------------------------------------------------------------------------

describe("character predictor: basic shape", () => {
  it("returns a fresh CharacterLite from state() (not mutated)", () => {
    const pred = new ClientCharacterPredictor({
      serverState: mkLite({ pos: { x: 5, y: 0, z: 7 } }),
      heightAt: FLAT,
    });
    const a = pred.state();
    const c = pred.state();
    expect(a).not.toBe(c); // fresh copy each call
    expect(a.pos).not.toBe(c.pos); // nested vectors also copied
    expect(a.pos.x).toBe(5);
    expect(a.pos.z).toBe(7);
  });

  it("starts with the server's initial state (pos, vel, quat)", () => {
    const pred = new ClientCharacterPredictor({
      serverState: mkLite({
        pos: { x: 1, y: 2, z: 3 },
        vel: { x: 4, y: 5, z: 6 },
      }),
      heightAt: FLAT,
    });
    const s = pred.state();
    expect(s.pos).toEqual({ x: 1, y: 2, z: 3 });
    expect(s.vel).toEqual({ x: 4, y: 5, z: 6 });
    expect(s.quat).toEqual(IDENTITY);
    expect(s.onFoot).toBe(true);
  });

  it("serverSnapshot returns a copy of the server state", () => {
    const server = mkLite({ pos: { x: 1, y: 0, z: 0 } });
    const pred = new ClientCharacterPredictor({ serverState: server, heightAt: FLAT });
    expect(pred.serverSnapshot().pos).toEqual({ x: 1, y: 0, z: 0 });
    // Mutating the snapshot must not affect the predictor's server state.
    const snap = pred.serverSnapshot();
    snap.pos.x = 999;
    expect(pred.serverSnapshot().pos.x).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Local integration
// ---------------------------------------------------------------------------

describe("character predictor: local integration", () => {
  it("walks forward when thrust is held", () => {
    const pred = new ClientCharacterPredictor({ serverState: mkLite(), heightAt: FLAT });
    stepN(pred, 40, { thrust: 1 }); // 2 s of forward walking
    const s = pred.state();
    // After 2 s at walk speed (3 u/s), the character's z should be
    // around 6 m. The friction ramp-up costs a small fraction of
    // a metre — allow a wide tolerance.
    expect(s.pos.z).toBeGreaterThan(4);
    expect(s.pos.z).toBeLessThan(7);
    expect(s.vel.z).toBeGreaterThan(2.5);
    expect(s.vel.z).toBeLessThanOrEqual(3.05);
  });

  it("runs at 6 u/s with the run flag set", () => {
    const pred = new ClientCharacterPredictor({ serverState: mkLite(), heightAt: FLAT });
    stepN(pred, 80, { thrust: 1, fire: true });
    const s = pred.state();
    expect(s.vel.z).toBeGreaterThan(5);
    expect(s.vel.z).toBeLessThanOrEqual(6.05);
  });

  it("applies a jump on the first step", () => {
    const pred = new ClientCharacterPredictor({ serverState: mkLite(), heightAt: FLAT });
    pred.step({
      now: 1_000,
      thrust: 0,
      turn: 0,
      pitch: 0,
      yaw: 0,
      fire: false,
      action: "jump",
      dt: 0.05,
    });
    const s = pred.state();
    // After one tick the integrator should have applied the jump
    // impulse; the predicted y is non-zero.
    expect(s.pos.y).toBeGreaterThan(0);
    expect(s.vel.y).toBeGreaterThan(0);
  });

  it("stamps monotonically increasing seq on each step", () => {
    const pred = new ClientCharacterPredictor({ serverState: mkLite(), heightAt: FLAT });
    const a = pred.step({
      now: 1_000,
      thrust: 0,
      turn: 0,
      pitch: 0,
      yaw: 0,
      fire: false,
      action: null,
      dt: 0.05,
    });
    const b = pred.step({
      now: 1_050,
      thrust: 0,
      turn: 0,
      pitch: 0,
      yaw: 0,
      fire: false,
      action: null,
      dt: 0.05,
    });
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(pred.stats().nextSeq).toBe(3);
  });

  it("queues the input for delivery", () => {
    const pred = new ClientCharacterPredictor({ serverState: mkLite(), heightAt: FLAT });
    stepN(pred, 5, { thrust: 1 });
    const pending = pred.pendingInputs();
    expect(pending.length).toBe(5);
    expect(pending[0]!.seq).toBe(1);
    expect(pending[4]!.seq).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

describe("character predictor: reconciliation", () => {
  it("blends (no rewind) when divergence is within tolerance", () => {
    const pred = new ClientCharacterPredictor({ serverState: mkLite(), heightAt: FLAT });
    stepN(pred, 5, { thrust: 1 });
    const before = pred.state();
    // Apply a tiny correction (well under MAX_BLEND_POS_U).
    const correctedServer = mkLite({
      pos: { x: before.pos.x + 0.01, y: before.pos.y, z: before.pos.z },
    });
    const result = pred.reconcile({
      now: 2_000,
      serverState: correctedServer,
      lastAppliedSeq: null,
    });
    expect(result.mode).toBe("blend");
    expect(result.correctionU).toBeLessThan(MAX_BLEND_POS_U);
    expect(pred.stats().blendCount).toBe(1);
    expect(pred.stats().rewindCount).toBe(0);
  });

  it("rewinds when divergence is large", () => {
    const pred = new ClientCharacterPredictor({ serverState: mkLite(), heightAt: FLAT });
    stepN(pred, 5, { thrust: 1 });
    const correctedServer = mkLite({
      pos: { x: 100, y: 0, z: 0 }, // 100 m jump — way out of tolerance
    });
    const result = pred.reconcile({
      now: 2_000,
      serverState: correctedServer,
      lastAppliedSeq: null,
    });
    expect(result.mode).toBe("rewind");
    expect(result.correctionU).toBeGreaterThan(MAX_BLEND_POS_U);
    expect(pred.stats().rewindCount).toBe(1);
    // The predicted state should now be near the server state.
    const after = pred.state();
    expect(Math.abs(after.pos.x - 100)).toBeLessThan(0.1);
  });

  it("force-snaps when the queue overflows (age budget)", () => {
    const pred = new ClientCharacterPredictor({ serverState: mkLite(), heightAt: FLAT });
    // Fill the queue with one input then advance wall-clock by
    // more than `MAX_QUEUED_SECONDS` so the age check trips.
    pred.step({
      now: 1_000,
      thrust: 0,
      turn: 0,
      pitch: 0,
      yaw: 0,
      fire: false,
      action: null,
      dt: 0.05,
    });
    const future = 1_000 + (MAX_QUEUED_SECONDS + 1) * 1000;
    const result = pred.reconcile({
      now: future,
      serverState: mkLite({ pos: { x: 50, y: 0, z: 0 } }),
      lastAppliedSeq: null,
    });
    expect(result.mode).toBe("force-snap");
    expect(pred.stats().forceSnapCount).toBe(1);
  });

  it("drains inputs ≤ lastAppliedSeq from the queue", () => {
    const pred = new ClientCharacterPredictor({ serverState: mkLite(), heightAt: FLAT });
    stepN(pred, 10, { thrust: 1 });
    expect(pred.pendingInputs().length).toBe(10);
    pred.reconcile({
      now: 2_000,
      serverState: mkLite(),
      lastAppliedSeq: 5,
    });
    expect(pred.pendingInputs().length).toBe(5);
    expect(pred.pendingInputs()[0]!.seq).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("character predictor: determinism", () => {
  it("two identical input sequences produce identical predicted paths", () => {
    const a = new ClientCharacterPredictor({ serverState: mkLite(), heightAt: FLAT });
    const b = new ClientCharacterPredictor({ serverState: mkLite(), heightAt: FLAT });
    for (let i = 0; i < 100; i++) {
      const t = i / 20;
      const args = {
        thrust: Math.max(0, Math.sin(t)),
        turn: Math.cos(t * 0.7),
        pitch: Math.sin(t * 0.5) * 0.5,
        yaw: 0,
        fire: false,
        action: null as string | null,
        dt: 0.05,
      };
      a.step({ now: 1_000 + i * 50, ...args });
      b.step({ now: 1_000 + i * 50, ...args });
    }
    const sa = a.state();
    const sb = b.state();
    expect(sa.pos.x).toBeCloseTo(sb.pos.x, 12);
    expect(sa.pos.y).toBeCloseTo(sb.pos.y, 12);
    expect(sa.pos.z).toBeCloseTo(sb.pos.z, 12);
    expect(sa.vel.x).toBeCloseTo(sb.vel.x, 12);
    expect(sa.vel.y).toBeCloseTo(sb.vel.y, 12);
    expect(sa.vel.z).toBeCloseTo(sb.vel.z, 12);
  });
});

// ---------------------------------------------------------------------------
// Wire-input mapping
// ---------------------------------------------------------------------------

describe("character predictor: wire-input mapping", () => {
  it("maps thrust → moveZ, turn → yaw, pitch → moveX, fire → run", () => {
    const mapped = localInputToCharacterInput({
      seq: 1,
      tMs: 1_000,
      thrust: 1,
      turn: 0.5,
      pitch: -0.7,
      yaw: 0,
      fire: true,
      dt: 0.05,
      action: null,
    });
    expect(mapped.moveZ).toBe(1);
    expect(mapped.yaw).toBe(0.5);
    expect(mapped.moveX).toBe(-0.7);
    expect(mapped.run).toBe(true);
    expect(mapped.jump).toBe(false);
  });

  it("maps action='jump' to jump=true", () => {
    const mapped = localInputToCharacterInput({
      seq: 1,
      tMs: 1_000,
      thrust: 0,
      turn: 0,
      pitch: 0,
      yaw: 0,
      dt: 0.05,
      action: "jump",
    });
    expect(mapped.jump).toBe(true);
  });

  it("ignores fire=false (no run)", () => {
    const mapped = localInputToCharacterInput({
      seq: 1,
      tMs: 1_000,
      thrust: 1,
      turn: 0,
      pitch: 0,
      yaw: 0,
      fire: false,
      dt: 0.05,
      action: null,
    });
    expect(mapped.run).toBe(false);
  });

  it("fire=true maps to run=true", () => {
    const mapped = localInputToCharacterInput({
      seq: 1,
      tMs: 1_000,
      thrust: 1,
      turn: 0,
      pitch: 0,
      yaw: 0,
      fire: true,
      dt: 0.05,
      action: null,
    });
    expect(mapped.run).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Air control
// ---------------------------------------------------------------------------

describe("character predictor: no air control", () => {
  it("preserves horizontal velocity across a jump", () => {
    const pred = new ClientCharacterPredictor({
      serverState: mkLite(),
      heightAt: FLAT,
    });
    // First, ramp up to the walk speed (3 u/s).
    stepN(pred, 20, { thrust: 1 });
    const beforeJump = pred.state();
    expect(beforeJump.vel.z).toBeGreaterThan(2.5);

    // Now jump while keeping the walk input. The character should
    // remain airborne for the duration of the airtime with the
    // horizontal velocity preserved (no air control).
    let lastVelZ = beforeJump.vel.z;
    for (let i = 0; i < 10; i++) {
      pred.step({
        now: 2_000 + i * 50,
        thrust: 1, // keep walking input
        turn: 0,
        pitch: 0,
        yaw: 0,
        fire: false,
        action: "jump", // jump!
        dt: 0.05,
      });
      const s = pred.state();
      // On the first step we jump; subsequent steps the input
      // "jump: true" is just ignored (no double jump). The vel.z
      // shouldn't change unless we're on the ground.
      if (!onGroundApproximately(s)) {
        expect(s.vel.z).toBeCloseTo(lastVelZ, 5);
      }
      lastVelZ = s.vel.z;
    }
  });
});

/**
 * The wire shape doesn't carry `onGround`; the predictor keeps
 * it internal. For the air-control test we approximate "grounded"
 * by checking whether the predicted vel.y is close to 0.
 */
function onGroundApproximately(s: CharacterPredictorLite): boolean {
  return Math.abs(s.vel.y) < 0.5;
}

// ---------------------------------------------------------------------------
// Stats surface
// ---------------------------------------------------------------------------

describe("character predictor: stats", () => {
  it("starts at zero counters", () => {
    const pred = new ClientCharacterPredictor({ serverState: mkLite(), heightAt: FLAT });
    const s = pred.stats();
    expect(s.queueSize).toBe(0);
    expect(s.nextSeq).toBe(1);
    expect(s.inputsIntegrated).toBe(0);
    expect(s.reconcileCount).toBe(0);
    expect(s.rewindCount).toBe(0);
    expect(s.blendCount).toBe(0);
    expect(s.forceSnapCount).toBe(0);
    expect(s.maxCorrectionU).toBe(0);
  });

  it("increments inputsIntegrated on each step", () => {
    const pred = new ClientCharacterPredictor({ serverState: mkLite(), heightAt: FLAT });
    stepN(pred, 10, { thrust: 1 });
    expect(pred.stats().inputsIntegrated).toBe(10);
  });
});
