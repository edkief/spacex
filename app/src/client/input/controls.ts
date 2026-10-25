import { FlightRegime } from '../../shared/physics/types';

export type ControlAxis = 'thrust' | 'pitch' | 'yaw' | 'roll' | 'up' | 'moveForward' | 'moveBackward' | 'moveLeft' | 'moveRight' | 'interact';

export interface ControlMapping {
  axis: ControlAxis;
  value: number;
}

export interface ControlScheme {
  mapKey(code: string): ControlMapping | null;
}

const SPACE_SCHEME: ControlScheme = {
  mapKey: (code) => {
    switch (code) {
      case 'KeyW': return { axis: 'thrust', value: 1 };
      case 'KeyS': return { axis: 'thrust', value: 0 };
      case 'ArrowUp': return { axis: 'pitch', value: 1 };
      case 'ArrowDown': return { axis: 'pitch', value: -1 };
      case 'ArrowLeft': return { axis: 'yaw', value: -1 };
      case 'ArrowRight': return { axis: 'yaw', value: 1 };
      case 'KeyA': return { axis: 'roll', value: -1 };
      case 'KeyD': return { axis: 'roll', value: 1 };
      default: return null;
    }
  },
};

const ATMOSPHERE_SCHEME: ControlScheme = {
  mapKey: (code) => {
    const spaceRes = SPACE_SCHEME.mapKey(code);
    if (spaceRes) return spaceRes;
    switch (code) {
      case 'Space': return { axis: 'up', value: 1 };
      default: return null;
    }
  },
};

const SURFACE_SCHEME: ControlScheme = {
  mapKey: (code) => {
    switch (code) {
      case 'KeyW': return { axis: 'moveForward', value: 1 };
      case 'KeyS': return { axis: 'moveBackward', value: 1 };
      case 'KeyA': return { axis: 'moveLeft', value: 1 };
      case 'KeyD': return { axis: 'moveRight', value: 1 };
      case 'KeyE': return { axis: 'interact', value: 1 };
      default: return null;
    }
  },
};

const SCHEMES: Record<FlightRegime, ControlScheme> = {
  space: SPACE_SCHEME,
  atmosphere: ATMOSPHERE_SCHEME,
  surface: SURFACE_SCHEME,
};

export function getControlScheme(regime: FlightRegime): ControlScheme {
  return SCHEMES[regime];
}
