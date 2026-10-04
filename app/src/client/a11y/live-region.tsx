/**
 * The screen-reader live region (TASK-54): the ONE `aria-live="polite"`
 * surface the whole client speaks through.
 *
 * Updates at 1 Hz (never the 10 Hz snapshot cadence — no announcement
 * spam). Each tick it drains the announcement queue (toasts/combat
 * events, max 1 pending, 2 s min interval) and otherwise shows the
 * current HUD summary. The text only changes state when it actually
 * differs, so an unchanged summary produces zero announcements.
 */
import React from 'react';
import { announcementQueue } from './announcement-queue';
import { hudSummary } from './summary';

/** The live-region tick (spec: 1 Hz). */
export const LIVE_REGION_INTERVAL_MS = 1_000;

/**
 * Builds the text to display this tick: a due announcement wins over the
 * summary (the summary returns on the next tick). Pure w.r.t. the clock.
 */
export function liveRegionText(now: number, summarize: () => string): string {
  const message = announcementQueue.flush(now);
  return message ?? summarize();
}

/**
 * Visually hidden (`aria-live` regions must render text to speak, but must
 * not take layout space): 1px clipped, overflow hidden, screen readers
 * still read it.
 */
const hiddenStyle: React.CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  border: 0,
};

export function LiveRegion(): React.ReactElement {
  const [text, setText] = React.useState('');
  const lastRef = React.useRef('');
  React.useEffect(() => {
    const id = window.setInterval(() => {
      const next = liveRegionText(Date.now(), hudSummary);
      if (next !== lastRef.current) {
        lastRef.current = next;
        setText(next);
      }
    }, LIVE_REGION_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, []);
  return (
    <div id="live-region" role="status" aria-live="polite" style={hiddenStyle}>
      {text}
    </div>
  );
}
