/**
 * Client prediction + server reconciliation (TASK-14).
 *
 * The client integrates the local ship with the EXACT shared `integrateShip`
 * (TASK-22 — never reimplemented here) on every render frame for every local
 * input, so the ship moves with zero perceived latency. Each input carries a
 * monotonically increasing seq AND the local time it became current; the
 * server acks the last seq it APPLIED (`ack` message, 10 Hz).
 *
 * On reconcile (ack arrival + newest snapshot):
 * - The unacked queue (seq > acked) is replayed on top of the server state
 *   to estimate the server's CURRENT state from a snapshot that is
 *   one-way-latency old.
 * - The replay windows land on the SERVER's input-hold timeline, not the
 *   local one. An input sent locally at `s` arrives at the server at
 *   `s + oneWay` and is applied at the first server tick after that (20 Hz
 *   grid); it is held until the next input is applied. With the estimated
 *   one-way delay (`snapshotAgeMs`, the snapshot's age at arrival ≈ the
 *   one-way delay when ack and snapshot travel together):
 *     - the snapshot state was valid at `s_snap = now - age`, snapped to
 *       the server tick grid (absorbs a few ms of age-estimate error);
 *     - the gap [s_snap, first unacked application) is filled with the
 *       last ACKED input — the frame the server still holds (replaying
 *       only unacked inputs would leave a hole where the server was
 *       integrating the held frame — a systematic v·age undershoot);
 *     - each unacked input integrates over [its application tick, the next
 *       unacked application tick), clamped to [s_snap, now] (an input still
 *       in flight gets no window; the held frame covers up to `now`).
 *   Replaying from raw local send times instead double-counts / misses
 *   exactly the latency-length segment and leaves a systematic
 *   v·one-way-latency offset that reads as sustained rubber-banding at
 *   speed. With `snapshotAgeMs` unknown (0) the replay falls back to
 *   re-applying unacked inputs for their local currency duration.
 * - Small diff (distance < 5 u, angle < 0.2 rad) → blend: take half the
 *   correction toward the reconciled state (no visible snap); the next
 *   snapshot finishes the convergence.
 * - Large diff → rewind: adopt the reconciled state outright.
 * - If the unacked queue overflowed (> 10 s of inputs, e.g. a network stall)
 *   the oldest are dropped and the reconcile is a forced snap: server state
 *   + remaining unacked inputs — the server state is the most recent truth,
 *   so no visible teleport.
 *
 * Remote entities are NOT predicted here — see ./interpolation (200 ms
 * interpolation buffer, honesty over smoothness).
 */

import {
  integrateShip,
  type PlanetAtmo,
  type FlightOptions,
  type Regime,
  type ShipInput,
  type ShipState,
} from '@shared/physics/flight';
import {
  quatAngleBetween,
  quatSlerp,
  vecLerp,
  vecSub,
  vecLength,
  type Vec3,
} from '@shared/physics/vec';
import { cruiseAllowedAt, type RegimePlanet } from '@shared/regime';
import type { ShipClass, ShipClassId } from '@shared/ships';

/** Distance (u) below which a reconcile correction blends instead of rewinds. */
export const BLEND_DISTANCE_U = 5;
/** Angle (rad) below which a reconcile correction blends instead of rewinds. */
export const BLEND_ANGLE_RAD = 0.2;
/** Fraction of the correction applied in a blend (rest converges next snapshot). */
export const BLEND_FACTOR = 0.5;
/**
 * The unacked queue keeps at most this much input history (ms). After a
 * stall longer than this the oldest inputs are dropped and the next
 * reconcile snaps (spec technical note: cap queue at 10 s, force-snap).
 */
export const MAX_QUEUE_TIME_MS = 10_000;
/**
 * Server sim tick period (ms) — mirrors SystemShard.TICK_DT_MS (20 Hz).
 * Used to place replay windows on the server's tick grid. The client must
 * not import server code, so the constant is mirrored here.
 */
export const SERVER_TICK_MS = 50;

const ZERO_SHIP_INPUT: ShipInput = { thrust: 0, yaw: 0, pitch: 0, roll: 0, up: 0 };

/**
 * TASK-76.1: a demand frame the predictor may adopt. A single non-finite
 * channel (e.g. a look channel multiplied by a transiently un-hydrated
 * setting — 0 × NaN = NaN) must be dropped: held or replayed, it would
 * re-integrate a NaN rotation on top of every later state.
 */
function inputFinite(i: ShipInput): boolean {
  return Number.isFinite(i.thrust + i.yaw + i.pitch + i.roll + i.up + (i.boost ?? 0));
}

/** TASK-76.1: a state the predictor may adopt (see inputFinite). */
function stateFinite(pos: Vec3, quat: { x: number; y: number; z: number; w: number }): boolean {
  return Number.isFinite(pos.x + pos.y + pos.z + quat.x + quat.y + quat.z + quat.w);
}

/** One queued local input (unacked by the server), with its local timestamp. */
export interface QueuedInput {
  seq: number;
  input: ShipInput;
  /** Local render clock (ms) at which this input became current. */
  t: number;
}

/** Reconcile tuning (the WS client wires these from its latency estimate). */
export interface ReconcileOptions {
  /**
   * Estimated one-way delay (ms): how long before `now` the server took the
   * `serverState` snapshot. > 0 → the replay is placed on the server's
   * input-hold timeline (see module header); 0/absent → no latency info,
   * fall back to replaying unacked inputs for their local currency duration.
   */
  snapshotAgeMs?: number;
  /**
   * Phase (ms) of the server's 20 Hz tick grid relative to the local clock
   * (default 0). The snapshot time is snapped to this grid, so a few ms of
   * age-estimate error cannot shift the replay windows.
   */
  tickPhaseMs?: number;
}

/** Everything integrateShip needs; the client wires regime/planet context. */
export interface PredictionContext {
  regime: Regime;
  shipClass: ShipClass | ShipClassId;
  planet?: PlanetAtmo;
  options?: FlightOptions;
  /**
   * The system's regime planets (TASK-85): the predictor resolves
   * `cruiseAllowedAt(pos, ...)` at the CURRENT predicted position on
   * every integrate call, exactly like the server tick — so a boost
   * demand engages/drops out at the same place on client and server.
   */
  regimePlanets?: RegimePlanet[];
}

/** How the last reconcile resolved (for HUD debug + tests). */
export interface ReconcileResult {
  /** 'blend' = small diff corrected smoothly; 'rewind' = large diff; 'snap' = queue capped. */
  mode: 'blend' | 'rewind' | 'snap';
  /** Position distance (u) between predicted and reconciled state, before blend. */
  correctionDistance: number;
  /** Rotation (rad) between predicted and reconciled quats, before blend. */
  correctionAngle: number;
  /** Number of unacked inputs re-applied on top of the server state. */
  replayedInputs: number;
}

/**
 * TASK-85: the options for one integrate call — the context options with
 * `cruiseAllowed` resolved at the CURRENT position of the state being
 * integrated (the shared `cruiseAllowedAt`, same call as the server tick).
 */
function optionsAt(ctx: PredictionContext, pos: Vec3): FlightOptions | undefined {
  if (!ctx.regimePlanets) return ctx.options;
  return { ...ctx.options, cruiseAllowed: cruiseAllowedAt(pos, ctx.regimePlanets) };
}

function cloneState(s: ShipState): ShipState {
  return {
    pos: { ...s.pos },
    vel: { ...s.vel },
    quat: { ...s.quat },
    regime: s.regime,
    ...(s.onPad !== undefined ? { onPad: s.onPad } : {}),
  };
}

/**
 * Re-apply unacked inputs on the SERVER's input-hold timeline (see module
 * header): the snapshot gap is filled with the last acked (held) input, and
 * each unacked input integrates from the tick the server applied it.
 * `ageMs` is the snapshot's one-way age; `phaseMs` the server tick phase.
 */
function replayOnServerTimeline(
  base: ShipState,
  ackedInput: ShipInput | undefined,
  unacked: readonly QueuedInput[],
  now: number,
  ageMs: number,
  phaseMs: number,
  ctx: PredictionContext,
): ShipState {
  let s = base;
  const integrate = (input: ShipInput, from: number, to: number): void => {
    if (to > from) {
      // Timestamps are ms; integrateShip takes seconds.
      s = integrateShip(
        s,
        input,
        (to - from) / 1000,
        ctx.regime,
        ctx.planet,
        ctx.shipClass,
        optionsAt(ctx, s.pos),
      );
    }
  };
  const onGrid = (t: number) =>
    phaseMs + SERVER_TICK_MS * Math.round((t - phaseMs) / SERVER_TICK_MS);
  /** First server tick that integrates an input sent locally at `t`. */
  const appliedAt = (t: number) =>
    phaseMs + SERVER_TICK_MS * Math.ceil((t + ageMs - phaseMs) / SERVER_TICK_MS);

  // The snapshot state was valid at this server tick.
  let cursor = onGrid(now - ageMs);
  // Gap: the server still held the last acked input until the first unacked
  // application. (No acked input in the queue — seq 0 coast or a capped
  // stall — integrates as zero, which the hold loop below skips.)
  const firstApply = unacked.length > 0 ? appliedAt(unacked[0].t) : Number.POSITIVE_INFINITY;
  const gapEnd = Math.min(firstApply, now);
  if (gapEnd > cursor) {
    integrate(ackedInput ?? ZERO_SHIP_INPUT, cursor, gapEnd);
    cursor = gapEnd;
  }
  for (let i = 0; i < unacked.length && cursor < now; i++) {
    const start = Math.max(appliedAt(unacked[i].t), cursor);
    const end = Math.min(i + 1 < unacked.length ? appliedAt(unacked[i + 1].t) : now, now);
    integrate(unacked[i].input, start, end);
    cursor = Math.max(cursor, end);
  }
  return s;
}

/** Re-apply a run of timestamped inputs (each for the time it was current). */
function replay(
  base: ShipState,
  inputs: readonly QueuedInput[],
  now: number,
  ctx: PredictionContext,
): ShipState {
  let s = base;
  for (let i = 0; i < inputs.length; i++) {
    const q = inputs[i];
    // Timestamps are ms; integrateShip takes seconds.
    const dur = Math.max(0, (i + 1 < inputs.length ? inputs[i + 1].t : now) - q.t) / 1000;
    if (dur > 0) {
      s = integrateShip(s, q.input, dur, ctx.regime, ctx.planet, ctx.shipClass, optionsAt(ctx, s.pos));
    }
  }
  return s;
}

/** Blend one state toward another (position/velocity lerped, rotation slerped). */
function lerpState(a: ShipState, b: ShipState, t: number): ShipState {
  return {
    pos: vecLerp(a.pos, b.pos, t),
    vel: vecLerp(a.vel, b.vel, t),
    quat: quatSlerp(a.quat, b.quat, t), // small-angle regime: slerp, never snap
    regime: a.regime,
    ...(b.onPad !== undefined ? { onPad: b.onPad } : {}),
  };
}

/**
 * Predicts the local player's ship.
 *
 * Usage per render frame:
 * 1. `step(dt, now, newInput?)` — pass a new local input when one was
 *    produced this frame (its seq is queued, with `now`, and it integrates
 *    immediately).
 * 2. On `ack {seq}` arrival (with the newest snapshot):
 *    `reconcile(lastServerState, seq, now, {snapshotAgeMs: oneWay})`.
 * 3. Render `getState()`.
 */
export class ClientShipPredictor {
  private predicted: ShipState;
  private ctx: PredictionContext;
  private queue: QueuedInput[] = [];
  private currentInput: ShipInput = ZERO_SHIP_INPUT;
  /** Set when step() dropped stale queue entries (the next reconcile must snap). */
  private queueCapped = false;

  constructor(initial: ShipState, ctx: PredictionContext) {
    this.predicted = cloneState(initial);
    this.ctx = ctx;
  }

  /** Update regime/planet (e.g. entering an atmosphere — TASK-28). */
  setContext(ctx: Partial<PredictionContext>): void {
    this.ctx = { ...this.ctx, ...ctx };
  }

  /**
   * Advance the prediction by one render frame. When `newInput` is given it
   * is queued (with its seq and the local time `now`) and becomes the
   * current control; otherwise the last input keeps integrating (the ship
   * coasts on held controls).
   */
  step(dt: number, now: number, newInput?: { seq: number; input: ShipInput }): ShipState {
    // TASK-76.1: a non-finite demand frame (e.g. a transiently un-hydrated
    // setting multiplying the look channels) is dropped outright — queued
    // or held, it would re-poison the state on every replay/reconcile.
    if (newInput && !inputFinite(newInput.input)) return this.predicted;
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
    const next = integrateShip(
      this.predicted,
      this.currentInput,
      dt,
      this.ctx.regime,
      this.ctx.planet,
      this.ctx.shipClass,
      optionsAt(this.ctx, this.predicted.pos),
    );
    // TASK-76.1: a non-finite result (a NaN demand that slipped into the
    // held input, a corrupt context) must never be adopted — the render
    // feeds lerp/slerp from the predicted state, and a single NaN frame
    // poisons the smoothed chase camera forever (no recovery path). Hold
    // the last finite state; the next reconcile re-corrects it.
    if (stateFinite(next.pos, next.quat)) {
      this.predicted = next;
    }
    return this.predicted;
  }

  /**
   * Reconcile against the newest snapshot + the acked seq (the last input
   * seq the server applied). Unacked inputs are replayed on top of the
   * server state — on the server's input-hold timeline when
   * `opts.snapshotAgeMs` is known, else for their local currency duration;
   * small diff → blend, large diff → rewind.
   */
  reconcile(
    serverState: ShipState,
    ackedSeq: number,
    now: number,
    opts: ReconcileOptions = {},
  ): ReconcileResult {
    // The last acked input is the frame the server still HOLDS: it fills
    // the gap between the snapshot time and the first unacked application.
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
    // TASK-76.1: same no-poison rule as step() — a non-finite reconciled
    // result (a corrupt wire rot riding the snapshot) must never be
    // adopted; the last finite state holds until the next snapshot.
    if (stateFinite(next.pos, next.quat)) {
      this.predicted = next;
    }
    return { mode, correctionDistance, correctionAngle, replayedInputs: unacked.length };
  }

  /** The state to render this frame. */
  getState(): ShipState {
    return this.predicted;
  }

  /** Unacked inputs currently queued (debug/tests). */
  getQueue(): readonly QueuedInput[] {
    return this.queue;
  }
}

/**
 * Wire EntityState → ShipState for reconciliation. `rot` defaults to
 * identity (back-compat with v1 producers that predate the field). The
 * flight regime comes from the client's own context (setContext) — the wire
 * regime is display state, not physics input.
 */
/** TASK-76.1: all four quaternion components present AND finite. */
function quatUsable(q: { x: number; y: number; z: number; w: number }): boolean {
  return Number.isFinite(q.x + q.y + q.z + q.w);
}

/** TASK-76.1: all three components present AND finite. */
function vecUsable(v: { x: number; y: number; z: number }): boolean {
  return Number.isFinite(v.x + v.y + v.z);
}

export function shipStateFromWire(entity: {
  pos: Vec3;
  /** Wire default contract: omitted when zero. */
  vel?: Vec3;
  /** Wire default contract: omitted when identity. */
  rot?: { x: number; y: number; z: number; w: number };
}): ShipState {
  // The wire omits vel/rot by default contract (zero / identity) — but an
  // OMITTED vel spreads to {} (undefined components) and a corrupt frame
  // (e.g. null components) is truthy, so BOTH the missing and the
  // non-finite cases fall back to the documented defaults: a seeded NaN
  // would ride the prediction (and the chase camera) with no recovery.
  return {
    pos: { ...entity.pos },
    vel: entity.vel && vecUsable(entity.vel) ? { ...entity.vel } : { x: 0, y: 0, z: 0 },
    quat: entity.rot && quatUsable(entity.rot) ? { ...entity.rot } : { x: 0, y: 0, z: 0, w: 1 },
    regime: 'space',
  };
}
