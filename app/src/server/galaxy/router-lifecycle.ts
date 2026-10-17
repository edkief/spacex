/**
 * Router lifecycle helpers (TASK-11).
 *
 * Encapsulates the `start()` (schedule reap sweep) and `shutdown()`
 * (clear timer + force-reap every shard) sequences so the router
 * module stays focused on the per-shard lifecycle. Both helpers
 * mutate the router's mutable state via the callbacks the caller
 * supplies.
 *
 * @see ./router.ts for the consumer.
 */

/** Configuration the lifecycle helpers need from the router. */
export interface RouterLifecycleDeps {
  reapIntervalMs: number;
  /** Run the sweep; called once per timer tick. */
  runSweep: () => Promise<unknown>;
  /** Clear the reap timer (used by shutdown). */
  clearTimer: () => void;
  /** Stop + clear every shard + flush. */
  reapAllForce: () => Promise<unknown>;
  /** Dispose the flush service (used by shutdown after reap). */
  disposeFlusher: () => void;
  /** Current timer handle; mutated by start/stop. */
  getTimer: () => ReturnType<typeof setInterval> | null;
  /** Set the timer handle. */
  setTimer: (timer: ReturnType<typeof setInterval> | null) => void;
  /** True once shutdown has been called. */
  getDisposed: () => boolean;
  setDisposed: (disposed: boolean) => void;
}

/** Schedule the reap sweep. Idempotent. */
export function routerStart(deps: RouterLifecycleDeps): void {
  if (deps.getDisposed()) return;
  if (deps.getTimer() !== null) return;
  const timer = setInterval(() => {
    void deps.runSweep();
  }, deps.reapIntervalMs);
  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    (timer as { unref: () => void }).unref();
  }
  deps.setTimer(timer);
}

/**
 * Stop the reap timer + reap every shard + flush + clear. Idempotent.
 * Used by the server graceful-shutdown hook (`SIGTERM/SIGINT`).
 */
export async function routerShutdown(deps: RouterLifecycleDeps): Promise<void> {
  if (deps.getDisposed()) return;
  deps.setDisposed(true);
  deps.clearTimer();
  // Reap with force=true to skip the grace window. flushShips runs
  // before sim.stop() so ship positions survive a subsequent kill.
  await deps.reapAllForce();
  deps.disposeFlusher();
}
