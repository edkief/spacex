/**
 * TASK-14 prediction + reconciliation tests.
 *
 * Covers:
 *   - Local input stamping + integration (no perceptible lag).
 *   - Reconciliation: blend vs rewind thresholds.
 *   - Force-snap on queue overflow + 0.1 s blend overlay.
 *   - Remote interpolation buffer (200 ms delay, lerp/slerp).
 *   - Buffer underrun → freeze, no teleport.
 *   - Stale-entity dimming (>1 s without snapshot).
 *   - End-to-end with 150 ms simulated RTT + constant thrust.
 */

import { describe, expect, it } from "vitest";

import type { ProtocolEntityState } from "@shared/protocol/index.js";
import { integrateShip, type ShipState } from "@shared/physics/flight.js";
import { SHIP_CLASSES } from "@shared/ships.js";

import {
  ClientShipPredictor,
  FORCE_SNAP_BLEND_MS,
  INTERP_DELAY_MS,
  MAX_BLEND_ANGLE_RAD,
  MAX_BLEND_POS_U,
  MAX_QUEUED_INPUTS,
  MAX_QUEUED_SECONDS,
  REMOTE_BUFFER_CAPACITY,
  REMOTE_STALE_MS,
  RemoteEntityBuffer,
  applyEntityUpdateToBuffer,
  localInputToShipInput,
  simEntityFromWire,
  type LocalInput,
  type SimEntityLite,
} from "./prediction.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal `SimEntityLite` for tests. */
function mkLite(overrides: Partial<SimEntityLite> = {}): SimEntityLite {
  return {
    id: "e-1",
    pos: { x: 0, y: 0, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    quat: { x: 0, y: 0, z: 0, w: 1 },
    regime: "space",
    hull: 100,
    shields: 50,
    onPad: null,
    ...overrides,
  };
}

/** Convert a `SimEntityLite` to a wire-shape `EntityState`. */
function liteToWire(l: SimEntityLite): ProtocolEntityState {
  return {
    id: l.id,
    kind: "ship",
    pos: [l.pos.x, l.pos.y, l.pos.z],
    vel: [l.vel.x, l.vel.y, l.vel.z],
    regime: l.regime,
    hull: l.hull,
    shields: l.shields,
    targetId: null,
    classId: "scout",
    callsign: null,
    livery: null,
    // TASK-29: pad id is part of the wire shape. Forwarded from
    // the lite entity so the predictor can reconcile dock state.
    onPad: l.onPad,
  };
}

function mkScoutClass() {
  return SHIP_CLASSES.scout;
}

// ---------------------------------------------------------------------------
// localInputToShipInput
// ---------------------------------------------------------------------------

describe("localInputToShipInput", () => {
  it("clamps thrust to [0, 1]", () => {
    expect(
      localInputToShipInput({ seq: 1, tMs: 0, thrust: -1, turn: 0, pitch: 0, yaw: 0, dt: 0.05 })
        .thrust,
    ).toBe(0);
    expect(
      localInputToShipInput({ seq: 1, tMs: 0, thrust: 2, turn: 0, pitch: 0, yaw: 0, dt: 0.05 })
        .thrust,
    ).toBe(1);
    expect(
      localInputToShipInput({ seq: 1, tMs: 0, thrust: 0.5, turn: 0, pitch: 0, yaw: 0, dt: 0.05 })
        .thrust,
    ).toBe(0.5);
  });

  it("clamps rotation axes to [-1, 1]", () => {
    expect(
      localInputToShipInput({ seq: 1, tMs: 0, thrust: 0, turn: -2, pitch: 0, yaw: 0, dt: 0.05 })
        .yaw,
    ).toBe(-1);
    expect(
      localInputToShipInput({ seq: 1, tMs: 0, thrust: 0, turn: 0, pitch: 2, yaw: 0, dt: 0.05 })
        .pitch,
    ).toBe(1);
    expect(
      localInputToShipInput({ seq: 1, tMs: 0, thrust: 0, turn: 0, pitch: 0, yaw: 0.5, dt: 0.05 })
        .roll,
    ).toBe(0.5);
  });

  it("maps turn → yaw and yaw → roll", () => {
    const out = localInputToShipInput({
      seq: 1,
      tMs: 0,
      thrust: 0,
      turn: 0.7,
      pitch: -0.3,
      yaw: 0.4,
      dt: 0.05,
    });
    expect(out.yaw).toBe(0.7);
    expect(out.pitch).toBe(-0.3);
    expect(out.roll).toBe(0.4);
    expect(out.up).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ClientShipPredictor: basic step
// ---------------------------------------------------------------------------

describe("ClientShipPredictor: step", () => {
  it("integrates immediately so the renderer sees zero lag", () => {
    const predictor = new ClientShipPredictor({
      serverState: mkLite({ id: "e-local" }),
      classId: "scout",
    });
    // One step at thrust=1, dt=0.05 should move the predicted state
    // forward — same formula the server uses (`integrateShip`).
    const input = predictor.step({ now: 0, thrust: 1, turn: 0, pitch: 0, yaw: 0, dt: 0.05 });
    expect(input.seq).toBe(1);
    expect(predictor.state().pos.z).toBeGreaterThan(0);
  });

  it("matches the server's integrator output bit-for-bit", () => {
    // Reference: hand-roll the same step on a fresh `ShipState` and
    // confirm the predictor's result matches to within rounding.
    const initial = mkLite({ id: "e-local" });
    const predictor = new ClientShipPredictor({ serverState: initial, classId: "scout" });

    const shipClass = mkScoutClass();
    const inputs: LocalInput[] = [];
    let now = 0;
    for (let i = 0; i < 20; i++) {
      inputs.push(predictor.step({ now, thrust: 0.5, turn: 0.1, pitch: 0, yaw: 0, dt: 0.0166 }));
      now += 16.6;
    }

    // Re-run the same inputs through `integrateShip` directly.
    let state: ShipState = {
      pos: { ...initial.pos },
      vel: { ...initial.vel },
      quat: { ...initial.quat },
      regime: "space",
      onPad: undefined,
    };
    for (const input of inputs) {
      state = integrateShip(state, localInputToShipInput(input), input.dt, "space", shipClass);
    }

    const predicted = predictor.state();
    expect(predicted.pos.x).toBeCloseTo(state.pos.x, 6);
    expect(predicted.pos.y).toBeCloseTo(state.pos.y, 6);
    expect(predicted.pos.z).toBeCloseTo(state.pos.z, 6);
    expect(predicted.vel.x).toBeCloseTo(state.vel.x, 6);
    expect(predicted.vel.y).toBeCloseTo(state.vel.y, 6);
    expect(predicted.vel.z).toBeCloseTo(state.vel.z, 6);
  });

  it("queues inputs for delivery to the server", () => {
    const predictor = new ClientShipPredictor({ serverState: mkLite(), classId: "scout" });
    predictor.step({ now: 0, thrust: 1, turn: 0, pitch: 0, yaw: 0, dt: 0.05 });
    predictor.step({ now: 16, thrust: 1, turn: 0, pitch: 0, yaw: 0, dt: 0.05 });
    predictor.step({ now: 32, thrust: 1, turn: 0, pitch: 0, yaw: 0, dt: 0.05 });
    const pending = predictor.pendingInputs();
    expect(pending.map((p) => p.seq)).toEqual([1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// ClientShipPredictor: reconcile
// ---------------------------------------------------------------------------

describe("ClientShipPredictor: reconcile", () => {
  it("blends within tolerance (no visible snap)", () => {
    const predictor = new ClientShipPredictor({ serverState: mkLite(), classId: "scout" });
    predictor.step({ now: 0, thrust: 1, turn: 0, pitch: 0, yaw: 0, dt: 0.0166 });
    predictor.step({ now: 16, thrust: 1, turn: 0, pitch: 0, yaw: 0, dt: 0.0166 });

    // Server says we're at a position only 0.5 u away from our
    // predicted position — well within MAX_BLEND_POS_U.
    const predicted = predictor.state();
    const serverState = mkLite({
      pos: { x: predicted.pos.x + 0.5, y: predicted.pos.y, z: predicted.pos.z },
    });
    const result = predictor.reconcile({ now: 32, serverState, lastAppliedSeq: null });
    expect(result.mode).toBe("blend");
    expect(predictor.stats().rewindCount).toBe(0);
  });

  it("rewinds when the discrepancy exceeds the blend threshold", () => {
    const predictor = new ClientShipPredictor({ serverState: mkLite(), classId: "scout" });
    predictor.step({ now: 0, thrust: 1, turn: 0, pitch: 0, yaw: 0, dt: 0.0166 });
    predictor.step({ now: 16, thrust: 1, turn: 0, pitch: 0, yaw: 0, dt: 0.0166 });

    // Server says we're MAX_BLEND_POS_U + 1 u away → rewind.
    const predicted = predictor.state();
    const serverState = mkLite({
      pos: {
        x: predicted.pos.x + MAX_BLEND_POS_U + 1,
        y: predicted.pos.y,
        z: predicted.pos.z,
      },
    });
    const result = predictor.reconcile({ now: 32, serverState, lastAppliedSeq: null });
    expect(result.mode).toBe("rewind");
    expect(predictor.stats().rewindCount).toBe(1);
  });

  it("drains the input queue when lastAppliedSeq is provided", () => {
    const predictor = new ClientShipPredictor({ serverState: mkLite(), classId: "scout" });
    predictor.step({ now: 0, thrust: 1, turn: 0, pitch: 0, yaw: 0, dt: 0.0166 });
    predictor.step({ now: 16, thrust: 1, turn: 0, pitch: 0, yaw: 0, dt: 0.0166 });
    predictor.step({ now: 32, thrust: 1, turn: 0, pitch: 0, yaw: 0, dt: 0.0166 });
    expect(predictor.pendingInputs().length).toBe(3);

    // Server says it applied seq=2 → drop 1 and 2 from the queue.
    predictor.reconcile({ now: 48, serverState: mkLite(), lastAppliedSeq: 2 });
    const remaining = predictor.pendingInputs().map((p) => p.seq);
    expect(remaining).toEqual([3]);
  });

  it("tracks max correction distance / angle in stats", () => {
    const predictor = new ClientShipPredictor({ serverState: mkLite(), classId: "scout" });
    predictor.step({ now: 0, thrust: 1, turn: 0, pitch: 0, yaw: 0, dt: 0.0166 });
    const predicted = predictor.state();
    predictor.reconcile({
      now: 16,
      serverState: mkLite({ pos: { x: predicted.pos.x + 3, y: 0, z: 0 } }),
      lastAppliedSeq: null,
    });
    const stats = predictor.stats();
    expect(stats.maxCorrectionU).toBeCloseTo(3, 4);
    expect(stats.maxCorrectionRad).toBeGreaterThanOrEqual(0);
  });

  it("force-snaps after queue age overflow (> MAX_QUEUED_SECONDS)", () => {
    const predictor = new ClientShipPredictor({ serverState: mkLite(), classId: "scout" });
    // Single input pushed at t=0; advance the wall clock past the
    // 10 s budget so the queue looks stale.
    predictor.step({ now: 0, thrust: 1, turn: 0, pitch: 0, yaw: 0, dt: 0.0166 });
    const staleNow = (MAX_QUEUED_SECONDS + 1) * 1000;
    // Far-off server state — would normally rewind, but the queue
    // is over the time budget → force-snap with a blend overlay.
    const serverState = mkLite({ pos: { x: 100, y: 0, z: 0 } });
    const result = predictor.reconcile({ now: staleNow, serverState, lastAppliedSeq: null });
    expect(result.mode).toBe("force-snap");
    expect(predictor.stats().forceSnapCount).toBe(1);
    // Queue is now empty.
    expect(predictor.pendingInputs().length).toBe(0);
  });

  it("trimQueue caps the in-memory queue at MAX_QUEUED_INPUTS", () => {
    const predictor = new ClientShipPredictor({ serverState: mkLite(), classId: "scout" });
    // Push more inputs than the cap. trimQueue() should drop the
    // oldest so the queue never grows unbounded.
    let now = 0;
    for (let i = 0; i < MAX_QUEUED_INPUTS + 10; i++) {
      predictor.step({ now, thrust: 0.5, turn: 0, pitch: 0, yaw: 0, dt: 0.05 });
      now += 50;
    }
    expect(predictor.pendingInputs().length).toBe(MAX_QUEUED_INPUTS);
    // The remaining entries are the most recent (oldest dropped).
    const seqs = predictor.pendingInputs().map((p) => p.seq);
    expect(seqs[0]).toBe(11);
    expect(seqs[seqs.length - 1]).toBe(MAX_QUEUED_INPUTS + 10);
  });

  it("blend overlay moves the visible state over FORCE_SNAP_BLEND_MS", () => {
    const predictor = new ClientShipPredictor({
      serverState: mkLite({ pos: { x: 0, y: 0, z: 0 } }),
      classId: "scout",
    });
    // Force-snap to a far-off position.
    predictor.forceSnap(0, mkLite({ pos: { x: 100, y: 0, z: 0 } }));
    // First step at t=0 — applyBlend sees elapsed=0 and holds the from-pos.
    predictor.step({ now: 0, thrust: 0, turn: 0, pitch: 0, yaw: 0, dt: 0.0166 });
    const t0 = predictor.state().pos.x;
    expect(t0).toBeCloseTo(0, 1); // blend just started; we hold the from-pos

    // Step a frame later — blend is still in progress (no extra
    // integration since no input changes).
    predictor.step({
      now: FORCE_SNAP_BLEND_MS / 2,
      thrust: 0,
      turn: 0,
      pitch: 0,
      yaw: 0,
      dt: 0.0166,
    });
    const t1 = predictor.state().pos.x;
    expect(t1).toBeGreaterThan(0);
    expect(t1).toBeLessThan(100);

    // After FORCE_SNAP_BLEND_MS the blend completes.
    predictor.step({
      now: FORCE_SNAP_BLEND_MS + 1,
      thrust: 0,
      turn: 0,
      pitch: 0,
      yaw: 0,
      dt: 0.0166,
    });
    const t2 = predictor.state().pos.x;
    expect(t2).toBeCloseTo(100, 1);
  });
});

// ---------------------------------------------------------------------------
// ClientShipPredictor: 150 ms RTT + constant thrust (acceptance test)
// ---------------------------------------------------------------------------

describe("ClientShipPredictor: 150 ms RTT + constant thrust (acceptance)", () => {
  it("max correction < 5 u after the first 2 s (no sustained rubber-banding)", () => {
    const predictor = new ClientShipPredictor({
      serverState: mkLite({ id: "e-local" }),
      classId: "scout",
    });

    // Simulated local render: 60 Hz, constant thrust=1, no turn.
    const renderHz = 60;
    const renderDt = 1 / renderHz;
    let renderNow = 0;
    let frame = 0;

    // Simulated server: 10 Hz snapshot, 150 ms RTT. The server runs
    // its own `integrateShip` at fixed dt = 1/20 s (TASK-13).
    const snapshotHz = 10;
    const rttMs = 150;

    const shipClass = mkScoutClass();

    // Server-side state mirror (so we know what to send back).
    let serverState = mkLite({ id: "e-local" });
    const serverInputs: LocalInput[] = [];

    const maxCorrectionAfter2S: number[] = [];

    while (renderNow < 3000) {
      // Local prediction.
      predictor.step({ now: renderNow, thrust: 1, turn: 0, pitch: 0, yaw: 0, dt: renderDt });

      // Server side: integrate any inputs the client has flushed so far.
      // The "send to server" latency is half-RTT; flush only inputs
      // older than (renderNow - rttMs/2).
      const flushCutoff = renderNow - rttMs / 2;
      while (serverInputs.length > 0 && serverInputs[0]!.tMs < flushCutoff) {
        const input = serverInputs.shift()!;
        serverState = {
          ...serverState,
          ...simEntityFromWire(liteToWire(serverState)), // ensure same shape
        };
        // Drive the server's integrator manually.
        const next = integrateShip(
          {
            pos: { ...serverState.pos },
            vel: { ...serverState.vel },
            quat: { ...serverState.quat },
            regime: "space",
          },
          localInputToShipInput(input),
          input.dt,
          "space",
          shipClass,
        );
        serverState = { ...serverState, pos: next.pos, vel: next.vel, quat: next.quat };
      }

      // Snapshot at 10 Hz with 150 ms RTT.
      if (frame % Math.round(renderHz / snapshotHz) === 0) {
        // Snapshot arrives `rttMs` after the server saw the inputs.
        const arriveAt = renderNow + rttMs / 2;
        const ackSeq = serverInputs.length > 0 ? serverInputs[serverInputs.length - 1]!.seq : 0;
        const result = predictor.reconcile({
          now: arriveAt,
          serverState,
          lastAppliedSeq: ackSeq,
        });
        // Track corrections only AFTER the first 2 s.
        if (renderNow >= 2000) {
          maxCorrectionAfter2S.push(result.correctionU);
        }
      }

      // Capture this frame's input so the server sees it later.
      const lastInput = predictor.pendingInputs().slice(-1)[0];
      if (lastInput !== undefined) {
        // The pendingInputs() is the *unacked* queue; for a clean
        // server simulation we want every input.
        const allInputs = predictor.stats().inputsIntegrated;
        // Server inputs are tracked separately.
        if (serverInputs.length < allInputs) {
          // The pendingInputs() above already returned what we want;
          // we just take the newest.
          serverInputs.push({
            seq: lastInput.seq,
            tMs: renderNow,
            thrust: lastInput.thrust,
            turn: lastInput.turn,
            pitch: lastInput.pitch,
            yaw: lastInput.yaw,
            dt: lastInput.dt,
          });
        }
      }

      renderNow += renderDt * 1000;
      frame += 1;
    }

    // Acceptance: every correction event after the first 2 s must be
    // < 5 u. Zero sustained rubber-banding.
    expect(maxCorrectionAfter2S.length).toBeGreaterThan(0);
    for (const corr of maxCorrectionAfter2S) {
      expect(corr).toBeLessThan(MAX_BLEND_POS_U);
    }
    // And the rolling max observed by the predictor should also be
    // under the threshold.
    expect(predictor.stats().maxCorrectionU).toBeLessThan(MAX_BLEND_POS_U);
  });
});

// ---------------------------------------------------------------------------
// RemoteEntityBuffer
// ---------------------------------------------------------------------------

describe("RemoteEntityBuffer", () => {
  it("lerps position at now - INTERP_DELAY_MS", () => {
    const buf = new RemoteEntityBuffer();
    buf.push(0, mkLite({ pos: { x: 0, y: 0, z: 0 } }));
    buf.push(100, mkLite({ pos: { x: 100, y: 0, z: 0 } }));
    // Render at t=200, INTERP_DELAY_MS=200 → look at t=0; the
    // bracket is the two surrounding entries.
    // Wait: render at now=300 → target = 300 - 200 = 100 → exact match.
    let r = buf.sample(300);
    expect(r.state?.pos.x).toBeCloseTo(100, 6);
    // Render at now=250 → target = 50 → halfway between 0 and 100.
    r = buf.sample(250);
    expect(r.state?.pos.x).toBeCloseTo(50, 6);
    // Render at now=200 → target = 0 → exact match for the oldest.
    r = buf.sample(200);
    expect(r.state?.pos.x).toBeCloseTo(0, 6);
  });

  it("slerps rotation between snapshots", () => {
    const buf = new RemoteEntityBuffer();
    const id = { x: 0, y: 0, z: 0, w: 1 };
    const half = { x: 0, y: Math.sin(Math.PI / 8), z: 0, w: Math.cos(Math.PI / 8) };
    const full = { x: 0, y: Math.sin(Math.PI / 4), z: 0, w: Math.cos(Math.PI / 4) };
    buf.push(0, mkLite({ quat: id }));
    buf.push(100, mkLite({ quat: full }));
    // Render at t=150 → target = -50 → underrun (oldest is at t=0).
    const r = buf.sample(150);
    expect(r.state).not.toBeNull();
    expect(r.stale).toBe(true); // underrun → stale
    // Render at t=300 → target = 100 → exact match.
    const r2 = buf.sample(300);
    expect(r2.state?.quat.w).toBeCloseTo(full.w, 6);
    // Render at t=250 → target = 50 → halfway.
    const r3 = buf.sample(250);
    expect(r3.state?.quat.w).toBeCloseTo(half.w, 6);
  });

  it("underruns return the oldest snapshot without teleporting", () => {
    const buf = new RemoteEntityBuffer();
    buf.push(1000, mkLite({ pos: { x: 50, y: 0, z: 0 } }));
    buf.push(1100, mkLite({ pos: { x: 60, y: 0, z: 0 } }));
    // Render at t=1100 → target = 900, which precedes the oldest
    // snapshot (1000). Return oldest, stale=true.
    const r = buf.sample(1100);
    expect(r.stale).toBe(true);
    expect(r.state?.pos.x).toBe(50);
  });

  it("clamps to newest snapshot for forward render times", () => {
    const buf = new RemoteEntityBuffer();
    buf.push(0, mkLite({ pos: { x: 0, y: 0, z: 0 } }));
    buf.push(100, mkLite({ pos: { x: 10, y: 0, z: 0 } }));
    // Render at t=200 → target = 0 → exact match.
    const r = buf.sample(200);
    expect(r.state?.pos.x).toBe(0);
  });

  it("marks stale when newest snapshot is older than REMOTE_STALE_MS", () => {
    const buf = new RemoteEntityBuffer();
    buf.push(0, mkLite({ pos: { x: 0, y: 0, z: 0 } }));
    buf.push(100, mkLite({ pos: { x: 10, y: 0, z: 0 } }));
    // Render at t=100 + REMOTE_STALE_MS + 1.
    const r = buf.sample(100 + REMOTE_STALE_MS + 1);
    expect(r.stale).toBe(true);
  });

  it("caps the ring at REMOTE_BUFFER_CAPACITY", () => {
    const buf = new RemoteEntityBuffer();
    for (let i = 0; i < REMOTE_BUFFER_CAPACITY + 10; i++) {
      buf.push(i * 10, mkLite({ pos: { x: i, y: 0, z: 0 } }));
    }
    expect(buf.size()).toBe(REMOTE_BUFFER_CAPACITY);
  });

  it("clear() empties the buffer", () => {
    const buf = new RemoteEntityBuffer();
    buf.push(0, mkLite());
    buf.push(100, mkLite());
    expect(buf.size()).toBe(2);
    buf.clear();
    expect(buf.size()).toBe(0);
    const r = buf.sample(200);
    expect(r.state).toBeNull();
    expect(r.stale).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// applyEntityUpdateToBuffer
// ---------------------------------------------------------------------------

describe("applyEntityUpdateToBuffer", () => {
  it("adds new remote entities to the buffer map", () => {
    const remotes = new Map<string, RemoteEntityBuffer>();
    const entities = [
      liteToWire(mkLite({ id: "e-1", pos: { x: 0, y: 0, z: 0 } })),
      liteToWire(mkLite({ id: "e-2", pos: { x: 10, y: 0, z: 0 } })),
    ];
    const out = applyEntityUpdateToBuffer({
      tMs: 0,
      entities,
      ownEntityId: null,
      remotes,
    });
    expect(out.size).toBe(2);
    expect(out.has("e-1")).toBe(true);
    expect(out.has("e-2")).toBe(true);
  });

  it("skips the own entity id", () => {
    const remotes = new Map<string, RemoteEntityBuffer>();
    const entities = [
      liteToWire(mkLite({ id: "e-local", pos: { x: 0, y: 0, z: 0 } })),
      liteToWire(mkLite({ id: "e-other", pos: { x: 10, y: 0, z: 0 } })),
    ];
    const out = applyEntityUpdateToBuffer({
      tMs: 0,
      entities,
      ownEntityId: "e-local",
      remotes,
    });
    expect(out.size).toBe(1);
    expect(out.has("e-other")).toBe(true);
    expect(out.has("e-local")).toBe(false);
  });

  it("does not remove entities missing from the frame (graceful underrun)", () => {
    const remotes = new Map<string, RemoteEntityBuffer>();
    const buf1 = new RemoteEntityBuffer();
    buf1.push(0, mkLite({ id: "e-1", pos: { x: 0, y: 0, z: 0 } }));
    remotes.set("e-1", buf1);

    const out = applyEntityUpdateToBuffer({
      tMs: 100,
      entities: [liteToWire(mkLite({ id: "e-2", pos: { x: 5, y: 0, z: 0 } }))],
      ownEntityId: null,
      remotes,
    });
    expect(out.size).toBe(2);
    expect(out.has("e-1")).toBe(true);
    expect(out.has("e-2")).toBe(true);
    // e-1 still holds its single entry.
    expect(out.get("e-1")?.size()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Snapshot jitter (acceptance test)
// ---------------------------------------------------------------------------

describe("RemoteEntityBuffer: snapshot jitter at 10 Hz ± 20 ms", () => {
  it("produces no visible jumps in scripted render captures", () => {
    const buf = new RemoteEntityBuffer();
    // Generate snapshots at a jittery 10 Hz cadence — sometimes a
    // tick late, sometimes early, alternating between ± 20 ms.
    const baseInterval = 100;
    const jitter = [0, 15, -10, 20, -5, 0, 18, -12, 8, -20];
    let t = 0;
    for (let i = 0; i < 30; i++) {
      const j = jitter[i % jitter.length]!;
      t += baseInterval + j;
      const x = i; // the snapshot moves 1 u per tick (deliberate)
      buf.push(t, mkLite({ id: "remote", pos: { x, y: 0, z: 0 } }));
    }
    // Sample the buffer at the render cadence and track per-frame
    // deltas. The threshold matches the spec's "no visible jumps"
    // acceptance criterion — chosen to be 2x the maximum snapshot
    // jitter plus the position step.
    let prevX = 0;
    let first = true;
    let maxFrameDelta = 0;
    for (let renderT = 100; renderT < t - INTERP_DELAY_MS; renderT += 16) {
      const r = buf.sample(renderT);
      if (r.state === null) continue;
      const x = r.state.pos.x;
      if (first) {
        first = false;
        prevX = x;
        continue;
      }
      const delta = Math.abs(x - prevX);
      if (delta > maxFrameDelta) maxFrameDelta = delta;
      prevX = x;
    }
    // The snapshot advances 1 u per 100 ms; with 16 ms render cadence
    // we expect ~0.16 u / frame. Allow generous headroom for jitter
    // (≤ 3 u / frame is well above the worst-case theoretical bound
    //  of 1 + 20 ms * 0.01 u/ms = 1.2 u).
    expect(maxFrameDelta).toBeLessThan(3);
  });
});

// ---------------------------------------------------------------------------
// simEntityFromWire
// ---------------------------------------------------------------------------

describe("simEntityFromWire", () => {
  it("converts a wire EntityState into the lite shape", () => {
    const wire: ProtocolEntityState = {
      id: "e-1",
      kind: "ship",
      pos: [1, 2, 3],
      vel: [4, 5, 6],
      regime: "atmosphere",
      hull: 100,
      shields: 50,
      targetId: null,
      classId: "scout",
      callsign: "FOO",
      livery: null,
      onPad: null,
    };
    const lite = simEntityFromWire(wire);
    expect(lite.id).toBe("e-1");
    expect(lite.pos).toEqual({ x: 1, y: 2, z: 3 });
    expect(lite.vel).toEqual({ x: 4, y: 5, z: 6 });
    expect(lite.regime).toBe("atmosphere");
  });

  it("defaults quat to identity (wire shape omits rotation)", () => {
    const wire: ProtocolEntityState = {
      id: "e-1",
      kind: "ship",
      pos: [0, 0, 0],
      vel: [0, 0, 0],
      regime: "space",
      hull: 100,
      shields: 50,
      targetId: null,
      classId: "scout",
      callsign: null,
      livery: null,
      onPad: null,
    };
    const lite = simEntityFromWire(wire);
    expect(lite.quat).toEqual({ x: 0, y: 0, z: 0, w: 1 });
  });
});

// ---------------------------------------------------------------------------
// Constants sanity
// ---------------------------------------------------------------------------

describe("tuning constants", () => {
  it("exposes documented thresholds", () => {
    expect(INTERP_DELAY_MS).toBe(200);
    expect(MAX_BLEND_POS_U).toBe(5);
    expect(MAX_BLEND_ANGLE_RAD).toBeCloseTo(0.2, 9);
    expect(REMOTE_STALE_MS).toBe(1000);
    expect(FORCE_SNAP_BLEND_MS).toBe(100);
  });
});
