/**
 * Client mining-channel state (TASK-38) — the HUD's single source of
 * truth, fed ONLY by the server's 'mining' frames (the 10 Hz active echo +
 * one final 'ended' frame). The radial progress, the '+1 <resource>' float
 * and the 'Backpack full' / 'Depleted' prompts are all derived here — the
 * client NEVER runs its own channel timer (the server's clock is the only
 * truth, so two client clocks can never desync the UI).
 *
 * Subscribe/emit idiom (state/inventory.ts): set → emit on change; late
 * subscribers get the current value. HUD only — never feeds prediction or
 * the input loop.
 */

/** The wire shape of an active channel echo (phase:'active'). */
export interface MiningActiveFrame {
  depositId: string;
  /** Progress 0..1 through the current 1.5 s unit (server echo). */
  progress: number;
  /** Units already awarded in this channel. */
  units: number;
  /** 'full': at the weight cap — the channel is PAUSED ('Backpack full'). */
  status: 'mining' | 'full';
}

/** The wire shape of the final channel frame (phase:'ended'). */
export interface MiningEndedFrame {
  depositId: string;
  /** stopped: E released; cancelled: out of range / character gone; depleted: the deposit ran out. */
  reason: 'stopped' | 'cancelled' | 'depleted';
  /** Units awarded in total. */
  units: number;
}

/** The channel view the HUD renders (idle until the first echo). */
export type MiningView =
  | { kind: 'idle' }
  | { kind: 'active'; frame: MiningActiveFrame }
  | { kind: 'ended'; frame: MiningEndedFrame };

/**
 * One '+1 <resource>' float event: the counter increments per awarded unit
 * (the HUD re-keys its CSS fade on `key`); `resource` is the deposit's
 * resource (the client looks it up in the target list when the unit lands).
 */
export interface MiningGain {
  key: number;
  resource: string;
}

type Listener = () => void;
const listeners = new Set<Listener>();
let view: MiningView = { kind: 'idle' };
let gain: MiningGain | null = null;

/**
 * A phase:'active' echo (null clears back to idle). The gain float fires
 * when the echo's unit counter ADVANCES on the same deposit (exactly one
 * increment per awarded unit — the server cadence, not the frame rate).
 */
export function setMiningActive(
  frame: MiningActiveFrame | null,
  gainResource: string | null = null,
): void {
  const prev = view.kind === 'active' ? view.frame : null;
  if (frame === null) {
    if (view.kind === 'active') {
      view = { kind: 'idle' };
      emit();
    }
    return;
  }
  if (prev && prev.depositId === frame.depositId && frame.units > prev.units) {
    gain = {
      key: (gain?.key ?? 0) + 1,
      resource: gainResource ?? gain?.resource ?? 'ore',
    };
  }
  view = { kind: 'active', frame };
  emit();
}

/**
 * A phase:'ended' frame (the channel died: stopped / cancelled / depleted).
 * The 'Depleted' prompt lingers from this (a 'stopped'/'cancelled' end just
 * hides the HUD). A unit landing on the LAST (depleting) award still
 * triggers its gain float (the ended frame carries the final counter).
 */
export function setMiningEnded(
  frame: MiningEndedFrame | null,
  gainResource: string | null = null,
): void {
  const prev = view.kind === 'active' ? view.frame : null;
  if (frame && prev && prev.depositId === frame.depositId && frame.units > prev.units) {
    gain = { key: (gain?.key ?? 0) + 1, resource: gainResource ?? gain?.resource ?? 'ore' };
  }
  view = frame ? { kind: 'ended', frame } : { kind: 'idle' };
  emit();
}

/** The current channel view (idle until the first echo). */
export function miningView(): MiningView {
  return view;
}

/** The latest gain float (null before the first awarded unit). */
export function miningGain(): MiningGain | null {
  return gain;
}

/** Subscribe to channel changes. Returns the unsubscribe. */
export function miningSubscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function emit(): void {
  for (const fn of [...listeners]) fn();
}

/** Test helper: reset (mirrors __resetInventory). */
export function __resetMining(): void {
  listeners.clear();
  view = { kind: 'idle' };
  gain = null;
}
