import { z } from 'zod';
import { framePositionSchema, vec3Schema } from '@shared/protocol/primitives.ts';

export { liverySchema, type Livery } from '@shared/ships/livery.ts';

/** Ship position: the system shard it is in plus a framed position (see FramePosition). */
export const positionSchema = framePositionSchema.extend({ systemId: z.string().min(1) });

export const velocitySchema = vec3Schema;

export type Position = z.infer<typeof positionSchema>;
export type Velocity = z.infer<typeof velocitySchema>;
