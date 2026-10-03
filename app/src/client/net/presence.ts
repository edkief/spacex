import type { PresenceEntry } from '@shared/protocol/schemas';

/** One remote player currently in the same system. */
export interface PlayerPresence {
  playerId: string;
  callsign: string;
  /** Ship observed on (wire field; kept for the ship-only snapshot path). */
  shipId?: string;
  /**
   * On foot (disembarked) — TASK-36: DERIVED client-side from the entity
   * list (a `character` entity for this player ⇒ on foot), never sent over
   * the wire. The PlayerList icon switches on this flag.
   */
  onFoot?: boolean;
  /**
   * Wall-clock time of the last observation. Not displayed in v1 (ping /
   * latency was cut for scope) but kept so it can come back without a
   * protocol change (TASK-15 note).
   */
  lastSeen: number;
}

/**
 * One rogue AI ship in the system (TASK-45), DERIVED client-side from the
 * entity list (kind 'ai-ship' + the `ai` wire flag) — the rosters ride the
 * ENTITY list, never the presence entry list (which stays player-only).
 */
export interface AiPresence {
  /** The wire entity id (the roster aiId, stable per system). */
  aiId: string;
  /** The pirate callsign (looks like a player callsign — hence the tag). */
  callsign: string;
}

export interface PresenceToast {
  /**
   * 'reconnected' (TASK-17) is a local connection event, not a presence
   * change — it never touches the player list, only the toast stack.
   * 'notice' (TASK-8) is a free-form local toast (warp failures).
   */
  kind: 'join' | 'leave' | 'reconnected' | 'notice';
  callsign: string;
  /** 'notice' toasts render this text verbatim (e.g. 'System full'). */
  text?: string;
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
function sameAiSet(a: Map<string, AiPresence>, b: Map<string, AiPresence>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, v] of a) {
    const w = b.get(id);
    if (!w || w.callsign !== v.callsign) return false;
  }
  return true;
}

export class PresenceStore {
  private readonly others = new Map<string, PlayerPresence>();
  /** TASK-45: in-system rogues, derived from the entity list (ai: true). */
  private readonly ais = new Map<string, AiPresence>();
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

  /**
   * TASK-36: derive each player's onFoot flag from the entity list — a
   * `character` entity owned by the player (playerId, falling back to
   * callsign) means on foot; no character means back in the ship. Fed from
   * every 10 Hz entity batch + system snapshot; emits ONLY when a flag
   * actually flips (disembark / re-enter), never on the snapshot cadence —
   * the PlayerList icon switches live without re-rendering while flying.
   */
  applyActiveEntities(
    entities: Array<{ callsign?: string; playerId?: string; kind: string }>,
  ): void {
    let changed = false;
    for (const [id, p] of this.others) {
      const onFoot = entities.some(
        (e) =>
          e.kind === 'character' &&
          ((e.playerId !== undefined && e.playerId === id) ||
            (e.callsign !== undefined && e.callsign === p.callsign)),
      );
      if (p.onFoot !== onFoot) {
        p.onFoot = onFoot;
        changed = true;
      }
    }
    if (changed) this.emitChange();
  }

  /**
   * TASK-45: derive the in-system rogue AI list from the entity list — an
   * entity with `ai: true` (kind 'ai-ship') is a rogue. Fed from every 10 Hz
   * entity batch + system snapshot, like applyActiveEntities; emits ONLY
   * when the set actually changes (a destroyed rogue keeps its wire id and
   * flag through the 120 s respawn, so the list never churns on the
   * snapshot cadence).
   */
  applyAiEntities(
    entities: Array<{ id: string; kind: string; callsign?: string; ai?: true }>,
  ): void {
    const next = new Map<string, AiPresence>();
    for (const e of entities) {
      if (e.ai !== true || e.kind !== 'ai-ship' || !e.callsign) continue;
      next.set(e.id, { aiId: e.id, callsign: e.callsign });
    }
    if (sameAiSet(this.ais, next)) return;
    this.ais.clear();
    for (const [id, v] of next) this.ais.set(id, v);
    this.emitChange();
  }

  /** TASK-36: the LOCAL player's onFoot flag (from the self-entity bridge). */
  setSelfOnFoot(onFoot: boolean): void {
    if (!this.self) return;
    if ((this.self.onFoot ?? false) === onFoot) return;
    this.self = { ...this.self, onFoot, lastSeen: this.now() };
    this.emitChange();
  }

  /**
   * TASK-17: the local connection recovered (reconnect resync complete).
   * Fires a one-shot 'reconnected' toast; the player list is untouched —
   * it was rebuilt from the resync snapshot by the caller.
   */
  reconnected(): void {
    this.emitToast({ kind: 'reconnected', callsign: this.self?.callsign ?? '', at: this.now() });
  }

  /**
   * TASK-8: a free-form local toast (e.g. the 'System full' warp rejection).
   * Purely additive — the player list and occupancy are untouched.
   */
  notify(text: string): void {
    this.emitToast({ kind: 'notice', callsign: '', text, at: this.now() });
  }

  /** The player switched systems: everyone is gone until the next snapshot. */
  leaveAll(): void {
    if (this.others.size === 0 && this.ais.size === 0) return;
    this.others.clear();
    this.ais.clear();
    this.emitChange();
  }

  /** Rogue AI ships in the system (TASK-45), sorted by callsign. */
  get aiPlayers(): AiPresence[] {
    return [...this.ais.values()].sort((a, b) => a.callsign.localeCompare(b.callsign));
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
