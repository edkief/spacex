/**
 * Prompt announcement helpers — TASK-54.
 *
 * The on-screen prompt reads "[E] Take iron" (a bracketed key
 * badge plus a capitalised verb). A screen reader should say
 * "E to take iron" instead — the brackets are visual noise and the
 * capitalisation would otherwise be spelled out.
 */

/**
 * Convert a visual prompt string into a spoken one.
 *
 *   "[E] Take iron"  → "E to take iron"
 *   "[E] Dock terminal" → "E to dock terminal"
 *
 * Strings that do not start with a key badge are returned with the
 * leading bracket stripped and the first letter lower-cased.
 */
export function promptAnnouncementText(prompt: string): string {
  const trimmed = prompt.trim();
  const match = /^\[([^\]]+)\]\s*(.*)$/.exec(trimmed);
  if (match === null) {
    if (trimmed === "") return "";
    return trimmed.charAt(0).toLowerCase() + trimmed.slice(1);
  }
  const key = match[1]!;
  const rest = match[2]!.trim();
  if (rest === "") return key;
  return `${key} to ${rest.charAt(0).toLowerCase()}${rest.slice(1)}`;
}
