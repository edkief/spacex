export interface PresencePlayer {
  callsign: string;
  shipId?: string;
  onFoot?: boolean;
}

class SimpleEventEmitter {
  private listeners: Map<string, Array<(...args: any[]) => void>> = new Map();

  on(event: string, listener: (...args: any[]) => void) {
    const list = this.listeners.get(event) || [];
    list.push(listener);
    this.listeners.set(event, list);
  }

  off(event: string, listener: (...args: any[]) => void) {
    const list = this.listeners.get(event);
    if (list) {
      this.listeners.set(
        event,
        list.filter((l) => l !== listener),
      );
    }
  }

  emit(event: string, ...args: any[]) {
    const list = this.listeners.get(event);
    if (list) {
      list.forEach((l) => l(...args));
    }
  }
}

export class PresenceStore extends SimpleEventEmitter {
  private players = new Map<string, PresencePlayer>();
  private localPlayerId: string | null = null;

  /**
   * Set the ID of the local player to exclude them from the presence list.
   */
  setLocalPlayerId(id: string) {
    this.localPlayerId = id;
  }

  /**
   * Add or update a player in the system.
   */
  join(playerId: string, data: Partial<PresencePlayer>) {
    if (playerId === this.localPlayerId) return;

    const current = this.players.get(playerId) || { callsign: 'Unknown' };
    const updated = { ...current, ...data } as PresencePlayer;
    this.players.set(playerId, updated);
    this.emit('update', { playerId, player: updated });
  }

  /**
   * Remove a player from the system.
   */
  leave(playerId: string) {
    if (this.players.delete(playerId)) {
      this.emit('leave', { playerId });
    }
  }

  /**
   * Clear all players (e.g., when changing systems).
   */
  leaveAll() {
    this.players.clear();
    this.emit('clear');
  }

  /**
   * Returns a copy of the current players map.
   */
  getPlayers() {
    return new Map(this.players);
  }

  /**
   * Get a specific player's presence data.
   */
  getPlayer(playerId: string) {
    return this.players.get(playerId);
  }
}

export const presenceStore = new PresenceStore();
