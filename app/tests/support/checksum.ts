import { createHash } from 'node:crypto';

/** SHA-256 of a UTF-8 string as lowercase hex. Test/tooling only; src/shared stays Node-free. */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
