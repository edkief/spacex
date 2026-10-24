export type SpectralClass = 'O' | 'B' | 'A' | 'F' | 'G' | 'K' | 'M';

export interface Star {
  id: string;
  name: string;
  class: SpectralClass;
  x: number;
  y: number;
  z: number;
  systemCount: number;
}

export interface SystemSummary {
  starId: string;
  planetCount: number;
  hasStation: boolean;
  dangerLevel: number;
}

export interface Planet {
  id: string;
  name: string;
  radius: number;
  type: 'Terrestrial' | 'GasGiant' | 'IceGiant' | 'Dwarf';
  orbitRadius: number;
  orbitInclination: number;
}

export interface SurfaceChunk {
  id: string;
  planetId: string;
  coords: [number, number];
  seed: string;
}
