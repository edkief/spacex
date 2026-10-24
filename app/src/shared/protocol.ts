import { z } from 'zod';
import { MessageSchemas } from './protocol/schemas';

export const PROTOCOL_VERSION = 1;

export interface Envelope {
  v: number;
  type: string;
  payload: unknown;
}

export const EnvelopeSchema = z
  .object({
    v: z.number().int(),
    type: z.string(),
    payload: z.any(),
  })
  .strict();

export type MessagePayload = {
  [K in keyof typeof MessageSchemas]: z.infer<(typeof MessageSchemas)[K]>;
}[string];

export function parseMessage(type: string, payload: unknown) {
  const schema = MessageSchemas[type];
  if (!schema) {
    return { success: false, error: 'unknown-type' };
  }
  const result = schema.safeParse(payload);
  if (!result.success) {
    return { success: false, error: 'invalid-message' };
  }
  return { success: true, data: result.data };
}

export function encodeMessage<T extends keyof typeof MessageSchemas>(
  type: T,
  payload: z.infer<(typeof MessageSchemas)[T]>,
  version: number = PROTOCOL_VERSION,
): string {
  return JSON.stringify({
    v: version,
    type,
    payload,
  });
}

export function decodeEnvelope(
  data: string,
): { success: true; data: Envelope } | { success: false; error: string } {
  try {
    const json = JSON.parse(data);
    const result = EnvelopeSchema.safeParse(json);
    if (!result.success) {
      return { success: false, error: 'Invalid envelope format' };
    }
    return { success: true, data: result.data };
  } catch (e) {
    return { success: false, error: 'Malformed JSON' };
  }
}
