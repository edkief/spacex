export interface Player {
  id: string;
  callsign: string;
  credits: number;
  home_system_id: string | null;
  created_at: Date;
}

export interface Ship {
  id: string;
  owner_id: string;
  class_id: string;
  livery: any;
  hull: number;
  shields: number;
  position: any;
  velocity: any;
  state: 'docked' | 'flying' | 'onfoot' | 'destroyed';
  updated_at: Date;
}

export interface CargoItem {
  id?: number;
  ship_id: string;
  resource_type: string;
  quantity: number;
}

export interface Session {
  token_hash: string;
  player_id: string;
  system_id: string | null;
  created_at: Date;
  expires_at: Date;
}

export interface ResourceNodeState {
  node_id: string;
  quantity_remaining: number;
  respawn_at: Date | null;
}

export interface SystemRegistry {
  system_id: string;
  name: string;
  shard_active: boolean;
  last_active_at: Date | null;
}

export class CallsignTakenError extends Error {
  constructor(callsign: string) {
    super(`Callsign ${callsign} is already taken`);
    this.name = 'CallsignTakenError';
  }
}

export class InsufficientCreditsError extends Error {
  constructor() {
    super('Insufficient credits');
    this.name = 'InsufficientCreditsError';
  }
}

export class NotFoundError extends Error {
  constructor(resource: string, id: string) {
    super(`${resource} with id ${id} not found`);
    this.name = 'NotFoundError';
  }
}
