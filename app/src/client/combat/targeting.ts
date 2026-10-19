/**
 * Client-side targeting state — TASK-44.
 *
 * Two parallel concerns live here:
 *
 *   1. **Target box data** (HUD readout). The server is the source
 *      of truth — `target_locked` / `target_released` /
 *      `target_update` frames drive the cache. The store keeps the
 *      last live stats (shields / hull / bearing / range /
 *      callsign / classId) so the HUD renders inside one render
 *      cycle without a server roundtrip per paint.
 *
 *   2. **Threat pings**. `combat_event { kind: 'hit' | 'damaged' |
 *      'destroyed' }` frames with `source.id !== self` push a
 *      threat-ping entry with the attacker's bearing math. The HUD
 *      reads `threatPings` and renders a red arc indicator pointed
 *      at the strongest recent attacker; the entry auto-fades after
 *      3 s (TASK-44 acceptance). Multiple attackers → the most
 *      recent < 5 s source wins.
 *
 * The store also exposes `lock()` / `release()` helpers that wrap
 * the WS client's `sendTargetLock` so the React layer can call a
 * typed hook (`useTargeting`).
 *
 * @see ../../server/shard/targeting.ts for the server-side lock
 *      state + auto-release walk.
 */

import type { PayloadFor, ProtocolCombatEvent } from "@shared/protocol/index.js";
import {
  THREAT_PING_RECENT_MS,
  THREAT_PING_TTL_MS,
  bearingDegrees,
  forwardVecFromQuat,
} from "@shared/targeting.js";

import type { SimEntityLite } from "../net/prediction.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The locked-target row the HUD renders. Lives in cache for as long
 * as the server holds the lock — `null` when no target is locked
 * (or the lock has just been released).
 */
export interface TargetBoxEntry {
  /** Server-assigned target id (matches the entity's id on snapshots). */
  readonly targetId: string;
  /** Callsign (player) or null (AI). */
  readonly callsign: string | null;
  /** Ship class id when known; null for AI without class labels. */
  readonly classId: string | null;
  /** Hull HP at last `target_update`. */
  readonly hull: number;
  /** Shield HP at last `target_update`. */
  readonly shields: number;
  /** Live range (m) at last `target_update`. */
  readonly range: number;
  /**
   * Live bearing (degrees, positive = right of forward, negative =
   * left, on a wrap to `[-180, 180]`). Updated every snapshot.
   */
  readonly bearing: number;
  /** Wall-clock ms when the lock was acquired. */
  readonly lockedAt: number;
}

/**
 * A live threat ping — drawn as a red arc on the HUD pointing at
 * the attacker. Auto-expires after `THREAT_PING_TTL_MS`.
 */
export interface ThreatPing {
  /** Stable id so React keys don't churn when multiple pings overlap. */
  readonly id: number;
  /** Entity id of the attacker (the one who shot at us). */
  readonly sourceId: string;
  /** Callsign of the attacker when known; null for AI. */
  readonly sourceCallsign: string | null;
  /** Bearing (degrees) from the local ship's forward to the attacker. */
  readonly bearing: number;
  /** Wall-clock ms when the ping was raised. */
  readonly ts: number;
}

// ---------------------------------------------------------------------------
// TargetingStore
// ---------------------------------------------------------------------------

/**
 * Pure-TS store. React components subscribe via the `subscribe`
 * hook; the WS client feeds events through `applyLocked` /
 * `applyTargetUpdate` / `applyReleased` / `applyCombatEvent` /
 * `applyEntityUpdate`.
 */
export class TargetingStore {
  private locked: TargetBoxEntry | null = null;
  private threatPings: ThreatPing[] = [];
  private listeners = new Set<() => void>();
  private nextPingId = 1;

  // ---- Reads --------------------------------------------------------------

  /** Snapshot of the current locked target (or `null`). */
  getLocked(): TargetBoxEntry | null {
    return this.locked;
  }

  /** Snapshot of the live threat-ping list. UI code filters by TTL. */
  getThreatPings(): readonly ThreatPing[] {
    return this.threatPings;
  }

  /** Stable snapshot so React's `useSyncExternalStore` can dedupe renders. */
  snapshot(): { locked: TargetBoxEntry | null; threatPings: readonly ThreatPing[] } {
    return { locked: this.locked, threatPings: this.threatPings };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ---- Lock state mutators ----------------------------------------------

  /**
   * Accept a `target_locked` ack from the server. Sets the locked-
   * target row to a snapshot of the data the server stamped; the
   * next `target_update` will refresh live stats.
   */
  applyLocked(payload: PayloadFor<"target_locked">): void {
    this.locked = {
      targetId: payload.targetId,
      callsign: payload.callsign,
      classId: null, // server ack doesn't carry classId; the next `target_update` will.
      hull: 0,
      shields: 0,
      range: payload.range,
      bearing: payload.bearing,
      lockedAt: payload.lockedAt,
    };
    this.emit();
  }

  /**
   * Accept a `target_released` ack. Clears the locked row.
   */
  applyReleased(_payload: PayloadFor<"target_released">): void {
    this.locked = null;
    this.emit();
  }

  /**
   * Accept a `target_update` frame. The server pushes these every
   * snapshot / auto-release tick so the box's hull / shields /
   * range / bearing stay live.
   */
  applyTargetUpdate(payload: PayloadFor<"target_update">): void {
    if (!this.locked || this.locked.targetId !== payload.targetId) {
      // The lock has been released (server didn't echo a release
      // frame yet) or the targetId races. Drop silently — the
      // next `target_locked` re-stamps.
      return;
    }
    this.locked = {
      targetId: payload.targetId,
      callsign: payload.callsign ?? null,
      classId: (payload.classId as string | null) ?? null,
      hull: payload.hull ?? 0,
      shields: payload.shields ?? 0,
      range: payload.range ?? 0,
      bearing: payload.bearing ?? 0,
      lockedAt: this.locked.lockedAt,
    };
    this.emit();
  }

  // ---- Threat-ping mutators ----------------------------------------------

  /**
   * Accept a `combat_event` frame. Pushes a threat ping when:
   *   - the event kind is `'hit' | 'damaged' | 'destroyed'`,
   *   - the source kind is `'player' | 'ai'` (the wire schema),
   *   - the source id is NOT the local player's id.
   *
   * `localPlayerId` is the callsign-resolved id of the local player
   * (passed in by the caller — typically the `DriftClient`'s
   * resolved `playerId`).
   */
  applyCombatEvent(event: ProtocolCombatEvent, localPlayerId: string | null): void {
    if (!localPlayerId) return;
    if (event.kind !== "hit" && event.kind !== "damaged" && event.kind !== "destroyed") {
      return;
    }
    let sourceId: string;
    let targetId: string;
    if (event.kind === "hit") {
      sourceId = event.attacker;
      targetId = event.target;
    } else {
      sourceId = event.source.id;
      targetId = event.target;
    }
    if (sourceId === localPlayerId) return; // self-damage
    // Compute the source's bearing relative to the local ship, when
    // we have entity data; otherwise the bearing defaults to 0
    // (the HUD can still render a "recently hit" pulse).
    const now = Date.now();
    const bearing = this.computeBearingFromSource(sourceId) ?? 0;
    const ping: ThreatPing = {
      id: this.nextPingId++,
      sourceId,
      sourceCallsign: null,
      bearing,
      ts: now,
    };
    // Drop expired pings + keep at most 8 to bound memory.
    this.threatPings = this.threatPings
      .filter((p) => now - p.ts < THREAT_PING_TTL_MS)
      .concat([ping])
      .slice(-8);
    void targetId;
    this.emit();
  }

  /**
   * Garbage-collect expired pings. Call from a render loop or a
   * periodic tick (the HUD's `requestAnimationFrame` driver is fine).
   */
  reap(nowMs: number = Date.now()): void {
    const before = this.threatPings.length;
    this.threatPings = this.threatPings.filter((p) => nowMs - p.ts < THREAT_PING_TTL_MS);
    if (this.threatPings.length !== before) {
      this.emit();
    }
  }

  /**
   * Pick the strongest recent ping per the spec (5 s window,
   * most recent attacker). Returns `null` when no recent ping
   * exists.
   */
  strongestRecent(nowMs: number = Date.now()): ThreatPing | null {
    const recent = this.threatPings.filter((p) => nowMs - p.ts < THREAT_PING_RECENT_MS).slice(-1);
    return recent[0] ?? null;
  }

  /** Test seam. */
  reset(): void {
    this.locked = null;
    this.threatPings = [];
    this.emit();
  }

  // ---- Internal ----------------------------------------------------------

  private computeBearingFromSource(_sourceId: string): number | null {
    // The full bearing math needs the source entity's current
    // position + the local ship's yaw. The HUD reads the local
    // ship's yaw from `prediction.shipState.quat` and the source
    // entity from `prediction.remoteEntityBuffer` — see
    // `useTargeting` for the bridge that fills this in from the
    // live entity store.
    //
    // We fall back to `null` (centred indicator) when the source
    // position is unknown so the toast still surfaces.
    return null;
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // swallow — faulty listener must not break the loop
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Threat-ping selection (multiple sources, 5 s window)
// ---------------------------------------------------------------------------

/**
 * Pure helper: pick the strongest recent attacker from a list of
 * threat pings. Used by tests + the HUD to drive the radial arc
 * indicator.
 *
 * "Strongest" in v1 means "most recent" (TASK-44 acceptance: "the
 * strongest recent source (last 5 s) wins the indicator"). We sort
 * by `ts` descending and return the newest within the 5 s window.
 */
export function selectStrongestPing(
  pings: readonly ThreatPing[],
  nowMs: number,
): ThreatPing | null {
  let best: ThreatPing | null = null;
  for (const ping of pings) {
    if (nowMs - ping.ts >= THREAT_PING_RECENT_MS) continue;
    if (!best || ping.ts > best.ts) best = ping;
  }
  return best;
}

/**
 * Pure bearing helper: compute the attacker-bearing from the local
 * ship's yaw + the attacker's position. Mirrors the server-side
 * `bearingDegrees` math so the renderer's arc indicator points the
 * same way the server's `target_update.bearing` says it does.
 *
 * Returns `null` when the attacker position is unknown.
 */
export function bearingToAttacker(
  ship: SimEntityLite | null,
  attackerPos: { x: number; y: number; z: number } | null,
  shipPos: { x: number; y: number; z: number } | null,
): number | null {
  if (!ship || !attackerPos || !shipPos) return null;
  // Build a synthetic SimEntity to reuse the shared bearing math.
  // We need only `pos` + `quat` from the ship; the rest defaults to
  // a blank.
  const fakeShip = {
    pos: shipPos,
    quat: ship.quat,
  } as unknown as Parameters<typeof bearingDegrees>[0];
  const fakeTarget = {
    pos: attackerPos,
  } as unknown as Parameters<typeof bearingDegrees>[1];
  return bearingDegrees(fakeShip, fakeTarget);
}

/**
 * Re-export the forward helper for callers that need the raw
 * forward unit vector (the HUD overlay render needs it to align the
 * arc with the ship's nose orientation).
 */
export { forwardVecFromQuat };
