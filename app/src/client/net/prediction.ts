/**
 * Client-side prediction + server reconciliation (TASK-14).
 *
 * Goal: the local player ship must respond to input with **zero
 * perceptible lag** even when the network round-trip is ~150 ms,
 * while still respecting server authority. The classic Quake-III
 * recipe handles this in two halves:
 *
 *   1. **Local prediction.** On every render frame the client
 *      integrates its own ship using the same `integrateShip` the
 *      server uses (`@shared/physics/flight`). The user sees their
 *      ship move immediately. Every input gets a monotonically
 *      increasing `seq` and is queued for delivery to the server.
 *
 *   2. **Server reconciliation.** When an `entity_update` arrives,
 *      the client compares the server's authoritative state with
 *      its locally-predicted state. If they agree to within
 *      tolerance (5 u position, 0.2 rad rotation) the client just
 *      drains the inputs that the server has acknowledged
 *      (`lastAppliedSeq`). Otherwise the client rewinds to the
 *      server state and re-runs the unacked inputs.
 *
 * The remote side is different: we don't *predict* other players.
 * We render them 200 ms in the past (the standard trade — smoothness
 * over freshness) using a small ring buffer of `entity_update`
 * snapshots. When the buffer under-runs (e.g. after a stall) we
 * freeze on the latest known state with a "stale" flag — never
 * teleport.
 *
 * This module ships:
 *   - `ClientShipPredictor`      — owns the local input queue + state
 *   - `RemoteEntityBuffer`       — per-remote interpolation ring
 *   - `applyEntityUpdateToBuffer`— pure helper for the WS layer
 *   - `INTERP_DELAY_MS`          — 200 ms render delay for remotes
 *   - Thresholds (`MAX_BLEND_POS_U`, `MAX_BLEND_ANGLE_RAD`) as
 *     constants for tests to import verbatim.
 *
 * The module is pure TypeScript with zero dependencies on three.js,
 * React, or the network layer. It can be unit-tested with a
 * virtual clock and a fake server.
 *
 * @see ../shared/physics/flight.ts for the integrator we *reuse*
 *      verbatim (no re-implementation).
 * @see ../shared/protocol/schemas.ts for `EntityState`.
 * @see ../../server/shard for the authoritative simulation.
 */

import type { ProtocolEntityState, ProtocolShipClassId } from "@shared/protocol/index.js";
import {
  integrateShip,
  type FlightRegime,
  type ShipInput,
  type ShipState,
} from "@shared/physics/flight.js";
import {
  integrateCharacter,
  wireInputToCharacterInput,
  type CharacterInput,
  type CharacterState,
} from "@shared/physics/character.js";
import type { PlanetAtmosphere } from "@shared/physics/atmosphere.js";
import { SHIP_CLASSES, type ShipClassId } from "@shared/ships.js";
import { quatSlerp, vecLerp, type Quat, type Vec3 } from "@shared/physics/vec.js";
// ---------------------------------------------------------------------------
// Tuning constants — referenced by tests and the renderer.
// ---------------------------------------------------------------------------

/** Render remotes at `now - INTERP_DELAY_MS` to absorb jitter. */
export const INTERP_DELAY_MS = 200;

/** Position blend threshold (units). Below this, ignore the discrepancy. */
export const MAX_BLEND_POS_U = 5;

/** Rotation blend threshold (radians). Below this, ignore the discrepancy. */
export const MAX_BLEND_ANGLE_RAD = 0.2;

/**
 * Hard cap on the input queue. If a stall lets the queue grow past
 * this we force-snap with a 0.1 s blend rather than running the
 * rewind-and-replay path (which would visibly rubber-band across
 * the whole stall period).
 */
export const MAX_QUEUED_INPUTS = 600;

/**
 * Maximum input queue time (seconds). When the oldest unacked input
 * is older than this, the predictor force-snaps to the server state
 * and drops the queue. Defaults to 10 s per the spec.
 */
export const MAX_QUEUED_SECONDS = 10;

/**
 * Blend duration when the predictor force-snaps after a queue
 * overflow. Short enough to be unnoticeable; long enough to avoid
 * a single-frame teleport.
 */
export const FORCE_SNAP_BLEND_MS = 100;

/**
 * Remote entities whose newest snapshot is older than this are
 * considered "stale" — the renderer dims the impostor and freezes
 * the position. Mirrors the spec's "1 s stale → freeze + dim" rule.
 */
export const REMOTE_STALE_MS = 1000;

/**
 * Max entries in the per-remote ring buffer. Each entry holds a full
 * `EntityState` plus a wall-clock timestamp (~80 bytes). 16 entries
 * covers ~1.6 s of history at 10 Hz with headroom for jitter bursts.
 */
export const REMOTE_BUFFER_CAPACITY = 16;

// ---------------------------------------------------------------------------
// Local ship input
// ---------------------------------------------------------------------------

/**
 * A single player input produced by the local render frame. The
 * client stamps `seq` itself so the server can verify order.
 *
 * `dt` is the render-frame delta the client integrated with — the
 * server uses its own fixed 1/20 s dt (TASK-13), so this is for
 * client-side bookkeeping only.
 *
 * TASK-32: `action` carries the wire-level `action` string (e.g.
 * `"jump"` for on-foot characters). The ship predictor ignores
 * it; the character predictor reads it for jump impulses. Default
 * `null` so pre-TASK-32 callers and tests don't have to wire it.
 */
export interface LocalInput {
  /** Monotonically increasing input seq. Starts at 1. */
  seq: number;
  /** Wall-clock time the input was captured (ms since epoch). */
  tMs: number;
  /** Forward throttle in [0, 1]. */
  thrust: number;
  /** Turn axis [-1, 1]. */
  turn: number;
  /** Pitch axis [-1, 1]. */
  pitch: number;
  /** Yaw axis [-1, 1] (used for roll on ships; character
   * predictor does not currently use this). */
  yaw: number;
  /** Fire button (used by the character predictor as the
   * `run` flag — the wire's `fire` boolean is unused for
   * characters, so we overload it). Optional; default `false`. */
  fire?: boolean;
  /** Render-frame dt in seconds. */
  dt: number;
  /** Wire-level action string (e.g. `"jump"`). Optional. */
  action?: string | null;
}

/**
 * Convert a `LocalInput` into the `ShipInput` shape the shared
 * flight model accepts. Centralised so the test cases and the
 * predictor agree on the mapping. Mirrors the server's mapping
 * (`turn → yaw`, `pitch → pitch`, `yaw → roll`).
 */
export function localInputToShipInput(input: LocalInput): ShipInput {
  return {
    thrust: clamp01(input.thrust),
    yaw: clampUnit(input.turn),
    pitch: clampUnit(input.pitch),
    roll: clampUnit(input.yaw),
    up: 0,
  };
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function clampUnit(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < -1) return -1;
  if (v > 1) return 1;
  return v;
}

// ---------------------------------------------------------------------------
// ClientShipPredictor
// ---------------------------------------------------------------------------

/**
 * Per-entity predictor. One per locally-controlled ship.
 *
 * The predictor is **pure** with respect to time — it takes a `now`
 * argument from the caller rather than reading `performance.now()`
 * itself. This makes it trivial to test with fake clocks.
 *
 * Lifecycle:
 *   1. Construct with the *server's* initial entity state (the
 *      `enter_system` payload).
 *   2. On every render frame, call `step(now, nextInput)`.
 *   3. On every snapshot, call `reconcile(serverState, lastAppliedSeq)`.
 *
 * Public surface:
 *   - `state()` — read-only view of the predicted state for the
 *     renderer.
 *   - `stats()` — counters the WS layer can surface in a debug HUD
 *     (TASK-57).
 *   - `pendingInputs()` — list of inputs the WS layer still needs
 *     to send to the server.
 *   - `forceSnap()` — drop the queue and adopt a server state
 *     outright (used after a hard reconnect / full resync).
 *
 * The `integrationPlanet` callback is the seam for future tasks
 * (TASK-26) to plug in the streamed heightAt. For v1 we resolve
 * to `undefined` (space regime) which is enough to make the local
 * prediction deterministic for the smoke test.
 */
export class ClientShipPredictor {
  /** Last server-authoritative state we've received. */
  private serverState: SimEntityLite;
  /** Our locally-predicted state. Updated each `step()`. */
  private predictedState: ShipState;
  /** Regime the local integrator should use (copied from server). */
  private regime: FlightRegime;
  /** Ship class — drives integrator tunables. */
  private readonly classId: ProtocolShipClassId;
  /** Per-planet atmospheric context for the local integrator. */
  private readonly integrationPlanet: () => PlanetAtmosphere | undefined;
  /**
   * Queue of inputs since the last server ack. Drained by
   * `reconcile()`. `seq → input`.
   */
  private queue: Map<number, LocalInput> = new Map();
  /** The next seq the predictor will stamp on a fresh input. */
  private nextSeq = 1;
  /** Total inputs integrated since construction. */
  private inputsIntegrated = 0;
  /** Total reconcile events (one per `reconcile()` call). */
  private reconcileCount = 0;
  /** Total rewind-and-replay events. */
  private rewindCount = 0;
  /** Total blend (no-rewind) events. */
  private blendCount = 0;
  /** Total force-snap events (queue overflow / hard resync). */
  private forceSnapCount = 0;
  /** Largest correction distance observed during reconcile (units). */
  private maxCorrectionU = 0;
  /** Largest correction angle observed during reconcile (radians). */
  private maxCorrectionRad = 0;
  /** Optional blend-in-progress (after a force-snap) — see `applyBlend()`. */
  private blend: {
    fromPos: Vec3;
    fromQuat: Quat;
    /** Snap-destination pos (the position we just adopted). */
    targetPos: Vec3;
    targetQuat: Quat;
    startTMs: number;
  } | null = null;

  /**
   * Build the predictor from the server's initial state. `classId`
   * must match the entity's `classId` (we store it so the integrator
   * can resolve the `ShipClass` tunables); callers that don't know
   * the class id yet should use `initFromServerState()` after the
   * first snapshot arrives.
   */
  constructor(args: {
    serverState: SimEntityLite;
    classId: ProtocolShipClassId;
    integrationPlanet?: () => PlanetAtmosphere | undefined;
  }) {
    this.serverState = cloneSimEntityLite(args.serverState);
    this.classId = args.classId;
    this.regime = args.serverState.regime as FlightRegime;
    this.predictedState = cloneShipStateLikeLite(args.serverState);
    this.integrationPlanet = args.integrationPlanet ?? (() => undefined);
  }

  /** Read-only snapshot of the predicted state (renderer reads this). */
  state(): SimEntityLite {
    return liteFromShipState(this.predictedState, this.regime, this.serverState.id);
  }

  /** Read-only server state for the renderer to show "ghost" overlay. */
  serverSnapshot(): SimEntityLite {
    return cloneSimEntityLite(this.serverState);
  }

  /** Inputs the WS layer still needs to flush to the server. */
  pendingInputs(): LocalInput[] {
    return [...this.queue.values()].sort((a, b) => a.seq - b.seq);
  }

  /** Stats for the debug overlay. */
  stats(): {
    queueSize: number;
    nextSeq: number;
    inputsIntegrated: number;
    reconcileCount: number;
    rewindCount: number;
    blendCount: number;
    forceSnapCount: number;
    maxCorrectionU: number;
    maxCorrectionRad: number;
  } {
    return {
      queueSize: this.queue.size,
      nextSeq: this.nextSeq,
      inputsIntegrated: this.inputsIntegrated,
      reconcileCount: this.reconcileCount,
      blendCount: this.blendCount,
      rewindCount: this.rewindCount,
      forceSnapCount: this.forceSnapCount,
      maxCorrectionU: this.maxCorrectionU,
      maxCorrectionRad: this.maxCorrectionRad,
    };
  }

  /**
   * Advance one render frame: stamp a fresh input, push it onto the
   * queue, and integrate the predicted state with `input.dt`.
   *
   * Returns the stamped `LocalInput` so the WS layer can ship it.
   *
   * `now` is wall-clock time in milliseconds — used to track queue
   * age (for the overflow check) and to stamp `tMs`.
   */
  step(args: {
    now: number;
    thrust: number;
    turn: number;
    pitch: number;
    yaw: number;
    dt: number;
  }): LocalInput {
    const input: LocalInput = {
      seq: this.nextSeq,
      tMs: args.now,
      thrust: args.thrust,
      turn: args.turn,
      pitch: args.pitch,
      yaw: args.yaw,
      dt: args.dt,
    };
    this.nextSeq += 1;

    // Always queue the input for delivery to the server (even if
    // we'll later force-snap and drop it).
    this.queue.set(input.seq, input);

    // Cap the queue — drop the oldest entries once we exceed the
    // budget so the rewind path doesn't replay tens of seconds of
    // history on every snapshot.
    this.trimQueue();

    // Local integration uses the shared flight model — no
    // re-implementation. We use the per-frame `input.dt` so a 144 Hz
    // monitor produces a smooth trail even though the server ticks
    // at 20 Hz.
    const shipClass = SHIP_CLASSES[this.classId as ShipClassId];
    if (!shipClass) {
      throw new Error(`ClientShipPredictor: unknown ship class "${this.classId}"`);
    }
    const planet = this.integrationPlanet();
    this.predictedState = integrateShip(
      this.predictedState,
      localInputToShipInput(input),
      Math.max(0, input.dt),
      this.regime,
      shipClass,
      planet,
    );
    this.inputsIntegrated += 1;

    // Apply any in-progress blend overlay (force-snap interpolation).
    this.applyBlend(args.now);

    return input;
  }

  /**
   * Reconcile against a server snapshot.
   *
   * Algorithm (Quake III, task-shaped):
   *   1. Compare `serverState.pos / .quat` to the predicted values.
   *      If both are within tolerance, this was likely a small
   *      physics divergence (e.g. integrator substep rounding) and
   *      we **blend** — gently nudge `predicted` toward `server`
   *      over the next frame. No visible snap.
   *   2. Otherwise **rewind**: copy `serverState` into the
   *      predicted state, then re-apply every input whose `seq`
   *      is strictly greater than `lastAppliedSeq`.
   *   3. If the queue overflows (`MAX_QUEUED_INPUTS` /
   *      `MAX_QUEUED_SECONDS`), drop the queue and force-snap with a
   *      0.1 s blend overlay.
   *
   * Returns a small diagnostic the caller can surface in a debug HUD.
   */
  reconcile(args: { now: number; serverState: SimEntityLite; lastAppliedSeq: number | null }): {
    mode: "blend" | "rewind" | "force-snap";
    correctionU: number;
    correctionRad: number;
  } {
    this.reconcileCount += 1;
    this.serverState = cloneSimEntityLite(args.serverState);
    this.regime = args.serverState.regime as FlightRegime;

    const pos = vecLerp(this.predictedState.pos, this.serverState.pos, 0); // for vec3 access
    const correctionU = distance(pos, this.serverState.pos);
    const correctionRad = angleBetweenQuat(this.predictedState.quat, this.serverState.quat);

    // Track max correction for the debug overlay.
    if (correctionU > this.maxCorrectionU) this.maxCorrectionU = correctionU;
    if (correctionRad > this.maxCorrectionRad) this.maxCorrectionRad = correctionRad;

    // Trim the queue: drop everything ≤ lastAppliedSeq.
    if (args.lastAppliedSeq !== null) {
      for (const seq of [...this.queue.keys()]) {
        if (seq <= args.lastAppliedSeq) this.queue.delete(seq);
      }
    }

    // Decide blend vs rewind.
    const withinTolerance = correctionU < MAX_BLEND_POS_U && correctionRad < MAX_BLEND_ANGLE_RAD;

    if (withinTolerance && this.queue.size === 0) {
      // No pending inputs and we're inside tolerance — adopt the
      // server state outright (cheaper than re-integration).
      this.predictedState = cloneShipStateLikeLite(this.serverState);
      this.blendCount += 1;
      return { mode: "blend", correctionU, correctionRad };
    }

    if (withinTolerance) {
      // Soft blend: keep the predicted state but skew it toward the
      // server state by `correctionU / MAX_BLEND_POS_U` (clamped to
      // [0, 1]). The intent is "visible only if the player is
      // looking for it".
      const t = Math.min(1, correctionU / MAX_BLEND_POS_U);
      this.predictedState = {
        pos: vecLerp(this.predictedState.pos, this.serverState.pos, t * 0.5),
        vel: vecLerp(this.predictedState.vel, this.serverState.vel, t * 0.5),
        quat: quatSlerp(this.predictedState.quat, this.serverState.quat, t * 0.5),
        regime: this.regime,
        onPad: this.serverState.onPad ?? undefined,
      };
      // Then re-apply queued unacked inputs to catch the divergence
      // back up to "now".
      this.replayQueue();
      this.blendCount += 1;
      return { mode: "blend", correctionU, correctionRad };
    }

    // Out of tolerance → rewind.
    if (this.queueOverflowed(args.now)) {
      this.forceSnap(args.now);
      return { mode: "force-snap", correctionU, correctionRad };
    }
    this.predictedState = cloneShipStateLikeLite(this.serverState);
    this.replayQueue();
    this.rewindCount += 1;
    return { mode: "rewind", correctionU, correctionRad };
  }

  /**
   * Drop the queue and adopt a server state. Used after a hard
   * reconnect (TASK-17), or internally when the queue overflows.
   *
   * Captures the *previous* predicted position as the blend's
   * "from" anchor so the next render frame lerps from the
   * pre-snap location toward the adopted server state instead of
   * jumping straight to the new position. The blend target is the
   * just-adopted server state so the integration that runs after
   * `forceSnap()` doesn't drag the blend endpoint around.
   */
  forceSnap(now: number, serverState?: SimEntityLite): void {
    const target = serverState ?? this.serverState;
    const fromPos = { ...this.predictedState.pos };
    const fromQuat = { ...this.predictedState.quat };
    this.serverState = cloneSimEntityLite(target);
    this.regime = target.regime as FlightRegime;
    this.predictedState = cloneShipStateLikeLite(target);
    this.queue.clear();
    this.blend = {
      fromPos,
      fromQuat,
      targetPos: { ...this.predictedState.pos },
      targetQuat: { ...this.predictedState.quat },
      startTMs: now,
    };
    this.forceSnapCount += 1;
  }

  // -----------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------

  /**
   * Re-apply every queued input to the predicted state in `seq`
   * order. Uses each input's own `dt` so the prediction tracks
   * wall-clock time rather than wall-clock-time × (server tick rate /
   * render frame rate). After replay, the queue is *not* cleared —
   * `reconcile()` clears anything `≤ lastAppliedSeq` first.
   */
  private replayQueue(): void {
    const shipClass = SHIP_CLASSES[this.classId as ShipClassId];
    if (!shipClass) {
      throw new Error(`ClientShipPredictor: unknown ship class "${this.classId}"`);
    }
    const planet = this.integrationPlanet();
    const inputs = [...this.queue.values()].sort((a, b) => a.seq - b.seq);
    for (const input of inputs) {
      this.predictedState = integrateShip(
        this.predictedState,
        localInputToShipInput(input),
        Math.max(0, input.dt),
        this.regime,
        shipClass,
        planet,
      );
    }
  }

  /**
   * Drop the oldest queued inputs if the queue exceeds the size or
   * time budgets. We always keep the most recent `MAX_QUEUED_INPUTS`
   * entries.
   */
  private trimQueue(): void {
    if (this.queue.size <= MAX_QUEUED_INPUTS) return;
    const sorted = [...this.queue.keys()].sort((a, b) => a - b);
    const drop = sorted.length - MAX_QUEUED_INPUTS;
    for (let i = 0; i < drop; i++) {
      this.queue.delete(sorted[i]!);
    }
  }

  /**
   * True when the queue has exceeded the size or age budget. The age
   * budget is checked against the OLDEST entry's `tMs`.
   */
  private queueOverflowed(now: number): boolean {
    if (this.queue.size > MAX_QUEUED_INPUTS) return true;
    if (this.queue.size === 0) return false;
    let oldest = Number.POSITIVE_INFINITY;
    for (const input of this.queue.values()) {
      if (input.tMs < oldest) oldest = input.tMs;
    }
    return now - oldest > MAX_QUEUED_SECONDS * 1000;
  }

  /**
   * Apply any in-progress blend overlay. While a blend is active the
   * render-visible state lerps from `blend.from*` to
   * `blend.target*` over `FORCE_SNAP_BLEND_MS` ms. We mutate
   * `predictedState` itself (instead of holding a separate
   * "displayed" state) because the renderer reads `state()` and we
   * want the blend to be one-shot: the next frame the blend is
   * null and the renderer sees the converged state.
   *
   * Concurrent integration continues throughout the blend — the
   * `predictedState` keeps moving with new inputs while the blend
   * overlay briefly overwrites it for display. After the blend
   * completes the integration takes over naturally.
   */
  private applyBlend(now: number): void {
    if (this.blend === null) return;
    const elapsed = now - this.blend.startTMs;
    if (elapsed <= 0) {
      // Take the snap from the blend "from" position.
      this.predictedState.pos = { ...this.blend.fromPos };
      this.predictedState.quat = { ...this.blend.fromQuat };
      return;
    }
    const t = Math.min(1, elapsed / FORCE_SNAP_BLEND_MS);
    if (t >= 1) {
      // Blend complete — restore the live predictedState (which has
      // been integrating concurrently) and clear the overlay.
      this.predictedState.pos = { ...this.blend.targetPos };
      this.predictedState.quat = { ...this.blend.targetQuat };
      this.blend = null;
      return;
    }
    // Lerp from the captured pre-snap anchor to the captured
    // post-snap target. Using the *captured* target means concurrent
    // integration doesn't drag the blend endpoint around.
    this.predictedState.pos = vecLerp(this.blend.fromPos, this.blend.targetPos, t);
    this.predictedState.quat = quatSlerp(this.blend.fromQuat, this.blend.targetQuat, t);
  }
}

// ---------------------------------------------------------------------------
// SimEntityLite — minimal view of an `EntityState` for the predictor.
// ---------------------------------------------------------------------------

/**
 * A trimmed view of `ProtocolEntityState` that exposes the fields
 * the predictor needs. Built from `EntityState` by
 * `simEntityFromWire()` and converted back by
 * `liteFromShipState()` (for the renderer's stats). Keeping this
 * as a distinct type from `ShipState` decouples the wire shape
 * from the integrator's input — we can change either side
 * independently.
 */
export interface SimEntityLite {
  id: string;
  pos: Vec3;
  vel: Vec3;
  quat: Quat;
  regime: "space" | "orbit" | "atmosphere" | "surface";
  hull: number;
  shields: number;
  /** Pad id when landed; `null` otherwise. */
  onPad: string | null;
}

function cloneSimEntityLite(s: SimEntityLite): SimEntityLite {
  return {
    id: s.id,
    pos: { ...s.pos },
    vel: { ...s.vel },
    quat: { ...s.quat },
    regime: s.regime,
    hull: s.hull,
    shields: s.shields,
    onPad: s.onPad,
  };
}

function cloneShipStateLikeLite(s: SimEntityLite): ShipState {
  return {
    pos: { ...s.pos },
    vel: { ...s.vel },
    quat: { ...s.quat },
    regime: s.regime === "atmosphere" || s.regime === "surface" ? s.regime : "space",
    onPad: s.onPad ?? undefined,
  };
}

function liteFromShipState(
  state: ShipState,
  regime: SimEntityLite["regime"],
  id = "",
): SimEntityLite {
  return {
    id,
    pos: { ...state.pos },
    vel: { ...state.vel },
    quat: { ...state.quat },
    regime,
    hull: 0,
    shields: 0,
    onPad: state.onPad ?? null,
  };
}

/**
 * Build a `SimEntityLite` from the protocol's wire shape.
 *
 * @param e  An `EntityState` from an `entity_update` / `state_snapshot`.
 * @param id Optional explicit id (when `e.id` would shadow).
 */
export function simEntityFromWire(e: ProtocolEntityState): SimEntityLite {
  return {
    id: e.id,
    pos: { x: e.pos[0], y: e.pos[1], z: e.pos[2] },
    vel: { x: e.vel[0], y: e.vel[1], z: e.vel[2] },
    quat: { x: 0, y: 0, z: 0, w: 1 }, // Wire shape omits rotation; default to identity.
    regime: e.regime,
    hull: e.hull,
    shields: e.shields,
    onPad: e.onPad,
  };
}

/**
 * TASK-31: light-weight character metadata extracted from a wire
 * `EntityState`. The full per-character snapshot lives in the
 * remote-entity buffer (`simEntityFromWire`); this helper gives the
 * UI a focused view (id + playerId + callsign + onFoot flag) so it
 * can render the on-foot HUD without walking the wire shape itself.
 */
export interface CharacterLite {
  readonly id: string;
  readonly playerId: string | null;
  readonly callsign: string | null;
  readonly onFoot: boolean;
  readonly onPad: string | null;
}

/**
 * TASK-31: extract the character view from a wire entity. Returns
 * `null` when the entity is not a character so the renderer can
 * branch on `null` rather than checking `kind` twice.
 */
export function characterFromWire(e: ProtocolEntityState): CharacterLite | null {
  if (e.kind !== "character") return null;
  return {
    id: e.id,
    playerId: null,
    callsign: e.callsign,
    onFoot: e.onFoot === true,
    onPad: e.onPad,
  };
}

/**
 * TASK-33: project a wire `EntityState` into a client-side
 * `Interactable` (only the kinds the proximity-interact prompt
 * actually displays). Returns `null` when the entity is not
 * interactable so callers can skip them silently.
 *
 * The mapping is intentionally narrow — the per-frame
 * `pickInteractable(...)` walks only entities that registered a
 * client-side interaction kind, so we don't pre-allocate anything
 * for the ships / wrecks / AI the prompt already filters.
 *
 * The `label` field is currently `undefined` for everything except
 * deposits — TASK-37 lands resource types; for v1 the deposit's
 * `label` is filled in by the resource-node generator.
 */
export function interactableFromWire(
  e: ProtocolEntityState,
): { id: string; kind: "deposit" | "ship" | "dock-terminal"; pos: Vec3; label?: string } | null {
  if (e.kind === "deposit") {
    return {
      id: e.id,
      kind: "deposit",
      pos: { x: e.pos[0], y: e.pos[1], z: e.pos[2] },
    };
  }
  if (e.kind === "terminal") {
    return {
      id: e.id,
      kind: "dock-terminal",
      pos: { x: e.pos[0], y: e.pos[1], z: e.pos[2] },
    };
  }
  if (e.kind === "ship") {
    return {
      id: e.id,
      kind: "ship",
      pos: { x: e.pos[0], y: e.pos[1], z: e.pos[2] },
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// ClientCharacterPredictor — TASK-32
// ---------------------------------------------------------------------------

/**
 * Per-entity predictor for an on-foot character. One per locally
 * controlled character; mirrors the `ClientShipPredictor` shape so
 * the WS layer / renderer can reuse the same call sites.
 *
 * Lifecycle:
 *   1. Construct with the *server's* initial character state
 *      (the `enter_system` / `entity_update` payload, projected
 *      into a `CharacterLite` view).
 *   2. On every render frame, call `step(now, nextInput)`. The
 *      predictor stamps `seq`, queues the input for delivery,
 *      and integrates the local predicted state via the shared
 *      `integrateCharacter` (TASK-32).
 *   3. On every snapshot, call `reconcile(serverState, lastAppliedSeq)`.
 *      The predictor compares the server's authoritative position
 *      + velocity to its locally-predicted values; if they agree
 *      to within tolerance the predictor just drains the inputs
 *      the server has acknowledged (`lastAppliedSeq`). Otherwise
 *      it rewinds to the server state and replays the queue.
 *
 * The `heightAt` callback is the same contract the server's
 * `integrateCharacterEntity` uses — production wires the seeded
 * heightmap for the character's `originPlanetId`. Tests pass
 * analytic terrain.
 *
 * The predicted `onGround` field is purely local (the wire shape
 * doesn't carry it) — it's derived each tick from `pos.y`,
 * `vel.y`, and the terrain query so client and server agree.
 */
export class ClientCharacterPredictor {
  /** Last server-authoritative state we've received. */
  private serverState: CharacterPredictorLite;
  /** Our locally-predicted state. Updated each `step()`. */
  private predictedState: CharacterState;
  /** Queue of inputs since the last server ack. */
  private queue: Map<number, LocalInput> = new Map();
  /** The next seq the predictor will stamp on a fresh input. */
  private nextSeq = 1;
  /** Total inputs integrated since construction. */
  private inputsIntegrated = 0;
  /** Total reconcile events (one per `reconcile()` call). */
  private reconcileCount = 0;
  /** Total rewind-and-replay events. */
  private rewindCount = 0;
  /** Total blend (no-rewind) events. */
  private blendCount = 0;
  /** Total force-snap events (queue overflow / hard resync). */
  private forceSnapCount = 0;
  /** Largest correction distance observed during reconcile (units). */
  private maxCorrectionU = 0;
  /** Terrain query — the local integrator's `heightAt`. */
  private readonly heightAt: (x: number, z: number) => number;

  /**
   * Build the predictor from the server's initial character state.
   * `heightAt` is the same callback the server uses; production
   * wires the per-planet heightmap, tests pass analytic terrain.
   */
  constructor(args: {
    serverState: CharacterPredictorLite;
    heightAt: (x: number, z: number) => number;
  }) {
    this.serverState = cloneCharacterLite(args.serverState);
    this.heightAt = args.heightAt;
    // Server doesn't transmit `onGround`. We derive it from the
    // initial position + velocity: a character is on the ground
    // when `vel.y` is close to 0 AND `pos.y` sits within 1 cm of
    // the terrain. The 1 cm slack accommodates the same ground
    // tolerance the integrator uses to clamp `pos.y` to the
    // terrain after landing.
    const terrainY = args.heightAt(args.serverState.pos.x, args.serverState.pos.z);
    const onGround =
      Math.abs(args.serverState.vel.y) < 0.01 && Math.abs(args.serverState.pos.y - terrainY) < 0.01;
    this.predictedState = {
      pos: { x: args.serverState.pos.x, y: args.serverState.pos.y, z: args.serverState.pos.z },
      vel: { x: args.serverState.vel.x, y: args.serverState.vel.y, z: args.serverState.vel.z },
      quat: {
        x: args.serverState.quat.x,
        y: args.serverState.quat.y,
        z: args.serverState.quat.z,
        w: args.serverState.quat.w,
      },
      onGround,
    };
  }

  /** Read-only snapshot of the predicted state (renderer reads this). */
  state(): CharacterPredictorLite {
    return liteFromCharacterState(this.predictedState, this.serverState);
  }

  /** Read-only server state for the renderer to show "ghost" overlay. */
  serverSnapshot(): CharacterPredictorLite {
    return cloneCharacterLite(this.serverState);
  }

  /** Inputs the WS layer still needs to flush to the server. */
  pendingInputs(): LocalInput[] {
    return [...this.queue.values()].sort((a, b) => a.seq - b.seq);
  }

  /** Stats for the debug overlay (TASK-57). */
  stats(): {
    queueSize: number;
    nextSeq: number;
    inputsIntegrated: number;
    reconcileCount: number;
    rewindCount: number;
    blendCount: number;
    forceSnapCount: number;
    maxCorrectionU: number;
  } {
    return {
      queueSize: this.queue.size,
      nextSeq: this.nextSeq,
      inputsIntegrated: this.inputsIntegrated,
      reconcileCount: this.reconcileCount,
      blendCount: this.blendCount,
      rewindCount: this.rewindCount,
      forceSnapCount: this.forceSnapCount,
      maxCorrectionU: this.maxCorrectionU,
    };
  }

  /**
   * Advance one render frame: stamp a fresh input, push it onto
   * the queue, and integrate the predicted state with `input.dt`.
   * Returns the stamped `LocalInput` so the WS layer can ship it.
   */
  step(args: {
    now: number;
    thrust: number;
    turn: number;
    pitch: number;
    yaw: number;
    fire: boolean;
    action: string | null;
    dt: number;
  }): LocalInput {
    const input: LocalInput = {
      seq: this.nextSeq,
      tMs: args.now,
      thrust: args.thrust,
      turn: args.turn,
      pitch: args.pitch,
      yaw: args.yaw,
      fire: args.fire,
      dt: args.dt,
      action: args.action,
    };
    this.nextSeq += 1;
    this.queue.set(input.seq, input);
    this.trimQueue();

    // Map wire → character input and integrate locally.
    const characterInput = localInputToCharacterInput(input);
    this.predictedState = integrateCharacter(
      this.predictedState,
      characterInput,
      Math.max(0, input.dt),
      this.heightAt,
    );
    this.inputsIntegrated += 1;
    return input;
  }

  /**
   * Reconcile against a server snapshot. Returns a small
   * diagnostic the caller can surface in a debug HUD.
   *
   * The character uses the same Quake-III recipe as the ship:
   *   1. Compare `serverState.pos / .vel / .quat` to the
   *      predicted values. If both are within tolerance, this
   *      was likely a small physics divergence and we just
   *      drain the inputs the server has acknowledged.
   *   2. Otherwise **rewind**: copy `serverState` into the
   *      predicted state, then re-apply every input whose
   *      `seq` is strictly greater than `lastAppliedSeq`.
   *   3. If the queue overflows, drop the queue and
   *      force-snap outright (no replay).
   */
  reconcile(args: {
    now: number;
    serverState: CharacterPredictorLite;
    lastAppliedSeq: number | null;
  }): {
    mode: "blend" | "rewind" | "force-snap";
    correctionU: number;
  } {
    this.reconcileCount += 1;
    this.serverState = cloneCharacterLite(args.serverState);

    const correctionU = distance(this.predictedState.pos, this.serverState.pos);
    if (correctionU > this.maxCorrectionU) this.maxCorrectionU = correctionU;

    // Drain inputs ≤ lastAppliedSeq from the queue.
    if (args.lastAppliedSeq !== null) {
      for (const seq of [...this.queue.keys()]) {
        if (seq <= args.lastAppliedSeq) this.queue.delete(seq);
      }
    }

    const withinPosTolerance = correctionU < MAX_BLEND_POS_U;
    const withinQuatTolerance =
      angleBetweenQuat(this.predictedState.quat, this.serverState.quat) < MAX_BLEND_ANGLE_RAD;

    if (withinPosTolerance && withinQuatTolerance && this.queue.size === 0) {
      // Adopt the server state outright (cheaper than re-integration).
      this.predictedState = cloneCharacterStateLikeLite(this.serverState, this.heightAt);
      this.blendCount += 1;
      return { mode: "blend", correctionU };
    }

    if (withinPosTolerance && withinQuatTolerance) {
      // Soft blend — keep the predicted state but replay the queue
      // to catch divergence up to "now".
      this.replayQueue();
      this.blendCount += 1;
      return { mode: "blend", correctionU };
    }

    // Out of tolerance → rewind.
    if (this.queueOverflowed(args.now)) {
      this.forceSnap(args.serverState);
      return { mode: "force-snap", correctionU };
    }
    this.predictedState = cloneCharacterStateLikeLite(this.serverState, this.heightAt);
    this.replayQueue();
    this.rewindCount += 1;
    return { mode: "rewind", correctionU };
  }

  /**
   * Drop the queue and adopt a server state. Used after a hard
   * reconnect (TASK-17) or internally when the queue overflows.
   */
  forceSnap(serverState?: CharacterPredictorLite): void {
    const target = serverState ?? this.serverState;
    this.serverState = cloneCharacterLite(target);
    this.predictedState = cloneCharacterStateLikeLite(target, this.heightAt);
    this.queue.clear();
    this.forceSnapCount += 1;
  }

  // -----------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------

  /** Re-apply every queued input in `seq` order. */
  private replayQueue(): void {
    const inputs = [...this.queue.values()].sort((a, b) => a.seq - b.seq);
    for (const input of inputs) {
      const characterInput = localInputToCharacterInput(input);
      this.predictedState = integrateCharacter(
        this.predictedState,
        characterInput,
        Math.max(0, input.dt),
        this.heightAt,
      );
    }
  }

  /** Drop the oldest entries past `MAX_QUEUED_INPUTS`. */
  private trimQueue(): void {
    if (this.queue.size <= MAX_QUEUED_INPUTS) return;
    const sorted = [...this.queue.keys()].sort((a, b) => a - b);
    const drop = sorted.length - MAX_QUEUED_INPUTS;
    for (let i = 0; i < drop; i++) {
      this.queue.delete(sorted[i]!);
    }
  }

  /** True when the queue has exceeded the size or age budget. */
  private queueOverflowed(now: number): boolean {
    if (this.queue.size > MAX_QUEUED_INPUTS) return true;
    if (this.queue.size === 0) return false;
    let oldest = Number.POSITIVE_INFINITY;
    for (const input of this.queue.values()) {
      if (input.tMs < oldest) oldest = input.tMs;
    }
    return now - oldest > MAX_QUEUED_SECONDS * 1000;
  }
}

/**
 * TASK-32: trimmed view of a wire `EntityState` for the character
 * predictor. Carries only the fields the predictor reads —
 * position / velocity / rotation plus `onFoot` for the
 * `kind === 'character'` discriminator.
 *
 * Distinct from the TASK-31 `CharacterLite` (which carries the
 * HUD-only metadata `playerId` + `callsign`) because the
 * predictor needs the simulator fields the HUD doesn't.
 */
export interface CharacterPredictorLite {
  readonly id: string;
  readonly pos: Vec3;
  readonly vel: Vec3;
  readonly quat: Quat;
  readonly onFoot: boolean;
  readonly onPad: string | null;
}

function cloneCharacterLite(s: CharacterPredictorLite): CharacterPredictorLite {
  return {
    id: s.id,
    pos: { ...s.pos },
    vel: { ...s.vel },
    quat: { ...s.quat },
    onFoot: s.onFoot,
    onPad: s.onPad,
  };
}

function cloneCharacterStateLikeLite(
  s: CharacterPredictorLite,
  _heightAt: (x: number, z: number) => number,
): CharacterState {
  // The server doesn't transmit `onGround`. We initialise to
  // `false` and let the next `step()` resolve it via the
  // integrator (which calls `heightAt` to decide). This is
  // safe because the first `step()` runs immediately after a
  // reconcile on the renderer frame.
  return {
    pos: { ...s.pos },
    vel: { ...s.vel },
    quat: { ...s.quat },
    onGround: false,
  };
}

function liteFromCharacterState(
  state: CharacterState,
  server: CharacterPredictorLite,
): CharacterPredictorLite {
  return {
    id: server.id,
    pos: { ...state.pos },
    vel: { ...state.vel },
    quat: { ...state.quat },
    onFoot: server.onFoot,
    onPad: server.onPad,
  };
}

/**
 * Convert a `LocalInput` into the `CharacterInput` shape the
 * shared character physics accepts. Centralised so the predictor
 * and the wire-test cases agree on the mapping. Mirrors the
 * server's `wireInputToCharacterInput`.
 */
export function localInputToCharacterInput(input: LocalInput): CharacterInput {
  return wireInputToCharacterInput({
    thrust: clamp01(input.thrust),
    turn: clampUnit(input.turn),
    pitch: clampUnit(input.pitch),
    fire: Boolean(input.fire),
    action: input.action ?? null,
  });
}

// ---------------------------------------------------------------------------
// RemoteEntityBuffer
// ---------------------------------------------------------------------------

/**
 * Per-remote-entity interpolation ring. Stores the last
 * `REMOTE_BUFFER_CAPACITY` snapshots; renders the entity at
 * `now - INTERP_DELAY_MS` by lerping position and slerping rotation
 * between the two surrounding snapshots.
 *
 * On buffer underrun (render time precedes the oldest snapshot)
 * the buffer holds position at the oldest snapshot and sets the
 * `stale` flag — the renderer dims the impostor instead of
 * teleporting.
 *
 * "Stale" means the newest snapshot is older than `REMOTE_STALE_MS`
 * relative to the render clock — the renderer freezes the impostor
 * and dims it. This is purely client-side; no protocol change.
 */
export class RemoteEntityBuffer {
  /** Ring of `{tMs, state}` snapshots, ordered oldest → newest. */
  private ring: Array<{ tMs: number; state: SimEntityLite }> = [];
  /** Render-clock anchor the renderer uses to compute render time. */
  private renderOrigin: number | null = null;

  /**
   * Push a fresh snapshot. The buffer drops any entries older than
   * `INTERP_DELAY_MS` *plus* a small safety margin, but never drops
   * the newest entry.
   *
   * `tMs` should be the wall-clock time the snapshot was received
   * (NOT the server tick — those don't move with the client clock
   * and would break the interpolation window under drift).
   */
  push(tMs: number, state: SimEntityLite): void {
    if (this.renderOrigin === null) this.renderOrigin = tMs;
    // Insertion sort by tMs (the buffer is small enough that O(n)
    // is fine).
    let inserted = false;
    for (let i = 0; i < this.ring.length; i++) {
      if (this.ring[i]!.tMs > tMs) {
        this.ring.splice(i, 0, { tMs, state });
        inserted = true;
        break;
      }
    }
    if (!inserted) this.ring.push({ tMs, state });
    // Drop oldest entries beyond capacity.
    while (this.ring.length > REMOTE_BUFFER_CAPACITY) {
      this.ring.shift();
    }
  }

  /**
   * Sample the remote's state at the render time `now - INTERP_DELAY_MS`.
   *
   * Returns:
   *   - `{state, stale: false}` when interpolation succeeded.
   *   - `{state, stale: true}` when the buffer under-ran (oldest
   *     snapshot is newer than the requested time) — the renderer
   *     should dim and freeze.
   *   - `{state: null, stale: true}` when the buffer is empty.
   */
  sample(now: number): { state: SimEntityLite | null; stale: boolean } {
    if (this.ring.length === 0) return { state: null, stale: true };
    const targetT = now - INTERP_DELAY_MS;
    const newest = this.ring[this.ring.length - 1]!;
    // Stale check — newest snapshot is older than REMOTE_STALE_MS.
    const stale = now - newest.tMs > REMOTE_STALE_MS;

    // Buffer underrun: requested time precedes the oldest snapshot.
    if (targetT < this.ring[0]!.tMs) {
      // Freeze on the oldest snapshot. The renderer can still see
      // the impostor; just at the wrong moment.
      return { state: cloneSimEntityLite(this.ring[0]!.state), stale: true };
    }

    // Target time after the newest snapshot — future prediction
    // would be cheating; clamp to newest (stale=true so the renderer
    // dims).
    if (targetT >= newest.tMs) {
      return { state: cloneSimEntityLite(newest.state), stale };
    }

    // Find the bracketing pair. Walk from the newest backwards
    // because that's the most common case (rendering at the buffer
    // tail). Linear scan; ring is ≤ 16 entries.
    let upper = this.ring[this.ring.length - 1]!;
    let lower = this.ring[this.ring.length - 1]!;
    for (let i = this.ring.length - 1; i >= 0; i--) {
      const entry = this.ring[i]!;
      if (entry.tMs <= targetT) {
        lower = entry;
        upper = i + 1 < this.ring.length ? this.ring[i + 1]! : entry;
        break;
      }
    }
    const span = upper.tMs - lower.tMs;
    const t = span > 0 ? (targetT - lower.tMs) / span : 0;
    return {
      state: interpolateEntity(lower.state, upper.state, t),
      stale: false,
    };
  }

  /** Number of snapshots currently in the buffer. */
  size(): number {
    return this.ring.length;
  }

  /** Clear the buffer (used on disconnect). */
  clear(): void {
    this.ring = [];
    this.renderOrigin = null;
  }
}

/**
 * Lerp position + slerp rotation between two snapshots. Velocity,
 * hull, shields, etc. are copied from the *upper* (newer) snapshot
 * so the renderer sees the latest non-motion values immediately
 * rather than smearing stale numbers across the buffer.
 */
function interpolateEntity(a: SimEntityLite, b: SimEntityLite, t: number): SimEntityLite {
  return {
    id: b.id,
    pos: vecLerp(a.pos, b.pos, t),
    vel: vecLerp(a.vel, b.vel, t),
    quat: quatSlerp(a.quat, b.quat, t),
    regime: b.regime,
    hull: b.hull,
    shields: b.shields,
    onPad: b.onPad,
  };
}

// ---------------------------------------------------------------------------
// applyEntityUpdateToBuffer
// ---------------------------------------------------------------------------

/**
 * Apply one `entity_update` frame to a map of remote buffers.
 * Returns a fresh map (callers update their state in place).
 *
 * - Skips the owning player's entity (caller manages that via the
 *   predictor).
 * - Mutates the buffer for every other entity that appears in the
 *   frame; entities missing from the frame are not touched (the
 *   remote buffer keeps its previous snapshots until `clear()` is
 *   called by the WS layer on conn-close).
 *
 * Convenience helper for the WS layer; pure (no hidden state).
 */
export function applyEntityUpdateToBuffer(args: {
  tMs: number;
  entities: readonly ProtocolEntityState[];
  ownEntityId: string | null;
  remotes: ReadonlyMap<string, RemoteEntityBuffer>;
}): Map<string, RemoteEntityBuffer> {
  const out = new Map(args.remotes);
  for (const e of args.entities) {
    if (e.id === args.ownEntityId) continue;
    let buf = out.get(e.id);
    if (buf === undefined) {
      buf = new RemoteEntityBuffer();
      out.set(e.id, buf);
    }
    buf.push(args.tMs, simEntityFromWire(e));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------

function distance(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function angleBetweenQuat(a: Quat, b: Quat): number {
  // Compute the angle from the quaternion dot product. We use
  // |dot| so we always report the short-arc angle, regardless of
  // which side of the rotation the quaternions sit on.
  let dot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  if (dot < 0) dot = -dot;
  if (dot > 1) dot = 1;
  // Two quaternions with dot=1 are identical; dot=-1 are 180° apart
  // (axis ambiguous). The angle is `2 * acos(dot)`.
  return 2 * Math.acos(dot);
}
