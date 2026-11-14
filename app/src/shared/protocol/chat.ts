import { z } from 'zod';
import { printable, timestampSchema } from './primitives.ts';
import { callsignSchema } from '../callsign.ts';

export const CHAT_MAX_LENGTH = 280;

export const chatClientSchema = z.strictObject({ text: printable(CHAT_MAX_LENGTH) });
export const chatServerSchema = z.strictObject({
  from: callsignSchema,
  text: printable(CHAT_MAX_LENGTH),
  at: timestampSchema,
});
