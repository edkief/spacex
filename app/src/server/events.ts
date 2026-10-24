import { EventEmitter } from 'events';

export const gameEvents = new EventEmitter();

export enum GameEventType {
  SHIP_SWAPPED = 'ship_swapped',
  LIVERY_CHANGED = 'livery_changed',
  REPAIR_COMPLETED = 'repair_completed',
}

export interface ShipSwappedEvent {
  playerId: string;
  newShip: any;
}

export interface LiveryChangedEvent {
  playerId: string;
  livery: Record<string, string>;
}

export interface RepairCompletedEvent {
  playerId: string;
  shipId: string;
}
