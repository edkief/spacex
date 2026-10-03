/**
 * Pirate callsigns (TASK-45) — the 40 seeded rogue-AI names the per-system
 * rosters draw from without duplicates (rosterFor, src/shared/world/ai.ts).
 *
 * Every name passes the PLAYER callsign contract (CALLSIGN_PATTERN: 3-16
 * chars, alphanumeric + dash — @shared/callsign) so a rogue reads like a
 * player in the presence list; the 'AI' tag that tells them apart is the
 * `ai` wire flag (the client's PlayerList AI section, TASK-50 polishes it).
 * Exactly 40 (a 10-rogue roster needs 40 ≥ 10 unique draws).
 */
export const PIRATE_CALLSIGNS: readonly string[] = [
  'BLACKJACK-7',
  'RUSTWOLF',
  'IRON-MOTH-3',
  'SABLE-KING',
  'RED-HARROW',
  'HOLLOW-DECK',
  'NIGHTJAR-4',
  'GREYMARE',
  'SCARFACE',
  'BONEFLUTE',
  'VULTURE-9',
  'SALTPIPER',
  'DRIFTWOOD',
  'CORMORANT',
  'GUNPOWDER',
  'MIDNIGHT-OAK',
  'BRACKEN-5',
  'WIDOWMAKER',
  'COPPER-JAW',
  'FATHOM-3',
  'HAILSTONE',
  'JACKAL-6',
  'MISTRAIDER',
  'PEARLJAW',
  'RAZORFIN',
  'SMOKESTACK',
  'TERN-VANDAL',
  'WOLFHOOK',
  'AZURE-ROGUE',
  'BLACKLANTERN',
  'CINDERWAKE',
  'DUSKMANTLE',
  'EMERALD-9',
  'FALLOUT-7',
  'GHOSTGULL',
  'HALCYON-RUIN',
  'INKWAVE',
  'JUBILEE-GUN',
  'KESTREL-2',
  'LUCKY-DICE',
];
