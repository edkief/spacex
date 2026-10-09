/**
 * CharacterPredictor (TASK-32, step 3) — the on-foot local-character
 * predictor, mirroring ClientShipPredictor (TASK-14): the client integrates
 * the local character with the EXACT shared `integrateCharacter` (never
 * reimplemented here) on every render frame for every local input, so
 * walking has zero perceived latency.
 *
 * The same seq/ack/reconcile machinery as the ship predictor applies:
 * inputs carry a monotonic seq, the server acks the last APPLIED seq at
 * 10 Hz, and on reconcile the unacked queue is replayed on top of the
 * snapshot — on the server's input-hold timeline when `snapshotAgeMs` is
 * known, else for the local currency duration (the v1 default: the wire
 * ack carries no age, so the fallback replay is what runs in practice).
 *
 * Remote characters are NOT predicted here — they ride the same 200 ms
 * interpolation buffer as ships (./interpolation feeds every non-self
 * entity id).
 */

import {
  integrateCharacter,
  ZERO_CHARACTER_INPUT,
  type CharacterInput,
  type CharacterState,
} from '@shared/physics/character';
import {
  quatAngleBetween,
  quatSlerp,
  vecLerp,
  vecSub,
  vecLength,
  type Quat,
  type Vec3,
} from '@shared/physics/vec';
import {
  BLEND_ANGLE_RAD,
  BLEND_DISTANCE_U,
  BLEND_FACTOR,
  MAX_QUEUE_TIME_MS,
  SERVER_TICK_MS,
  type ReconcileOptions,
  type ReconcileResult,
} from './prediction';

/** One queued local character input (unacked by the server). */
export interface QueuedCharacterInput {
  seq: number;
  input: CharacterInput;
  /** Local render clock (ms) at which this input became current. */
  t: number;
}

/** Everything integrateCharacter needs; the client wires the terrain. */
export interface CharacterPredictionContext {
  /** Terrain height at (x, z); defaults to flat y = 0 (the pad plane). */
  heightAt?: (x: number, z: number) => number;
}

function cloneState(s: CharacterState): CharacterState {
  return {
    pos: { ...s.pos },
    vel: { ...s.vel },
    onGround: s.onGround,
    quat: { ...s.quat },
  };
}

function integrateOver(
  s: CharacterState,
  input: CharacterInput,
  fromMs: number,
  toMs: number,
  ctx: CharacterPredictionContext,
): CharacterState {
  if (toMs <= fromMs) return s;
  // Timestamps are ms; integrateCharacter takes seconds.
  return integrateCharacter(s, input, (toMs - fromMs) / 1000, ctx.heightAt);
}

/** Re-apply a run of timestamped inputs (each for the time it was current). */
function replay(
  base: CharacterState,
  inputs: readonly QueuedCharacterInput[],
  now: number,
  ctx: CharacterPredictionContext,
): CharacterState {
  let s = base;
  for (let i = 0; i < inputs.length; i++) {
    const q = inputs[i];
    s = integrateOver(s, q.input, q.t, i + 1 < inputs.length ? inputs[i + 1].t : now, ctx);
  }
  return s;
}

/**
 * Re-apply unacked inputs on the SERVER's input-hold timeline (the same
 * construction as the ship predictor's): the snapshot gap is filled with
 * the last acked (held) input; each unacked input integrates from the tick
 * the server applied it.
 */
function replayOnServerTimeline(
  base: CharacterState,
  ackedInput: CharacterInput | undefined,
  unacked: readonly QueuedCharacterInput[],
  now: number,
  ageMs: number,
  phaseMs: number,
  ctx: CharacterPredictionContext,
): CharacterState {
  let s = base;
  const onGrid = (t: number) =>
    phaseMs + SERVER_TICK_MS * Math.round((t - phaseMs) / SERVER_TICK_MS);
  /** First server tick that integrates an input sent locally at `t`. */
  const appliedAt = (t: number) =>
    phaseMs + SERVER_TICK_MS * Math.ceil((t + ageMs - phaseMs) / SERVER_TICK_MS);

  let cursor = onGrid(now - ageMs);
  const firstApply = unacked.length > 0 ? appliedAt(unacked[0].t) : Number.POSITIVE_INFINITY;
  const gapEnd = Math.min(firstApply, now);
  if (gapEnd > cursor) {
    s = integrateOver(s, ackedInput ?? ZERO_CHARACTER_INPUT, cursor, gapEnd, ctx);
    cursor = gapEnd;
  }
  for (let i = 0; i < unacked.length && cursor < now; i++) {
    const start = Math.max(appliedAt(unacked[i].t), cursor);
    const end = Math.min(i + 1 < unacked.length ? appliedAt(unacked[i + 1].t) : now, now);
    s = integrateOver(s, unacked[i].input, start, end, ctx);
    cursor = Math.max(cursor, end);
  }
  return s;
}

/**
 * TASK-96: a state the predictor may adopt (mirrors ClientShipPredictor's
 * TASK-76.1 rule, extended to vel because the character blend lerps it). A
 * single non-finite channel (e.g. a NaN quat from a slerp that hit an
 * unclamped dot) must never be written: the next step re-derives a NaN
 * forward vector from it, which poisons the on-foot terrain feed
 * (heightAt → generateSurfaceChunk → BigInt RangeError).
 */
function stateFinite(s: CharacterState): boolean {
  const p = s.pos;
  const v = s.vel;
  const q = s.quat;
  return Number.isFinite(p.x + p.y + p.z + v.x + v.y + v.z + q.x + q.y + q.z + q.w);
}

/** Blend one state toward another (position/velocity lerped, yaw slerped). */
function lerpState(a: CharacterState, b: CharacterState, t: number): CharacterState {
  return {
    pos: vecLerp(a.pos, b.pos, t),
    vel: vecLerp(a.vel, b.vel, t),
    quat: quatSlerp(a.quat, b.quat, t),
    onGround: b.onGround,
  };
}

/**
 * Predicts the local player's on-foot character (mirrors
 * ClientShipPredictor). Usage per render frame:
 * 1. `step(dt, now, newInput?)` — queue a new local input when one was
 *    produced this frame; otherwise the last input keeps integrating.
 * 2. On the self entity_update + ack:
 *    `reconcile(serverState, ackedSeq, now, opts?)`.
 * 3. Render `getState()`.
 */
export class CharacterPredictor {
  private predicted: CharacterState;
  private ctx: CharacterPredictionContext;
  private queue: QueuedCharacterInput[] = [];
  private currentInput: CharacterInput = ZERO_CHARACTER_INPUT;
  /** Set when step() dropped stale queue entries (the next reconcile must snap). */
  private queueCapped = false;

  constructor(initial: CharacterState, ctx: CharacterPredictionContext = {}) {
    this.predicted = cloneState(initial);
    this.ctx = ctx;
  }

  /** Update the terrain source (e.g. a world swap). */
  setContext(ctx: Partial<CharacterPredictionContext>): void {
    this.ctx = { ...this.ctx, ...ctx };
  }

  /** Advance the prediction by one render frame (dt in seconds). */
  step(dt: number, now: number, newInput?: { seq: number; input: CharacterInput }): CharacterState {
    if (newInput) {
      this.queue.push({ ...newInput, t: now });
      this.currentInput = newInput.input;
      // Stall protection: drop inputs older than MAX_QUEUE_TIME_MS.
      const floor = now - MAX_QUEUE_TIME_MS;
      const keep = this.queue.findIndex((q) => q.t >= floor);
      if (keep > 0) {
        this.queue.splice(0, keep);
        this.queueCapped = true; // dropped unacked inputs → force a snap
      }
    }
    this.predicted = integrateCharacter(this.predicted, this.currentInput, dt, this.ctx.heightAt);
    return this.predicted;
  }

  /**
   * Reconcile against the newest self snapshot + the acked seq. Unacked
   * inputs are replayed on top of the server state (server-timeline mode
   * when `opts.snapshotAgeMs` is known, else local currency duration);
   * small diff → blend, large diff → rewind.
   */
  reconcile(
    serverState: CharacterState,
    ackedSeq: number,
    now: number,
    opts: ReconcileOptions = {},
  ): ReconcileResult {
    const ackedInput = ackedSeq > 0 ? this.queue.find((q) => q.seq === ackedSeq)?.input : undefined;
    const unacked = this.queue.filter((q) => q.seq > ackedSeq);
    this.queue = unacked;

    const ageMs = opts.snapshotAgeMs ?? 0;
    const reconciled =
      ageMs > 0
        ? replayOnServerTimeline(
            cloneState(serverState),
            ackedInput,
            unacked,
            now,
            ageMs,
            opts.tickPhaseMs ?? 0,
            this.ctx,
          )
        : replay(cloneState(serverState), unacked, now, this.ctx);
    const correctionDistance = vecLength(vecSub(this.predicted.pos, reconciled.pos));
    const correctionAngle = quatAngleBetween(this.predicted.quat, reconciled.quat);

    let mode: ReconcileResult['mode'];
    if (this.queueCapped) {
      mode = 'snap';
    } else if (correctionDistance < BLEND_DISTANCE_U && correctionAngle < BLEND_ANGLE_RAD) {
      mode = 'blend';
    } else {
      mode = 'rewind';
    }
    this.queueCapped = false;

    const next =
      mode === 'blend' ? lerpState(this.predicted, reconciled, BLEND_FACTOR) : reconciled;
    // TASK-96: no-poison rule (same as the ship predictor's TASK-76.1) — a
    // non-finite reconciled/blended result must never be written; the last
    // finite predicted state holds until the next snapshot re-corrects it.
    if (stateFinite(next)) {
      this.predicted = next;
    }
    return { mode, correctionDistance, correctionAngle, replayedInputs: unacked.length };
  }

  /** The state to render this frame. */
  getState(): CharacterState {
    return this.predicted;
  }

  /** Unacked inputs currently queued (debug/tests). */
  getQueue(): readonly QueuedCharacterInput[] {
    return this.queue;
  }
}

/**
 * Wire EntityState → CharacterState for reconciliation. `rot` defaults to
 * identity (back-compat). The snapshot does not carry onGround, so a
 * reconciled character is assumed grounded (a mid-air snapshot is at most
 * ~0.8 s old; the next snapshot re-corrects).
 */
export function characterStateFromWire(entity: {
  pos: Vec3;
  vel: Vec3;
  rot?: { x: number; y: number; z: number; w: number };
}): CharacterState {
  const quat: Quat = entity.rot ? { ...entity.rot } : { x: 0, y: 0, z: 0, w: 1 };
  return { pos: { ...entity.pos }, vel: { ...entity.vel }, onGround: true, quat };
}
