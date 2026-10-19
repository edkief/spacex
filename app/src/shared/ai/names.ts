/**
 * Rogue-AI callsigns — TASK-45.
 *
 * The pirate fleet in every star system draws its names from this
 * list (40 unique handles). Every callsign:
 *
 *   - sits inside the 3..16 char range that the player-callsign
 *     validator (`@shared/protocol/schemas` `CallsignSchema`) accepts,
 *   - is uppercase ASCII so the HUD renders cleanly without font
 *     fallback hops,
 *   - looks the part of "a pirate shipping callsign a player might
 *     bump into" — distinctive enough to read in a presence list
 *     without colliding with a real player's chosen handle.
 *
 * The list is exported as a frozen readonly array so a future task
 * can swap names out without changing importers. The tests assert
 * the array length is exactly 40 and that every entry passes the
 * callsign validator.
 *
 * The names are deliberately NOT seeded — they form a fixed catalog
 * the task spec calls out. The roster module picks `N` callsigns
 * deterministically from this list (rotation + skip-dup) so a given
 * `(seed, systemId)` always sees the same names attached to its
 * ships; the test suite asserts duplicate-freeness within a single
 * roster.
 *
 * @see ./roster.ts for the picker logic.
 * @see ../world/ai.ts for the per-system roster derivation.
 * @see ../protocol/schemas.ts for the callsign validator (3-16 chars).
 */

/**
 * The 40-entry pirate callsign list. Conservative hand-picked set;
 * tweak with care — every commit moves a roster's display names.
 *
 * Lengths range from 3 ("DUKE") to 12 ("BLAKCORVETTE"). Mixed
 * "GrimDark" space-opera tone ("KRYPT-SCUM", "VOIDREAPER") + a few
 * clean handles ("COMET", "AURORA") so the HUD never feels monotone.
 */
export const AI_CALLSIGNS: readonly string[] = [
  "COMET",
  "DUKE",
  "AURORA",
  "CRIMSON",
  "KRYPT-SCUM",
  "VOIDREAPER",
  "BLACKMAW",
  "WRAITH",
  "OUTLAW",
  "PIRATE",
  "BANSHEE",
  "GOLIATH",
  "PHOENIX",
  "BLITZ",
  "DAGGER",
  "STARLETTE",
  "REVENANT",
  "NOXWING",
  "REDLINE",
  "ECHO-7",
  "HUNTERS",
  "MARAUDER",
  "RANSOM",
  "GRAYVEIL",
  "SHOGUN",
  "BERSERKER",
  "BLACKHAWK",
  "PROWLER",
  "KESTREL",
  "TEMPEST",
  "GRIMHARVEST",
  "REDACTED",
  "BLUNDERBUSS",
  "BLAKCORVETTE",
  "DOOMSDAY",
  "CRUELMUFFIN",
  "OLYMPUS",
  "NIGHTHAWK",
  "SCARLET",
  "STORMGHOST",
] as const;

/** Compile-time guard: the list must stay exactly 40 entries. */
export const AI_CALLSIGN_COUNT = 40;

/**
 * `find` helper — returns the index of `name` in the list, or
 * `-1` if not present. Exported so the roster module can map a
 * previously-picked index back to the catalogue without leaking
 * the catalogue reference.
 */
export function findAiCallsign(name: string): number {
  return AI_CALLSIGNS.indexOf(name);
}

/**
 * Minimum callsign length — must match the player callsign
 * validator (`CallsignSchema` in `@shared/protocol/schemas`).
 * Surfaced here so the tests assert the parity.
 */
export const AI_CALLSIGN_MIN_LEN = 3;

/**
 * Maximum callsign length — must match the player callsign
 * validator. Surfaced for the same test-parity reason.
 */
export const AI_CALLSIGN_MAX_LEN = 16;
