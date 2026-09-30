/* eslint-disable no-control-regex -- stripping control characters is the whole point of the sanitizer
 */
/**
 * System text chat contract (TASK-16).
 *
 * Deliberately minimal: one system-scoped log per shard, no channels, no
 * private messages, no persistence in v1. The server validates, sanitizes,
 * rate-limits, assigns the ts, and broadcasts; the client renders text-only
 * (React auto-escaping — never innerHTML).
 */

/** Max message length, counted AFTER trim. */
export const CHAT_MAX_CHARS = 200;
/** Chat rate limit window: at most CHAT_WINDOW_MAX messages per window. */
export const CHAT_WINDOW_MS = 10_000;
export const CHAT_WINDOW_MAX = 5;
/** Client + shard history ring buffer size. */
export const CHAT_HISTORY_MAX = 100;

/**
 * Characters that are not visible display text: C0 controls (incl. newline /
 * tab), DEL, C1 controls, bidi overrides, zero-width / direction format
 * characters, and BOM. Stripped server-side before broadcast (terminal
 * escapes, invisible bidi tricks, zero-width paste payloads all die here).
 */
// NB: the ANSI CSI alternative comes FIRST — at an ESC byte the C0 class
// would otherwise match alone and leave the "[31m" parameter garbage behind.

const NON_TEXT =
  /(\u001b\[[0-9;?]*[ -/]*[@-~])|[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/gu;

/** Strip non-text characters and surrounding whitespace. Never throws. */
export function sanitizeChatText(raw: string): string {
  return raw.replace(NON_TEXT, '').trim();
}
