import { z } from 'zod';

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** Ship position: which system shard it is in plus metres in that system's frame. */
export const positionSchema = z.strictObject({
  systemId: z.string().min(1),
  x: z.number(),
  y: z.number(),
  z: z.number(),
});

export const velocitySchema = z.strictObject({ x: z.number(), y: z.number(), z: z.number() });

/** The three paint zones of a ship (see liverySlots in the ship catalog). */
export const liverySchema = z.strictObject({
  hull: z.string().regex(HEX_COLOR),
  accent: z.string().regex(HEX_COLOR),
  trim: z.string().regex(HEX_COLOR),
});

export type Position = z.infer<typeof positionSchema>;
export type Velocity = z.infer<typeof velocitySchema>;
export type Livery = z.infer<typeof liverySchema>;
