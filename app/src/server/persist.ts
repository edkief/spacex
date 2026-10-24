import { repo } from './db/repo';
import { Ship, CargoItem, ResourceNodeState } from './db/types';
import { db } from './db/client';

export type ShipStateProvider = (shipId: string) => Promise<{ ship: Ship; cargo: CargoItem[] }>;

export class PersistService {
  private dirtyShips = new Set<string>();
  private intervalId: NodeJS.Timeout | null = null;
  private stateProvider: ShipStateProvider | null = null;

  constructor() {
    // Interval is started when stateProvider is set
  }

  public setStateProvider(provider: ShipStateProvider) {
    this.stateProvider = provider;
    if (!this.intervalId) {
      this.startInterval();
    }
  }

  private startInterval() {
    this.intervalId = setInterval(() => this.saveDirtyShips(), 5000);
  }

  public stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  public markDirty(shipId: string) {
    this.dirtyShips.add(shipId);
  }

  public async saveShip(ship: Ship): Promise<void> {
    await repo.saveShipState(ship.id, ship);
    this.dirtyShips.delete(ship.id);
  }

  public async saveCargo(shipId: string, items: CargoItem[], tx?: any): Promise<void> {
    await repo.saveCargo(shipId, items, tx);
  }

  public async saveNodeStates(systemId: string, states: ResourceNodeState[]): Promise<void> {
    await db.transaction(async (tx: any) => {
      for (const state of states) {
        await repo.upsertNodeState(
          state.node_id,
          systemId,
          state.quantity_remaining,
          state.respawn_at,
          tx,
        );
      }
    });
  }

  public async loadSystemState(systemId: string) {
    return await repo.loadSystemState(systemId);
  }

  public async saveDirtyShips(): Promise<void> {
    if (this.dirtyShips.size === 0 || !this.stateProvider) return;

    const shipsToSave = Array.from(this.dirtyShips);
    this.dirtyShips.clear();

    for (const shipId of shipsToSave) {
      const { ship, cargo } = await this.stateProvider(shipId);
      await repo.saveShipState(ship.id, ship);
      await repo.saveCargo(ship.id, cargo);
    }
  }

  // Hooks
  public async onDock(ship: Ship, cargo: CargoItem[]): Promise<void> {
    await db.transaction(async (tx: any) => {
      await repo.saveShipState(ship.id, ship, tx);
      await repo.saveCargo(ship.id, cargo, tx);
    });
  }

  public async onDamage(ship: Ship, cargo: CargoItem[], previousHull: number): Promise<void> {
    const hull = ship.hull;
    const thresholds = [75, 50, 25];

    const crossedThreshold = thresholds.some((t) => previousHull > t && hull <= t);

    if (crossedThreshold) {
      await this.onDock(ship, cargo);
    }
  }

  public async onShardShutdown(
    systemId: string,
    ships: Map<string, { ship: Ship; cargo: CargoItem[] }>,
    nodes: ResourceNodeState[],
  ): Promise<void> {
    await db.transaction(async (tx: any) => {
      for (const { ship, cargo } of ships.values()) {
        await repo.saveShipState(ship.id, ship, tx);
        await repo.saveCargo(ship.id, cargo, tx);
      }
      for (const state of nodes) {
        await repo.upsertNodeState(
          state.node_id,
          systemId,
          state.quantity_remaining,
          state.respawn_at,
          tx,
        );
      }
    });
  }
}

export const persistService = new PersistService();
