import { z } from 'zod';
import { SHIP_CLASS_IDS } from '../ships/ids.ts';

export const HEX16_PATTERN = /^[0-9a-f]{16}$/;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Hash-derived ids (systems, planets, nodes): 16 lowercase hex characters. */
export const hex16Schema = z.string().regex(HEX16_PATTERN);
/** Database ids (players, ships): lowercase UUIDs. */
export const uuidSchema = z.string().regex(UUID_PATTERN);
/** Any id that can name an entity on the wire. */
export const entityIdSchema = z.union([hex16Schema, uuidSchema]);
export const systemIdSchema = hex16Schema;

/** World coordinate bound in metres (about 6.7 AU), well beyond any generated system. */
export const COORD_LIMIT = 1e12;
const coord = z.number().min(-COORD_LIMIT).max(COORD_LIMIT);
const unit = z.number().min(-1).max(1);

export const vec3Schema = z.strictObject({ x: coord, y: coord, z: coord });

/** Orientation quaternion; components in [-1, 1] and approximately unit length. */
export const quatSchema = z
  .strictObject({ x: unit, y: unit, z: unit, w: unit })
  .refine((q) => Math.abs(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w - 1) <= 0.01, {
    error: 'quaternion must be unit length',
  });

/** `'system'` (system-centred cartesian) or a planet id (planet-local, y up). Metres. */
export const frameSchema = z.union([z.literal('system'), hex16Schema]);

export const framePositionSchema = z.strictObject({
  frame: frameSchema,
  x: coord,
  y: coord,
  z: coord,
});

export const shipClassIdSchema = z.enum(SHIP_CLASS_IDS);
export const tickSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const seqSchema = z.number().int().min(0).max(2147483647);
export const timestampSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const statSchema = z.number().min(0).max(1_000_000);

/** Printable text without control characters; used for chat and display names. */
export const printable = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    // eslint-disable-next-line no-control-regex -- the point is to reject control characters
    .regex(/^[^\u0000-\u001f\u007f]*$/, 'control characters are not allowed');

export type Vec3 = z.infer<typeof vec3Schema>;
export type FramePosition = z.infer<typeof framePositionSchema>;
