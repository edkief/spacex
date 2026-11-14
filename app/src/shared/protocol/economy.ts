import { z } from 'zod';
import { liverySchema } from '../ships/livery.ts';
import {
  entityIdSchema,
  hex16Schema,
  printable,
  shipClassIdSchema,
  uuidSchema,
} from './primitives.ts';

export const interactSchema = z.strictObject({ targetId: entityIdSchema });
export const mineSchema = z.strictObject({ nodeId: hex16Schema, active: z.boolean() });
export const sellSchema = z.strictObject({
  resourceType: printable(32),
  quantity: z.number().int().min(1).max(100_000),
});
export const buyShipSchema = z.strictObject({ classId: shipClassIdSchema });
export const setLiverySchema = z.strictObject({ shipId: uuidSchema, livery: liverySchema });
export const exitShipSchema = z.strictObject({});
export const enterShipSchema = z.strictObject({ shipId: uuidSchema });
export const repairSchema = z.strictObject({ shipId: uuidSchema });
