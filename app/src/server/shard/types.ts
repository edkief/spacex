import { z } from 'zod';
import { ShipState as BaseShipState } from '../../shared/physics/types';
import { InputSchema } from '../../shared/protocol/schemas';

export type InputMsg = z.infer<typeof InputSchema>;

export interface ServerShipState extends BaseShipState {
  id: string;
  hull: number;
  shields: number;
  targetId: string | null;
}

export interface ConnState {
  playerId: string;
  lastSeq: number;
  inputQueue: InputMsg[];
}
