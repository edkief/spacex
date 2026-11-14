/** The flight axes and one-shot actions the keyboard drives. */
export type Axis = 'thrust' | 'yaw' | 'pitch' | 'roll' | 'up';
export type Action = 'dock' | 'undock';

export interface AxisBinding {
  axis: Axis;
  /** +1 or -1: the direction this key pushes the axis. */
  direction: 1 | -1;
}

/** A data-driven binding table from `KeyboardEvent.code` to what the key does. */
export interface ActionMap {
  axes: Readonly<Record<string, AxisBinding>>;
  actions: Readonly<Record<string, Action>>;
  brake: readonly string[];
  fire: readonly string[];
  lock: readonly string[];
}

/**
 * Default controls. Axis signs follow the protocol: +yaw turns left, +pitch raises the nose,
 * +roll banks right, +up is VTOL climb in atmosphere and ship-up thrust in space.
 */
export const DEFAULT_ACTION_MAP: ActionMap = {
  axes: {
    KeyW: { axis: 'thrust', direction: 1 },
    KeyS: { axis: 'thrust', direction: -1 },
    KeyA: { axis: 'yaw', direction: 1 },
    KeyD: { axis: 'yaw', direction: -1 },
    ArrowDown: { axis: 'pitch', direction: 1 },
    ArrowUp: { axis: 'pitch', direction: -1 },
    KeyE: { axis: 'roll', direction: 1 },
    KeyQ: { axis: 'roll', direction: -1 },
    Space: { axis: 'up', direction: 1 },
    KeyC: { axis: 'up', direction: -1 },
  },
  actions: { KeyG: 'dock', KeyU: 'undock' },
  brake: ['KeyX'],
  fire: ['KeyF'],
  lock: ['KeyT'],
};

/** Every key code the map uses (so the page can stop them scrolling or typing). */
export function boundCodes(map: ActionMap): Set<string> {
  return new Set([
    ...Object.keys(map.axes),
    ...Object.keys(map.actions),
    ...map.brake,
    ...map.fire,
    ...map.lock,
  ]);
}
