import type { PresenceEntry } from '@shared/protocol/schemas';

/** One remote player currently in the same system. */
export interface PlayerPresence {
  playerId: string;
  callsign: string;
  /** Ship observed on; the onFoot flag arrives with TASK-36. */
  shipId?: string;
  onFoot?: boolean;
  /**
   * Wall-clock time of the last observation. Not displayed in v1 (ping /
   * latency was cut for scope) but kept so it can come back without a
   * protocol change (TASK-15 note).
   */
  lastSeen: number;
}

export interface PresenceToast {
  kind: 'join' | 'leave';
  callsign: string;
  at: number;
}

type ChangeListener = () => void;
type ToastListener = (toast: PresenceToast) => void;

function entryEqual(a: PlayerPresence, b: PlayerPresence): boolean {
  return a.callsign === b.callsign && a.shipId === b.shipId && a.onFoot === b.onFoot;
}

function sameSet(a: Map<string, PlayerPresence>, b: Map<string, PlayerPresence>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, v] of a) {
    const w = b.get(id);
    if (!w || !entryEqual(v, w)) return false;
  }
  return true;
}

/**
 * TASK-15: in-system player presence, client side.
 *
 * Built from the enter_system snapshot (`applySnapshot`) and the
 * presence join/leave events (`presenceJoin` / `presenceLeave`);
 * `leaveAll()` clears the map when the player switches systems.
 *
 * The local player is tracked separately (`setSelf`) and never appears
 * in `otherPlayers` — the HUD renders it with a "(you)" marker.
 *
 * Subscriptions fire ONLY on real presence changes: an unchanged
 * snapshot does not re-emit, so the HUD never re-renders on the 10 Hz
 * entity cadence, only on join/leave.
 */
export class PresenceStore {
  private readonly others = new Map<string, PlayerPresence>();
  private self: PlayerPresence | null = null;
  private readonly changeListeners = new Set<ChangeListener>();
  private readonly toastListeners = new Set<ToastListener>();

  constructor(private readonly now: () => number = Date.now) {}

  /** The local player, known at claim/auth time. */
  setSelf(player: { playerId: string; callsign: string; shipId?: string }): void {
    this.self = { ...player, lastSeen: this.now() };
    this.emitChange();
  }

  /**
   * Full player list from the enter_system snapshot: replaces the map.
   * No toasts — this is the initial view, not a transition. Emits change
   * only when the set actually differs (id + callsign + shipId + onFoot).
   */
  applySnapshot(players: PresenceEntry[]): void {
    const next = new Map<string, PlayerPresence>();
    for (const p of players) {
      if (this.self && p.playerId === this.self.playerId) continue; // never list self
      next.set(p.playerId, { ...p, lastSeen: this.now() });
    }
    if (sameSet(this.others, next)) return;
    this.others.clear();
    for (const [id, v] of next) this.others.set(id, v);
    this.emitChange();
  }

  /** A peer arrived in the system (server presence 'join' event). */
  presenceJoin(entry: PresenceEntry): void {
    if (this.self && entry.playerId === this.self.playerId) return; // defensive: server skips self
    this.others.set(entry.playerId, { ...entry, lastSeen: this.now() });
    this.emitChange();
    this.emitToast({ kind: 'join', callsign: entry.callsign, at: this.now() });
  }

  /** A peer left the system or disconnected (server presence 'leave' event). */
  presenceLeave(entry: PresenceEntry): void {
    if (this.others.delete(entry.playerId)) this.emitChange();
    this.emitToast({ kind: 'leave', callsign: entry.callsign, at: this.now() });
  }

  /** The player switched systems: everyone is gone until the next snapshot. */
  leaveAll(): void {
    if (this.others.size === 0) return;
    this.others.clear();
    this.emitChange();
  }

  /** Remote players only (self excluded), sorted by callsign. */
  get otherPlayers(): PlayerPresence[] {
    return [...this.others.values()].sort((a, b) => a.callsign.localeCompare(b.callsign));
  }

  get selfPlayer(): PlayerPresence | null {
    return this.self;
  }

  /** Occupancy including self — the number that feeds the star chart badge. */
  get occupancy(): number {
    return this.others.size + (this.self ? 1 : 0);
  }

  /** Subscribe to presence changes; returns an unsubscribe function. */
  subscribe(listener: ChangeListener): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  /** Subscribe to join/leave toasts (HUD toast stack); returns unsubscribe. */
  onToast(listener: ToastListener): () => void {
    this.toastListeners.add(listener);
    return () => this.toastListeners.delete(listener);
  }

  private emitChange(): void {
    for (const listener of [...this.changeListeners]) listener();
  }

  private emitToast(toast: PresenceToast): void {
    for (const listener of [...this.toastListeners]) listener(toast);
  }
}
