/**
 * ClientShipPredictor tests (TASK-14, steps 1 + 4).
 *
 * Includes the acceptance latency simulation: a virtual clock with 150 ms
 * RTT (75 ms each way), 10 Hz snapshots, 20 Hz server ticks, 60 fps render,
 * constant thrust — max correction after the first 2 s must stay < 5 u
 * (no sustained rubber-banding).
 */

import { describe, expect, it } from 'vitest';

import {
  integrateShip,
  restShipState,
  type ShipInput,
  type ShipState,
} from '@shared/physics/flight';
import {
  quatAngleBetween,
  quatFromAxisAngle,
  quatIdentity,
  vecLength,
  vecSub,
} from '@shared/physics/vec';
import { inputToShipInput } from '@shared/protocol/inputs';
import type { InputPayload } from '@shared/protocol/schemas';
import {
  BLEND_ANGLE_RAD,
  BLEND_DISTANCE_U,
  BLEND_FACTOR,
  ClientShipPredictor,
  shipStateFromWire,
} from './prediction';

const FRAME_DT = 1 / 60; // 60 fps render
const FRAME_MS = 1000 / 60;
const TICK_DT = 1 / 20; // 20 Hz server

function zeroInput(seq: number): InputPayload {
  return { seq, thrust: 0, turn: 0, pitch: 0, yaw: 0, fire: false, lock: false };
}

function thrustInput(seq: number): InputPayload {
  return { ...zeroInput(seq), thrust: 1 };
}

const THRUST: ShipInput = inputToShipInput(thrustInput(1));
const ZERO_SHIP_INPUT: ShipInput = inputToShipInput(zeroInput(0));

function makePredictor(pos = { x: 0, y: 0, z: 0 }): ClientShipPredictor {
  return new ClientShipPredictor(restShipState(pos, 'space'), {
    regime: 'space',
    shipClass: 'scout',
  });
}

describe('ClientShipPredictor: basic prediction (step 1)', () => {
  it('integrates with the shared model — predicted state advances on local input', () => {
    const p = makePredictor();
    p.step(FRAME_DT, 0, { seq: 1, input: THRUST });
    const expected = integrateShip(
      restShipState({ x: 0, y: 0, z: 0 }, 'space'),
      THRUST,
      FRAME_DT,
      'space',
      undefined,
      'scout',
    );
    expect(p.getState().pos).toEqual(expected.pos);
    expect(p.getState().vel).toEqual(expected.vel);
  });

  it('keeps integrating on the last input between new inputs (held control)', () => {
    const p = makePredictor();
    p.step(FRAME_DT, 0, { seq: 1, input: THRUST });
    p.step(FRAME_DT, FRAME_MS); // no new input: same control continues
    p.step(FRAME_DT, 2 * FRAME_MS);
    let ref = restShipState({ x: 0, y: 0, z: 0 }, 'space');
    for (let i = 0; i < 3; i++) {
      ref = integrateShip(ref, THRUST, FRAME_DT, 'space', undefined, 'scout');
    }
    expect(p.getState().pos).toEqual(ref.pos);
  });

  it('coasts (zero input) when no input has ever been sent', () => {
    const p = makePredictor();
    for (let i = 0; i < 30; i++) p.step(FRAME_DT, i * FRAME_MS);
    expect(p.getState().pos).toEqual({ x: 0, y: 0, z: 0 });
  });
});

describe('ClientShipPredictor: reconciliation', () => {
  it('small diff blends (half correction, no visible snap)', () => {
    const p = makePredictor();
    // Fly 1 s with constant thrust.
    for (let i = 0; i < 60; i++)
      p.step(FRAME_DT, i * FRAME_MS, i === 0 ? { seq: 1, input: THRUST } : undefined);
    const predicted = p.getState();

    // Server is 50 ms (one tick) "ahead" of the client's 1 s — within the
    // 5 u / 0.2 rad thresholds (scout: a = 40 u/s² → ½·a·(1.05²-1²) ≈ 2.8 u).
    let server: ShipState = restShipState({ x: 0, y: 0, z: 0 }, 'space');
    for (let i = 0; i < 21; i++) {
      server = integrateShip(server, THRUST, TICK_DT, 'space', undefined, 'scout');
    }

    const result = p.reconcile(server, 1, 60 * FRAME_MS); // seq 1 acked: nothing to replay
    expect(result.mode).toBe('blend');
    expect(result.correctionDistance).toBeGreaterThan(0);
    expect(result.correctionDistance).toBeLessThan(BLEND_DISTANCE_U);
    expect(result.correctionAngle).toBeLessThan(BLEND_ANGLE_RAD);

    // State moved BLEND_FACTOR toward the reconciled (server) state: the
    // residual shrank by exactly that factor — a smooth correction, no snap.
    const before = vecLength(vecSub(predicted.pos, server.pos));
    const after = vecLength(vecSub(p.getState().pos, server.pos));
    expect(after).toBeCloseTo(before * (1 - BLEND_FACTOR), 9);
    expect(after).toBeLessThan(before);
  });

  it('large diff rewinds: server state with time-weighted unacked replay', () => {
    const p = makePredictor();
    // 10 Hz input cadence: three inputs over 200 ms of constant thrust.
    p.step(0.1, 0, { seq: 1, input: THRUST });
    p.step(0.1, 100, { seq: 2, input: THRUST });
    p.step(0.1, 200, { seq: 3, input: THRUST });

    // Server truth: 30 u away along +Z (a stall/latency gap) — a rewind.
    const server = restShipState({ x: 0, y: 0, z: 30 }, 'space');

    const result = p.reconcile(server, 1, 200); // only seq 1 acked → 2, 3 replay
    expect(result.mode).toBe('rewind');
    expect(result.replayedInputs).toBe(2);
    expect(result.correctionDistance).toBeGreaterThan(BLEND_DISTANCE_U);

    // Exact: server state, then seq 2 replayed for its 100 ms of currency;
    // seq 3 (newest) has zero elapsed time at the reconcile moment.
    const expected = integrateShip(server, THRUST, 0.1, 'space', undefined, 'scout');
    expect(p.getState().pos).toEqual(expected.pos);
    expect(p.getState().vel).toEqual(expected.vel);

    // Acked inputs are dropped from the queue.
    expect(p.getQueue().map((q) => q.seq)).toEqual([2, 3]);
  });

  it('full ack collapses the queue and snaps to the server truth', () => {
    const p = makePredictor();
    for (let i = 0; i < 20; i++)
      p.step(FRAME_DT, i * FRAME_MS, i === 0 ? { seq: 1, input: THRUST } : undefined);
    const server = restShipState({ x: 7, y: 0, z: 9 }, 'space'); // anywhere
    const result = p.reconcile(server, 1, 20 * FRAME_MS);
    expect(result.replayedInputs).toBe(0);
    expect(result.mode).toBe('rewind');
    expect(p.getState().pos).toEqual(server.pos);
    expect(p.getQueue()).toEqual([]);
  });

  it('queue cap: inputs older than 10 s are dropped → forced snap (no teleport)', () => {
    const p = makePredictor();
    p.step(FRAME_DT, 0, { seq: 1, input: THRUST });
    // A 10 s stall: frames keep rendering, no acks arrive.
    for (let i = 1; i < 1200; i++) p.step(FRAME_DT, i * FRAME_MS);
    // A new input after the stall drops the stale (unacked) seq 1.
    p.step(FRAME_DT, 1200 * FRAME_MS, { seq: 2, input: THRUST });
    expect(p.getQueue().map((q) => q.seq)).toEqual([2]);

    const server = restShipState({ x: 100, y: 200, z: 300 }, 'space');
    const result = p.reconcile(server, 1, 1200 * FRAME_MS); // seq 1 acked (dropped), 2 unacked
    expect(result.mode).toBe('snap');
    expect(result.replayedInputs).toBe(1);
    // The newest input has zero elapsed time → the state IS the server state.
    expect(p.getState().pos).toEqual(server.pos);
  });
});

describe('ClientShipPredictor: latency simulation (step 4 — acceptance)', () => {
  /**
   * Virtual-clock net: 150 ms RTT (75 ms each way), 20 Hz server ticks,
   * 10 Hz snapshots + acks, 60 fps client render, constant thrust.
   * The server mirrors the shard: latest-wins input queue applied at the
   * next tick, ack = last APPLIED seq at snapshot cadence. The client
   * predicts every frame and echoes the held input at 10 Hz (10 fps of
   * control updates).
   */
  function simulate(totalMs: number, opts: { rttMs?: number } = {}) {
    const oneWay = (opts.rttMs ?? 150) / 2;
    const TICK = 50;
    const SNAP = 100;

    interface Msg {
      deliverAt: number;
      kind: 'input' | 'snapshot' | 'ack';
      seq: number;
      state?: ShipState;
    }
    const inbox: Msg[] = [];

    // Server (shard mirror: latest frame REPLACES the held frame, which is
    // re-integrated every tick until a newer frame arrives — the same hold
    // semantics the client predictor uses; see SystemShard.tick).
    let serverState = restShipState({ x: 0, y: 0, z: 0 }, 'space');
    let lastSeq = 0;
    let appliedSeq = 0;
    let ackSentSeq = 0;
    let pending: { seq: number; input: ShipInput } | undefined; // arrived, awaiting a tick
    let held: { seq: number; input: ShipInput } | undefined; // integrated every tick

    // Client.
    const predictor = makePredictor();
    let clientFrame = 0;
    let lastSnapshot: ShipState | undefined;
    const corrections: Array<{ t: number; mode: string; dist: number; angle: number }> = [];

    let frameAcc = 0;
    const tMax = Math.floor(totalMs);
    for (let t = 0; t <= tMax; t++) {
      // Deliver due messages. Every message carries the SAME one-way delay,
      // so the inbox is push-ordered = delivery-ordered: iterate forward
      // (and break at the first undeliverable) so a snapshot pushed before
      // its ack at the same tick is applied BEFORE the ack reconciles —
      // the client reconciles against the snapshot the ack traveled with.
      for (let i = 0; i < inbox.length; i++) {
        if (inbox[i].deliverAt > t) break;
        const m = inbox.splice(i, 1)[0];
        if (m.kind === 'input') {
          if (m.seq > lastSeq) {
            lastSeq = m.seq;
            pending = { seq: m.seq, input: THRUST }; // latest frame; held at next tick
          }
        } else if (m.kind === 'snapshot') {
          if (m.state) lastSnapshot = m.state;
        } else {
          // ack: reconcile against the newest snapshot seen so far,
          // reporting the one-way age so the replay lands on the server's
          // input-hold timeline.
          if (lastSnapshot) {
            const r = predictor.reconcile(lastSnapshot, m.seq, t, { snapshotAgeMs: oneWay });
            corrections.push({
              t,
              mode: r.mode,
              dist: r.correctionDistance,
              angle: r.correctionAngle,
            });
          }
        }
      }

      // Server tick (20 Hz): the held frame is re-integrated EVERY tick until
      // a newer frame replaces it (SystemShard.tick hold semantics).
      if (t % TICK === 0 && t > 0) {
        if (pending) {
          held = pending; // newest frame becomes the held frame
          pending = undefined;
          appliedSeq = held.seq; // reconcilable from this tick on
        }
        serverState = integrateShip(
          serverState,
          held?.input ?? ZERO_SHIP_INPUT,
          TICK_DT,
          'space',
          undefined,
          'scout',
        );
        // 10 Hz: snapshot + ack, both delayed one way.
        if (t % SNAP === 0) {
          inbox.push({ deliverAt: t + oneWay, kind: 'snapshot', seq: 0, state: serverState });
          if (appliedSeq > ackSentSeq) {
            inbox.push({ deliverAt: t + oneWay, kind: 'ack', seq: appliedSeq });
            ackSentSeq = appliedSeq;
          }
        }
      }

      // Client render frames (60 fps). The held thrust is echoed as a new
      // input every 10 frames (10 Hz control updates); between echoes the
      // predictor keeps integrating the last input.
      frameAcc += 1;
      while (frameAcc >= FRAME_MS) {
        frameAcc -= FRAME_MS;
        clientFrame++;
        const newInput = clientFrame % 10 === 1 ? { seq: clientFrame, input: THRUST } : undefined;
        predictor.step(FRAME_DT, t, newInput);
        if (newInput) {
          inbox.push({ deliverAt: t + oneWay, kind: 'input', seq: clientFrame });
        }
      }
    }
    return { corrections, predictor, serverState };
  }

  it('150 ms RTT, constant thrust: max correction < 5 u after the first 2 s', () => {
    const { corrections } = simulate(8000);
    expect(corrections.length).toBeGreaterThan(20); // sanity: acks were reconciling

    const afterWarmup = corrections.filter((c) => c.t >= 2000);
    const maxDist = Math.max(...afterWarmup.map((c) => c.dist));
    const maxAngle = Math.max(...afterWarmup.map((c) => c.angle));
    // The acceptance threshold: no correction large enough to read as a snap.
    expect(maxDist).toBeLessThan(5);
    expect(maxAngle).toBeLessThan(0.2);
    // In practice every post-warmup correction blends — the prediction and
    // the server stay in lock step (no sustained rubber-banding).
    expect(afterWarmup.every((c) => c.mode === 'blend')).toBe(true);
  });

  it('steady-state correction is tiny (prediction tracks the authority)', () => {
    const { corrections } = simulate(6000);
    const afterWarmup = corrections.filter((c) => c.t >= 2000);
    const avg = afterWarmup.reduce((s, c) => s + c.dist, 0) / afterWarmup.length;
    expect(avg).toBeLessThan(2); // well under the 5 u snap threshold
  });

  it('at 300 ms RTT the correction degrades gracefully (no sustained > 10 u band)', () => {
    const { corrections } = simulate(8000, { rttMs: 300 });
    const afterWarmup = corrections.filter((c) => c.t >= 2000);
    expect(Math.max(...afterWarmup.map((c) => c.dist))).toBeLessThan(10);
    // Most corrections still blend even at the higher latency.
    const blended = afterWarmup.filter((c) => c.mode === 'blend').length;
    expect(blended / afterWarmup.length).toBeGreaterThan(0.8);
  });
});

describe('shipStateFromWire', () => {
  it('defaults to identity rotation when rot is absent (v1 back-compat)', () => {
    const s = shipStateFromWire({ pos: { x: 1, y: 2, z: 3 }, vel: { x: 0, y: 0, z: 4 } });
    expect(s.quat).toEqual(quatIdentity());
    expect(s.pos).toEqual({ x: 1, y: 2, z: 3 });
  });

  it('uses rot when present', () => {
    const rot = quatFromAxisAngle({ x: 0, y: 1, z: 0 }, 0.7);
    const s = shipStateFromWire({
      pos: { x: 0, y: 0, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      rot,
    });
    expect(s.quat).toEqual(rot);
    expect(quatAngleBetween(s.quat, rot)).toBeLessThan(1e-12);
  });
});
