/**
 * CharacterPredictor tests (TASK-32, step 3) — mirrors the ship predictor's
 * suite: shared-model lock step, held-input continuity, friction stop,
 * reconcile blend/rewind/snap + queue cap, and the acceptance latency
 * simulation (150 ms RTT, 20 Hz server, 10 Hz acks, 60 fps render,
 * constant walk — no sustained rubber-banding).
 */

import { describe, expect, it } from 'vitest';

import {
  integrateCharacter,
  restCharacterState,
  type CharacterInput,
  type CharacterState,
} from '@shared/physics/character';
import { inputToCharacterInput } from '@shared/protocol/inputs';
import type { InputPayload } from '@shared/protocol/schemas';
import { CharacterPredictor, characterStateFromWire } from './character-prediction';
import { BLEND_DISTANCE_U } from './prediction';

const FRAME_DT = 1 / 60; // 60 fps render
const FRAME_MS = 1000 / 60;
const TICK_DT = 1 / 20; // 20 Hz server

function wireFrame(seq: number, partial: Partial<InputPayload> = {}): InputPayload {
  return { seq, thrust: 0, turn: 0, pitch: 0, yaw: 0, fire: false, lock: false, ...partial };
}

const WALK: CharacterInput = inputToCharacterInput(wireFrame(1, { thrust: 1 }));
const ZERO: CharacterInput = inputToCharacterInput(wireFrame(0));

function makePredictor(
  pos = { x: 0, y: 0, z: 0 },
  heightAt?: (x: number, z: number) => number,
): CharacterPredictor {
  return new CharacterPredictor(restCharacterState(pos), { heightAt });
}

describe('CharacterPredictor: basic prediction (step 3)', () => {
  it('integrates with the shared model — walking advances along the facing', () => {
    const p = makePredictor();
    p.step(FRAME_DT, 0, { seq: 1, input: WALK });
    const expected = integrateCharacter(restCharacterState({ x: 0, y: 0, z: 0 }), WALK, FRAME_DT);
    expect(p.getState().pos).toEqual(expected.pos);
    expect(p.getState().onGround).toBe(true);
  });

  it('keeps integrating on the last input (held walk), then friction stops on release', () => {
    const p = makePredictor();
    for (let i = 0; i < 30; i++)
      p.step(FRAME_DT, i * FRAME_MS, i === 0 ? { seq: 1, input: WALK } : undefined);
    const walked = Math.hypot(p.getState().pos.x, p.getState().pos.z);
    expect(walked).toBeGreaterThan(0.4); // ~3 u/s × 0.5 s

    // Release: the zero input replaces the held walk; the character coasts
    // to a full stop under the 8 u/s² ground friction.
    const before = { ...p.getState().pos };
    for (let i = 30; i < 30 + 240; i++) p.step(FRAME_DT, i * FRAME_MS, { seq: 2, input: ZERO });
    const s = p.getState();
    expect(Math.hypot(s.vel.x, s.vel.z)).toBe(0);
    // Coast ≤ v²/2a = 9/16 ≈ 0.56 m past the release point, then at rest.
    expect(Math.hypot(s.pos.x - before.x, s.pos.z - before.z)).toBeLessThan(0.7);
  });

  it('follows an analytic 30° slope: the prediction tracks the terrain', () => {
    const slope = (z: number) => 0.577 * z; // tan(30°) along the walk axis (+Z)
    const p = makePredictor({ x: 0, y: 0, z: 0 }, (x, z) => slope(z));
    for (let i = 0; i < 120; i++)
      p.step(FRAME_DT, i * FRAME_MS, i === 0 ? { seq: 1, input: WALK } : undefined);
    const s = p.getState();
    expect(Math.abs(s.pos.y - slope(s.pos.z))).toBeLessThan(0.1); // within 0.1 m
  });

  it('predicts the jump arc (same shared model → same apex)', () => {
    const p = makePredictor();
    const jump = { ...ZERO, jump: true };
    let apex = 0;
    for (let i = 0; i < 120; i++) {
      p.step(FRAME_DT, i * FRAME_MS, i === 0 ? { seq: 1, input: jump } : undefined);
      if (p.getState().onGround) break;
      apex = Math.max(apex, p.getState().pos.y);
    }
    expect(apex).toBeCloseTo(25 / 24, 1); // v²/2g at v=5, g=12
  });
});

describe('CharacterPredictor: reconciliation', () => {
  it('small diff blends (half correction, no visible snap)', () => {
    const p = makePredictor();
    for (let i = 0; i < 30; i++)
      p.step(FRAME_DT, i * FRAME_MS, i === 0 ? { seq: 1, input: WALK } : undefined);
    // Server one tick (50 ms) AHEAD of the client's 0.5 s of walking —
    // a 0.15 u gap, well inside the blend thresholds.
    let server: CharacterState = restCharacterState({ x: 0, y: 0, z: 0 });
    for (let i = 0; i < 11; i++) server = integrateCharacter(server, WALK, TICK_DT);

    const result = p.reconcile(server, 1, 30 * FRAME_MS);
    expect(result.mode).toBe('blend');
    expect(result.correctionDistance).toBeLessThan(BLEND_DISTANCE_U);
    const predicted = p.getState();
    // Half the correction applied toward the reconciled state.
    const gap = Math.hypot(predicted.pos.x - server.pos.x, predicted.pos.z - server.pos.z);
    expect(gap).toBeLessThan(BLEND_DISTANCE_U / 2);
  });

  it('large diff rewinds: server state with time-weighted unacked replay', () => {
    const p = makePredictor();
    p.step(0.1, 0, { seq: 1, input: WALK });
    p.step(0.1, 100, { seq: 2, input: WALK });
    p.step(0.1, 200, { seq: 3, input: WALK });

    // Server truth 30 u away (a stall gap) — a rewind.
    const server = restCharacterState({ x: 0, y: 0, z: 30 });
    const result = p.reconcile(server, 1, 200); // seq 1 acked → 2, 3 replay
    expect(result.mode).toBe('rewind');
    expect(result.replayedInputs).toBe(2);

    // Exact: server state, then seq 2 replayed for its 100 ms of currency
    // (seq 3 has zero elapsed time at the reconcile moment).
    const expected = integrateCharacter(server, WALK, 0.1);
    expect(p.getState().pos).toEqual(expected.pos);
    expect(p.getQueue().map((q) => q.seq)).toEqual([2, 3]);
  });

  it('full ack collapses the queue and adopts the server truth', () => {
    const p = makePredictor();
    for (let i = 0; i < 20; i++)
      p.step(FRAME_DT, i * FRAME_MS, i === 0 ? { seq: 1, input: WALK } : undefined);
    const server = restCharacterState({ x: 7, y: 0, z: 9 });
    const result = p.reconcile(server, 1, 20 * FRAME_MS);
    expect(result.replayedInputs).toBe(0);
    expect(p.getState().pos).toEqual(server.pos);
    expect(p.getQueue()).toEqual([]);
  });

  it('a non-finite reconcile result (NaN quat) is never written — predicted state holds (TASK-96)', () => {
    const p = makePredictor();
    for (let i = 0; i < 30; i++)
      p.step(FRAME_DT, i * FRAME_MS, i === 0 ? { seq: 1, input: WALK } : undefined);
    const before = p.getState();
    // A NaN server quat makes correctionAngle NaN (not < threshold) → rewind,
    // and the reconciled state carries the NaN quat into the write.
    const server = restCharacterState({ x: 0, y: 0, z: 0 });
    server.quat = { x: NaN, y: NaN, z: NaN, w: NaN };
    const result = p.reconcile(server, 1, 30 * FRAME_MS);
    expect(result.mode).toBe('rewind');
    // The guard skipped the write: getState() is the same pre-reconcile state.
    expect(p.getState()).toBe(before);
  });

  it('a BLEND reconcile with a non-finite blended state is never written (TASK-96)', () => {
    const p = makePredictor();
    for (let i = 0; i < 30; i++)
      p.step(FRAME_DT, i * FRAME_MS, i === 0 ? { seq: 1, input: WALK } : undefined);
    const before = p.getState();
    // Server pos/quat finite and close → mode is blend; a NaN vel in the
    // snapshot makes the blended vel NaN (vel does not feed the mode check).
    const server: CharacterState = {
      pos: { ...before.pos },
      vel: { x: NaN, y: NaN, z: NaN },
      onGround: true,
      quat: { ...before.quat },
    };
    const result = p.reconcile(server, 1, 30 * FRAME_MS);
    expect(result.mode).toBe('blend');
    expect(p.getState()).toBe(before);
  });

  it('queue cap: inputs older than 10 s are dropped → forced snap', () => {
    const p = makePredictor();
    p.step(FRAME_DT, 0, { seq: 1, input: WALK });
    for (let i = 1; i < 1200; i++) p.step(FRAME_DT, i * FRAME_MS); // 20 s of frames, no acks
    p.step(FRAME_DT, 1200 * FRAME_MS, { seq: 2, input: WALK });
    expect(p.getQueue().map((q) => q.seq)).toEqual([2]);

    const server = restCharacterState({ x: 100, y: 20, z: 300 });
    const result = p.reconcile(server, 1, 1200 * FRAME_MS);
    expect(result.mode).toBe('snap');
    expect(result.replayedInputs).toBe(1);
    expect(p.getState().pos).toEqual(server.pos);
  });
});

describe('CharacterPredictor: latency simulation (acceptance)', () => {
  /**
   * Virtual-clock net: 150 ms RTT (75 ms each way), 20 Hz server ticks,
   * 10 Hz snapshots + acks, 60 fps client render, constant walk. The
   * server mirrors the shard's character loop (latest-wins held frame,
   * integrated every tick via the SHARED model; ack = last APPLIED seq at
   * snapshot cadence). The client predicts every frame and echoes the
   * held input at 20 Hz.
   */
  function simulate(totalMs: number, opts: { rttMs?: number } = {}) {
    const oneWay = (opts.rttMs ?? 150) / 2;
    const TICK = 50;
    const SNAP = 100;

    interface Msg {
      deliverAt: number;
      kind: 'input' | 'snapshot' | 'ack';
      seq: number;
      state?: CharacterState;
    }
    const inbox: Msg[] = [];

    // Server (shard mirror: latest frame REPLACES the held frame, which is
    // re-integrated every tick — the same hold semantics as SystemShard.tick).
    let serverState: CharacterState = restCharacterState({ x: 0, y: 0, z: 0 });
    let lastSeq = 0;
    let appliedSeq = 0;
    let ackSentSeq = 0;
    let pending: { seq: number; input: CharacterInput } | undefined;
    let held: { seq: number; input: CharacterInput } | undefined;

    // Client.
    const predictor = makePredictor();
    let clientFrame = 0;
    let lastSnapshot: CharacterState | undefined;
    const corrections: Array<{ t: number; mode: string; dist: number }> = [];

    let frameAcc = 0;
    for (let t = 0; t <= totalMs; t++) {
      for (let i = 0; i < inbox.length; i++) {
        if (inbox[i].deliverAt > t) break;
        const m = inbox.splice(i, 1)[0];
        if (m.kind === 'input') {
          if (m.seq > lastSeq) {
            lastSeq = m.seq;
            pending = { seq: m.seq, input: WALK };
          }
        } else if (m.kind === 'snapshot') {
          if (m.state) lastSnapshot = m.state;
        } else if (lastSnapshot) {
          const r = predictor.reconcile(lastSnapshot, m.seq, t);
          corrections.push({ t, mode: r.mode, dist: r.correctionDistance });
        }
      }
      if (t % TICK === 0 && t > 0) {
        if (pending) {
          held = pending;
          pending = undefined;
          appliedSeq = held.seq;
        }
        serverState = integrateCharacter(serverState, held?.input ?? ZERO, TICK_DT);
        if (t % SNAP === 0) {
          inbox.push({ deliverAt: t + oneWay, kind: 'snapshot', seq: 0, state: serverState });
          if (appliedSeq > ackSentSeq) {
            inbox.push({ deliverAt: t + oneWay, kind: 'ack', seq: appliedSeq });
            ackSentSeq = appliedSeq;
          }
        }
      }
      frameAcc += 1;
      while (frameAcc >= FRAME_MS) {
        frameAcc -= FRAME_MS;
        clientFrame++;
        // 20 Hz control updates: one new input every 3 frames.
        const newInput = clientFrame % 3 === 1 ? { seq: clientFrame, input: WALK } : undefined;
        predictor.step(FRAME_DT, t, newInput);
        if (newInput) inbox.push({ deliverAt: t + oneWay, kind: 'input', seq: clientFrame });
      }
    }
    return { corrections, predictor, serverState };
  }

  it('150 ms RTT, constant walk: max correction < 5 u after the first 2 s', () => {
    const { corrections, predictor, serverState } = simulate(8000);
    expect(corrections.length).toBeGreaterThan(20);

    const afterWarmup = corrections.filter((c) => c.t >= 2000);
    const maxDist = Math.max(...afterWarmup.map((c) => c.dist));
    expect(maxDist).toBeLessThan(5); // no snap-sized correction
    expect(afterWarmup.every((c) => c.mode === 'blend')).toBe(true);
    // The prediction tracks the authority end to end.
    const gap = Math.hypot(
      predictor.getState().pos.x - serverState.pos.x,
      predictor.getState().pos.z - serverState.pos.z,
    );
    expect(gap).toBeLessThan(5);
  });
});

describe('characterStateFromWire', () => {
  it('defaults to identity rotation + grounded when rot is absent', () => {
    const s = characterStateFromWire({ pos: { x: 1, y: 2, z: 3 }, vel: { x: 0, y: 0, z: 4 } });
    expect(s.quat).toEqual({ x: 0, y: 0, z: 0, w: 1 });
    expect(s.onGround).toBe(true);
    expect(s.pos).toEqual({ x: 1, y: 2, z: 3 });
  });
});
