/**
 * Client kill-feed state (TASK-47) — the persistent kill feed (top-center,
 * last 5 kills, 10 s fade) fed ONLY by the server's 'kill' combat_events
 * (player source destroyed a ship — player-vs-player AND player-vs-AI).
 *
 * The kill event carries ids (killer = player id, victim = ship id); this
 * store indexes the ship entities from every snapshot batch so both sides
 * resolve to CALLSIGNS at push time (an unresolvable id falls back to the
 * raw id). `pvp` is derived from the victim's entity kind: player-vs-player
 * kills render white, player-vs-AI grey.
 *
 * Follows the subscribe/emit idiom of src/client/state/*.ts (emit on
 * change, late subscribers catch up). UI-only, transient.
 */

import { canonicalJson } from '@shared/canonical';

/** The feed keeps the LAST 5 kills (AC). */
export const KILL_FEED_MAX = 5;
/** Each entry lives 10 s (fade), then drops (AC). */
export const KILL_FEED_TTL_MS = 10_000;

/** One feed line: 'killer ▸ weapon ▸ victim' in resolved callsigns. */
export interface KillFeedEntry {
  id: number;
  /** The killer's callsign (raw player id when not yet resolvable). */
  killer: string;
  /** The victim's callsign (raw ship id when not yet resolvable). */
  victim: string;
  /** The weapon id from the kill event ('laser' / 'missile'). */
  weapon: string;
  /** true = player-vs-player (white), false = player-vs-AI (grey). */
  pvp: boolean;
  /** Epoch ms the event was pushed. */
  at: number;
}

/** The wire fields the callsign resolver needs from an entity batch. */
export interface KillFeedEntity {
  id: string;
  kind: string;
  callsign?: string;
  playerId?: string;
}

type Listener = (entries: KillFeedEntry[]) => void;

const listeners = new Set<Listener>();
let current: KillFeedEntry[] = [];
let currentJson = canonicalJson(current);
let nextId = 1;
/** ship/entity id → entity (the victim lookup). */
const byId = new Map<string, KillFeedEntity>();
/** player id → entity (the killer lookup). */
const byPlayer = new Map<string, KillFeedEntity>();

function emit(next: KillFeedEntry[]): void {
  const json = canonicalJson(next);
  if (json === currentJson) return;
  current = next;
  currentJson = json;
  for (const fn of [...listeners]) fn(next);
}

/**
 * Index one entity batch (boot snapshot AND every 10 Hz update). No emit —
 * indexing only makes LATER kills resolve to callsigns.
 */
export function indexKillFeedEntities(entities: KillFeedEntity[]): void {
  for (const e of entities) {
    byId.set(e.id, e);
    if (e.playerId) byPlayer.set(e.playerId, e);
  }
}

/**
 * Feed one 'kill' combat_event (killer = player id, victim = ship id).
 * Expired entries are pruned first, then the cap keeps the LAST 5.
 */
export function pushKillEvent(
  killerPlayerId: string,
  victimShipId: string,
  weapon: string,
  now: number,
): void {
  const next = current.filter((e) => now - e.at < KILL_FEED_TTL_MS);
  const victim = byId.get(victimShipId);
  next.push({
    id: nextId++,
    killer: byPlayer.get(killerPlayerId)?.callsign ?? killerPlayerId,
    victim: victim?.callsign ?? victimShipId,
    weapon,
    // An unindexed victim defaults to pvp (white) — the snapshot index
    // lands within one 10 Hz tick of any kill, so this is rare.
    pvp: victim ? victim.kind !== 'ai-ship' : true,
    at: now,
  });
  emit(next.slice(-KILL_FEED_MAX));
}

/** Drop one entry (the component's per-entry TTL timer). */
export function removeKillFeedEntry(id: number): void {
  if (!current.some((e) => e.id === id)) return;
  emit(current.filter((e) => e.id !== id));
}

/** The current entries (empty = nothing to render). */
export function killFeedEntries(): KillFeedEntry[] {
  return current;
}

/** Subscribe to feed changes. Calls fn(current) immediately; returns the unsubscribe. */
export function killFeedSubscribe(fn: Listener): () => void {
  listeners.add(fn);
  fn(current);
  return () => {
    listeners.delete(fn);
  };
}

/** Test helper: clear subscribers + state + the entity index. */
export function __resetKillFeed(): void {
  listeners.clear();
  current = [];
  currentJson = canonicalJson(current);
  nextId = 1;
  byId.clear();
  byPlayer.clear();
}
