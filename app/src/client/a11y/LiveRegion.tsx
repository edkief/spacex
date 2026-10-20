/**
 * LiveRegion — TASK-54 (the screen-reader channel).
 *
 * Two `aria-live` regions, mounted once at the root of the HUD:
 *
 *   - **status** (`role="status"`, `aria-live="polite"`) — the
 *     1 Hz HUD summary ("Speed 120 meters per second. Hull 80
 *     percent."). The spec is explicit that this must be 1 Hz and
 *     not the 10 Hz HUD cadence: announcing every snapshot change
 *     makes the screen reader unusable.
 *   - **announcements** (`role="status"`, `aria-live="polite"`) —
 *     the queued transient events (joins / leaves, kills, "target
 *     locked", "low energy"). The {@link Announcer} enforces the
 *     "max 1 pending + 2 s min interval" rule so a firefight does
 *     not flood the reader.
 *
 * The component owns a single 1 Hz timer that (a) re-reads the
 * summary source and (b) drains the announcer queue.
 *
 * @see ./summary.ts for the sentence formatter.
 * @see ./announcer.ts for the queue.
 */

import { useEffect, useRef, useState } from "react";
import type * as React from "react";

import { announcer, type Announcer } from "./announcer.js";
import { formatHudSummary, type HudSummaryInput } from "./summary.js";

/** The status refresh cadence (ms). The spec asks for 1 Hz. */
export const LIVE_REGION_POLL_MS = 1_000;

/** Props for the live region. */
export interface LiveRegionProps {
  /**
   * Reads the current HUD numbers. Called once per second — keep
   * it cheap (a few field reads).
   */
  readSummary?: () => HudSummaryInput;
  /** The announcement queue (defaults to the process-wide one). */
  queue?: Announcer;
  /** Poll cadence (ms) — overridable for tests. */
  pollMs?: number;
}

/**
 * The screen-reader live regions. Mounted once by `App.tsx`.
 */
export function LiveRegion(props: LiveRegionProps): React.JSX.Element {
  const queue = props.queue ?? announcer;
  const pollMs = props.pollMs ?? LIVE_REGION_POLL_MS;
  const [summary, setSummary] = useState<string>("");
  const [announcement, setAnnouncement] = useState<string>("");

  // Subscribe to the announcement queue: a spoken announcement
  // replaces the region's text so the reader picks it up.
  useEffect(() => {
    return queue.subscribe((next) => {
      setAnnouncement(next === null ? "" : next.text);
    });
  }, [queue]);

  // The 1 Hz tick: refresh the summary + drain the queue. The
  // reader is held in a ref so an inline arrow prop doesn't tear
  // down the interval on every render.
  const readRef = useRef(props.readSummary);
  readRef.current = props.readSummary;
  useEffect(() => {
    const read = readRef.current;
    if (read === undefined) return;
    const tick = (): void => {
      setSummary(formatHudSummary(read()));
      queue.drain(Date.now());
    };
    tick();
    const id = window.setInterval(tick, pollMs);
    return () => {
      window.clearInterval(id);
    };
  }, [queue, pollMs]);

  return (
    <>
      <div
        data-testid="drift-live-status"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        style={visuallyHidden}
      >
        {summary}
      </div>
      <div
        data-testid="drift-live-announce"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        style={visuallyHidden}
      >
        {announcement}
      </div>
    </>
  );
}

/** The visually-hidden style used by the live regions. */
const visuallyHidden: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0,
};
