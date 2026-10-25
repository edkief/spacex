import { z } from 'zod';
import { ShipState as BaseShipState } from '../../shared/physics/types';
import { InputSchema } from '../../shared/protocol/schemas';

export type InputMsg = z.infer<typeof InputSchema>;

export interface ServerShipState extends BaseShipState {
  id: string;
  kind: 'ship' | 'wreck';
  classId: string;
  hull: number;
  shields: number;
  destroyed: boolean;
  targetId: string | null;
  lastAppliedSeq?: number;
  wreckExpiresAt?: number;
}

export interface ConnState {
  playerId: string;
  callsign: string;
  lastSeq: number;
  inputQueue: InputMsg[];
}
