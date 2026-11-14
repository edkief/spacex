import type { ClientPayload } from '@shared/protocol/registry.ts';
import {
  DEFAULT_ACTION_MAP,
  boundCodes,
  type Action,
  type ActionMap,
  type Axis,
} from './actionMap.ts';

/** The flight part of an input message (everything except `seq`). */
export type InputSample = Omit<ClientPayload<'input'>, 'seq'>;

const AXES: readonly Axis[] = ['thrust', 'yaw', 'pitch', 'roll', 'up'];

/** True for elements that take text, where flight keys must type instead of fly. */
function isTextTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/**
 * Tracks which bound keys are held and turns them into flight input. Opposing keys cancel,
 * one-shot actions (dock/undock) are latched until sampled, and everything is released when the
 * window loses focus so a key can never stick.
 */
export class KeyboardState {
  private readonly held = new Set<string>();
  private pendingAction: Action | undefined;
  private readonly map: ActionMap;
  private readonly codes: Set<string>;

  constructor(map: ActionMap = DEFAULT_ACTION_MAP) {
    this.map = map;
    this.codes = boundCodes(map);
  }

  /** Feeds a keydown; returns true when the key is bound (the caller should preventDefault). */
  keyDown(code: string, target: EventTarget | null = null): boolean {
    if (!this.codes.has(code) || isTextTarget(target)) return false;
    const action = this.map.actions[code];
    if (action && !this.held.has(code)) this.pendingAction = action;
    this.held.add(code);
    return true;
  }

  keyUp(code: string): void {
    this.held.delete(code);
  }

  /** Releases every key (window blur, menu opened). */
  releaseAll(): void {
    this.held.clear();
    this.pendingAction = undefined;
  }

  private axis(axis: Axis): number {
    let value = 0;
    for (const code of this.held) {
      const binding = this.map.axes[code];
      if (binding?.axis === axis) value += binding.direction;
    }
    return Math.max(-1, Math.min(1, value));
  }

  private any(codes: readonly string[]): boolean {
    return codes.some((code) => this.held.has(code));
  }

  /** The current input. Consumes the latched one-shot action. */
  sample(): InputSample {
    const action = this.pendingAction ?? 'none';
    this.pendingAction = undefined;
    const [thrust, yaw, pitch, roll, up] = AXES.map((axis) => this.axis(axis)) as [
      number,
      number,
      number,
      number,
      number,
    ];
    return {
      thrust,
      yaw,
      pitch,
      roll,
      up,
      brake: this.any(this.map.brake),
      fire: this.any(this.map.fire),
      lock: this.any(this.map.lock),
      action,
    };
  }

  /** Wires the state to a window's key and blur events; returns a function that unwires it. */
  attach(target: Window): () => void {
    const down = (event: KeyboardEvent): void => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (this.keyDown(event.code, event.target)) event.preventDefault();
    };
    const up = (event: KeyboardEvent): void => this.keyUp(event.code);
    const blur = (): void => this.releaseAll();
    target.addEventListener('keydown', down);
    target.addEventListener('keyup', up);
    target.addEventListener('blur', blur);
    return () => {
      target.removeEventListener('keydown', down);
      target.removeEventListener('keyup', up);
      target.removeEventListener('blur', blur);
    };
  }
}
