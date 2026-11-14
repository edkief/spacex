import { z } from 'zod';
import { isShipClassId } from '@shared/ships/ids.ts';
import { CorruptRowError } from './errors.ts';
import { liverySchema, positionSchema, velocitySchema } from './json.ts';
import { SHIP_STATES, type ships } from './schema.ts';
import type { Ship, ShipStateUpdate } from './types.ts';

const stat = z.number().min(0);

/** Validates a ship-state update before it is written. */
export const shipStateUpdateSchema = z.strictObject({
  hull: stat,
  shields: stat,
  position: positionSchema,
  velocity: velocitySchema,
  state: z.enum(SHIP_STATES),
  livery: liverySchema.optional(),
});

/** Parses (validates the JSON columns of) a ships row into the domain type. */
export function toShip(row: typeof ships.$inferSelect): Ship {
  if (!isShipClassId(row.classId)) throw new CorruptRowError('ship', row.id, 'unknown class_id');
  const parsed = z
    .object({
      livery: liverySchema,
      position: positionSchema,
      velocity: velocitySchema,
      state: z.enum(SHIP_STATES),
    })
    .safeParse(row);
  if (!parsed.success) {
    const paths = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new CorruptRowError('ship', row.id, `invalid ${paths}`);
  }
  return { ...row, classId: row.classId, ...parsed.data };
}

export type ValidatedShipUpdate = z.infer<typeof shipStateUpdateSchema> & ShipStateUpdate;
