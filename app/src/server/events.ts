import { EventEmitter } from 'events';

export const gameEvents = new EventEmitter();

export enum GameEventType {
  SHIP_SWAPPED = 'ship_swapped',
}

export interface ShipSwappedEvent {
  playerId: string;
  newShip: any;
}
