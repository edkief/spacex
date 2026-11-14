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
