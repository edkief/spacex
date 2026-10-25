import { EventEmitter } from 'events';

export const gameEvents = new EventEmitter();

export enum GameEventType {
  SHIP_SWAPPED = 'ship_swapped',
  LIVERY_CHANGED = 'livery_changed',
  REPAIR_COMPLETED = 'repair_completed',
  SHIP_TELEPORTED = 'ship_teleported',
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

export interface ShipTeleportedEvent {
  shipId: string;
  pos: { x: number; y: number; z: number };
  vel: { x: number; y: number; z: number };
}
