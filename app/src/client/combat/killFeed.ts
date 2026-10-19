/**
 * Client-side kill feed — TASK-47.
 *
 * A transient top-center HUD widget that surfaces the last five
 * kills in the local player's system. Each entry carries:
 *
 *   - `attackerName` — display name (player callsign or AI callsign)
 *   - `targetName` — display name (player callsign or AI callsign)
 *   - `weapon` — `'laser' | 'missile'`
 *   - `isPvP` — `true` when both attacker and target are players
 *     (white text), `false` for player-vs-AI kills (grey text per
 *     the spec).
 *   - `pushedAt` — wall-clock ms timestamp
 *   - `expiresAt` — pushedAt + 10 s (matches the spec TTL)
 *
 * Entries flow in from `combat_event { kind: 'kill' }` frames.
 * The wire shape is unchanged from TASK-42 — the kill feed is a
 * pure rendering layer on top of events the server already
 * broadcasts. The store resolves entity-id ↔ callsign through the
 * Drift client's call-sign resolver callback; the resolver knows
 * the roster of player callsigns (from presence frames) and AI
 * callsigns (from entity_update frames), so a callsign display
 * always lands on a human-readable label.
 *
 * ## Position
 *
 * The component renders in the **top-center** slot — different
 * from the existing top-right ToastStack (transient toasts) and
 * the top-left ChatLog (text chat). TASK-50's HUD layout spec
 * carves this slot out as `top-center / kill feed`; this task
 * fills it.
 *
 * @see ../../server/shard/combat.ts for the kill-event source.
 * @see ../components/KillFeed.tsx for the React renderer.
 */

import type { PayloadFor } from "@shared/protocol/index.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of kill-feed entries shown at once. Spec: 5. */
export const KILL_FEED_MAX_ENTRIES = 5;

/** TTL per entry in ms. Spec: 10 s. */
export const KILL_FEED_TTL_MS = 10_000;

/** Stable per-player id type alias. */
export type PlayerId = string;

/** Callsign resolver callback. Returns `null` when unknown. */
export type CallsignResolver = (entityId: string) => string | null;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A single live kill-feed row. Exposed to the React component so
 * the renderer can style / animate entries without a second store
 * lookup.
 */
export interface KillFeedEntry {
  /** Monotonic id so React keys are stable across re-renders. */
  readonly id: number;
  /** Display name of the attacker (player or AI callsign). */
  readonly attackerName: string;
  /** Display name of the victim (player or AI callsign). */
  readonly targetName: string;
  /** Weapon used to land the kill (determines the separator glyph). */
  readonly weapon: "laser" | "missile";
  /** True when both source + target are players. False = player-vs-AI. */
  readonly isPvP: boolean;
  /** Wall-clock ms timestamp at which the kill was broadcast. */
  readonly pushedAt: number;
  /** Wall-clock ms timestamp at which the entry should fade. */
  readonly expiresAt: number;
}

// ---------------------------------------------------------------------------
// KillFeedStore
// ---------------------------------------------------------------------------

/**
 * Pure-TS kill-feed store. Subscribes via `subscribe(listener)`;
 * the WS client pushes kill events through `applyKillEvent` and
 * the HUD polls via `snapshot()` (or subscribes for finer-grained
 * re-renders).
 *
 * The store handles TTL reaping automatically on every `snapshot`
 * read — the renderer doesn't have to run its own garbage-
 * collection cycle. This keeps the React layer dumb (just
 * re-renders on `useSyncExternalStore`) and the GC concerns in
 * the store.
 */
export class KillFeedStore {
  private entries: KillFeedEntry[] = [];
  private listeners = new Set<() => void>();
  private nextEntryId = 1;

  // ---- Reads --------------------------------------------------------------

  /** Live entries (post-reap) for the renderer. */
  getEntries(): readonly KillFeedEntry[] {
    return this.entries;
  }

  /** Stable snapshot for React `useSyncExternalStore`. */
  snapshot(nowMs?: number): readonly KillFeedEntry[] {
    this.reapExpired(nowMs);
    return this.entries;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // ---- Mutators -----------------------------------------------------------

  /**
   * Accept a `combat_event { kind: 'kill' }` payload from the
   * WS layer and add an entry to the feed.
   *
   * Source/target id resolution happens through the caller-
   * supplied `resolver` so the store stays resolution-policy
   * agnostic: production threads a resolver that knows the
   * full roster (player callsigns + AI callsigns), tests
   * pass an identity map.
   *
   * `isPvP` is derived by asking the caller-supplied `isPlayerId`
   * predicate. Production uses the in-system `presence` roster
   * (TASK-15) — every entry whose id matches a presence player
   * is a PvP target, every other entry is an AI target. Tests
   * pass `(_id) => true` or `(_id) => false` for unit control.
   *
   * `weapon` is inferred from a preceding recent `fire_ok` /
   * `combat_event { kind: 'hit' }` to keep the feed separator
   * informative. The kill event itself doesn't carry the
   * weapon (TASK-42 / TASK-46 era); we default to `'laser'`
   * when no upstream signal arrives. A future protocol bump
   * can add the field.
   *
   * `nowMs` defaults to `Date.now()`; tests inject a fake clock.
   */
  applyKillEvent(
    event: PayloadFor<"combat_event"> & { kind: "kill" },
    args: {
      resolver: CallsignResolver;
      isPlayerId: (id: string) => boolean;
      weapon?: "laser" | "missile";
      nowMs?: number;
    },
  ): void {
    const now = args.nowMs ?? Date.now();
    const attackerName = args.resolver(event.attacker) ?? event.attacker;
    const targetName = args.resolver(event.target) ?? event.target;
    const isPvP = args.isPlayerId(event.attacker) && args.isPlayerId(event.target);
    const weapon = args.weapon ?? "laser";

    const entry: KillFeedEntry = {
      id: this.nextEntryId++,
      attackerName,
      targetName,
      weapon,
      isPvP,
      pushedAt: now,
      expiresAt: now + KILL_FEED_TTL_MS,
    };
    this.entries.push(entry);
    // Cap at KILL_FEED_MAX_ENTRIES (the oldest entry drops).
    if (this.entries.length > KILL_FEED_MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - KILL_FEED_MAX_ENTRIES);
    }
    this.emit();
  }

  /**
   * Force-reap expired entries. Called automatically by
   * `snapshot()` so the renderer doesn't need its own timer.
   * Returns the number of entries removed (zero when nothing
   * expired) so the renderer can also drive a manual reap on
   * a slow tick.
   */
  reapExpired(nowMs: number = Date.now()): number {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.expiresAt > nowMs);
    const removed = before - this.entries.length;
    if (removed > 0) this.emit();
    return removed;
  }

  /** Clear the feed. Test seam — never called in production. */
  clear(): void {
    if (this.entries.length === 0) return;
    this.entries = [];
    this.emit();
  }

  // ---- Internals ----------------------------------------------------------

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Faulty listeners must not break the store.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (extracted for testability)
// ---------------------------------------------------------------------------

/**
 * Format a single feed entry as the spec calls for
 * (`"A ▸ weapon ▸ B"`). The middle glyph is the weapon name
 * (`LASER` / `MISSILE`) so the spec line is reproduced verbatim.
 * Used by `KillFeed.tsx` and the unit tests.
 */
export function formatKillLine(entry: KillFeedEntry): string {
  const w = entry.weapon === "laser" ? "LASER" : "MISSILE";
  return `${entry.attackerName} \u25b8 ${w} \u25b8 ${entry.targetName}`;
}

/**
 * Stable id counter. Exposed for tests that need to seed entries
 * with deterministic ids (so component snapshots compare
 * identity-stable across re-renders).
 */
export function nextKillFeedId(): number {
  return ++lastKillFeedId;
}

// File-scope counter — survives HMR refreshes so re-importing
// in dev doesn't reset the id space.
let lastKillFeedId = 0;
