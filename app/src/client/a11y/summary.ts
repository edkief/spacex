/**
 * The 1 Hz HUD summary for the screen-reader live region (TASK-54).
 *
 * The canonical game-a11y pattern: instead of announcing at the 10 Hz
 * snapshot cadence (unusable spam), ONE spoken summary per second. The
 * summary is plain speech text (units spelled out, values rounded —
 * "Speed 120 meters per second. Hull 80 percent. 500 credits.") built
 * from the same client stores the HUD renders from.
 */
import { selfShipView } from '@client/state/ship-hud';
import { credits } from '@client/state/credits';
import { hazardState } from '@client/state/hazards';
import { EXPOSURE_MAX } from '@shared/world/hazards';
import { inventory } from '@client/state/inventory';

/** The speechable HUD summary for the current game state. */
export function hudSummary(): string {
  const parts: string[] = [];
  const ship = selfShipView();
  if (ship) {
    const speed = Math.hypot(ship.vel.x, ship.vel.y, ship.vel.z);
    parts.push(`Speed ${Math.round(speed)} meters per second.`);
    parts.push(`Hull ${Math.round(ship.hull * 100)} percent.`);
  } else {
    const exposure = Math.round(hazardState().exposure);
    parts.push(`Exposure ${exposure} of ${EXPOSURE_MAX}.`);
    const inv = inventory();
    if (inv) parts.push(`Carrying ${inv.weightUsed} of 40 units.`);
  }
  const cr = credits();
  if (cr !== null) parts.push(`${Math.round(cr)} credits.`);
  return parts.join(' ');
}
