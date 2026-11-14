import type { ShipClassId } from '../ships/ids.ts';

export type StarClass = 'O' | 'B' | 'A' | 'F' | 'G' | 'K' | 'M';

/** One star of the galaxy chart. `id` is the 16-hex-char hash used as the stable key. */
export interface Star {
  id: string;
  name: string;
  class: StarClass;
  /** Galactic coordinates in galactic units; the disk lies in the x/y plane, z is thickness. */
  x: number;
  y: number;
  z: number;
  /** Number of systems (2..8) attached to this star. */
  systemCount: number;
}

export type PlanetClass = 'rocky' | 'terran' | 'ocean' | 'gas' | 'ice';

/** The rogue-AI ships that patrol a planet; one entry in `classes` per ship. */
export interface AiRoster {
  count: number;
  classes: ShipClassId[];
}

export interface Planet {
  id: string;
  name: string;
  class: PlanetClass;
  radiusKm: number;
  hasAtmosphere: boolean;
  landable: boolean;
  /** 0..3; at least 1 for every landable planet, 0 for non-landable ones. */
  dockCount: number;
  /** Which resource types exist on this planet (node placement is per surface chunk). */
  resourceTypes: string[];
  aiRoster: AiRoster;
}

/** A generated star system: everything below the star, derived from (seed, starId). */
export interface SystemGen {
  systemId: string;
  name: string;
  star: { class: StarClass; name: string };
  planets: Planet[];
}
