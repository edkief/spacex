import { CLOSE_CODES } from '@shared/protocol/errors.ts';
import { FLOODED_CLOSE_REASON } from '../limits.ts';
import type { Connection } from './connection.ts';

/**
 * Counts a rate-limit violation against the connection and drops it (close 4009 `flooded`)
 * when the escalation limit is reached. Returns true if the connection was dropped.
 */
export function recordViolation(conn: Connection): boolean {
  if (!conn.limits.violations.record()) return false;
  conn.dropping = true;
  conn.close(CLOSE_CODES.flooded, FLOODED_CLOSE_REASON);
  return true;
}

/**
 * Applies the general message rate limit to one inbound frame (text or binary). Returns true
 * when the frame may be processed; otherwise the excess frame is dropped, `rate-limited` is
 * sent (unless the connection is being dropped) and the violation is counted.
 */
export function admitFrame(conn: Connection): boolean {
  if (conn.dropping) return false;
  if (conn.limits.bucket.take()) return true;
  const dropped = recordViolation(conn);
  if (!dropped) conn.sendError('rate-limited', 'too many messages; slow down');
  return false;
}
