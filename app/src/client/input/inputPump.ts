import type { ClientPayload } from '@shared/protocol/registry.ts';
import type { InputSample } from './keyboardState.ts';

export interface InputPumpOptions {
  /** Sends per second; the server tick rate (20). */
  rate: number;
  sample: () => InputSample;
  send: (input: ClientPayload<'input'>) => void;
  /** First sequence number to use (continue after a reconnect so seq never goes backwards). */
  startSeq?: number;
  setInterval?: (callback: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

/**
 * Samples the input state at the server tick rate and sends it with a strictly increasing
 * sequence number. The sequence survives stop/start so a reconnect never reuses a number.
 */
export class InputPump {
  private seq: number;
  private handle: unknown;
  private readonly options: InputPumpOptions;

  constructor(options: InputPumpOptions) {
    this.options = options;
    this.seq = options.startSeq ?? 1;
  }

  /** The sequence number the next input will carry. */
  get nextSeq(): number {
    return this.seq;
  }

  start(): void {
    if (this.handle !== undefined) return;
    const set = this.options.setInterval ?? ((cb: () => void, ms: number) => setInterval(cb, ms));
    this.handle = set(() => this.pumpOnce(), 1000 / this.options.rate);
  }

  stop(): void {
    if (this.handle === undefined) return;
    const clear =
      this.options.clearInterval ??
      ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>));
    clear(this.handle);
    this.handle = undefined;
  }

  /** Sends one input now. */
  pumpOnce(): void {
    this.options.send({ seq: this.seq, ...this.options.sample() });
    this.seq += 1;
  }
}
