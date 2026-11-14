import type { Timers } from '../timers.ts';

interface Entry {
  id: number;
  due: number;
  callback: () => void;
  interval: number | undefined;
}

/** Manually advanced time: a fake clock plus timers that fire only inside `advance`. */
export class FakeTimers implements Timers {
  private current: number;
  private nextId = 1;
  private entries: Entry[] = [];

  constructor(start = Date.UTC(2030, 0, 1)) {
    this.current = start;
  }

  /** Epoch milliseconds of the fake clock. */
  now = (): number => this.current;

  setTimeout(callback: () => void, ms: number): unknown {
    return this.add(callback, ms, undefined);
  }

  setInterval(callback: () => void, ms: number): unknown {
    return this.add(callback, ms, ms);
  }

  clearTimeout(handle: unknown): void {
    this.entries = this.entries.filter((entry) => entry.id !== handle);
  }

  clearInterval(handle: unknown): void {
    this.clearTimeout(handle);
  }

  /** Number of timers still pending. */
  get pending(): number {
    return this.entries.length;
  }

  /** Moves time forward, firing due timers in order (intervals reschedule themselves). */
  advance(ms: number): void {
    const end = this.current + ms;
    for (;;) {
      const next = this.entries
        .filter((e) => e.due <= end)
        .sort((a, b) => a.due - b.due || a.id - b.id)[0];
      if (!next) break;
      this.current = next.due;
      if (next.interval === undefined) this.clearTimeout(next.id);
      else next.due += next.interval;
      next.callback();
    }
    this.current = end;
  }

  private add(callback: () => void, ms: number, interval: number | undefined): number {
    const id = this.nextId++;
    this.entries.push({ id, due: this.current + ms, callback, interval });
    return id;
  }
}
