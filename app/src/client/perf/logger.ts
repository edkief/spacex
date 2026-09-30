/**
 * TASK-57: minimal perf logger with an injectable sink. The perf layer
 * (frameMonitor budget checks, TASK-30/58/59/61) warns through this so
 * tests can spy on emission without touching the console.
 */

export interface PerfLogMeta {
  [key: string]: unknown;
}

export type PerfLogSink = (message: string, meta?: PerfLogMeta) => void;

const defaultSink: PerfLogSink = (message, meta) => {
  console.warn(`[perf] ${message}`, meta ?? '');
};

let sink: PerfLogSink = defaultSink;

/** Log a perf warning through the current sink. */
export function perfWarn(message: string, meta?: PerfLogMeta): void {
  sink(message, meta);
}

/** Replace the log sink (tests); null restores the default console sink. */
export function setPerfLogSink(next: PerfLogSink | null): void {
  sink = next ?? defaultSink;
}
