import { z } from 'zod';

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** The three paint zones of a ship (see liverySlots in the ship catalog). */
export const liverySchema = z.strictObject({
  hull: z.string().regex(HEX_COLOR),
  accent: z.string().regex(HEX_COLOR),
  trim: z.string().regex(HEX_COLOR),
});

export type Livery = z.infer<typeof liverySchema>;
