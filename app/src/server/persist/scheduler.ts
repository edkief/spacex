/** Timer abstraction so the interval save can be driven by a fake in tests. */
export interface Scheduler {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/** Real timers; unref'd so a pending save interval never keeps the process alive. */
export const realScheduler: Scheduler = {
  setInterval: (callback, ms) => {
    const handle = setInterval(callback, ms);
    handle.unref();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};
