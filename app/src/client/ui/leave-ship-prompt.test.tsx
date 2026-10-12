import { beforeEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { __resetDockedIndicator, setDockedIndicator } from '@client/state/docked';
import { __resetCanExitShip, setCanExitShip } from '@client/state/exit-ship';

import { LeaveShipPrompt } from './leave-ship-prompt';

describe('LeaveShipPrompt (TASK-31, TASK-105)', () => {
  beforeEach(() => {
    __resetDockedIndicator();
    __resetCanExitShip();
  });

  it('renders #leave-ship-prompt with the E key cap while pad-docked', () => {
    setDockedIndicator(true);
    const html = renderToStaticMarkup(<LeaveShipPrompt />);
    expect(html).toContain('id="leave-ship-prompt"');
    expect(html).toContain('LEAVE SHIP');
    expect(html).toContain('role="status"');
    expect(html).toContain('pointer-events:none');
    expect(html).toContain('ui-monospace');
  });

  it('renders the SAME prompt while landed on the surface off-pad (TASK-105)', () => {
    // Not docked (the DOCKED indicator is hidden) but the ship is landed:
    // the can-exit store alone carries the affordance. The text reads
    // accurately for both states ("LEAVE SHIP" off a pad-docked ship and a
    // surface-landed ship alike).
    setCanExitShip(true);
    const html = renderToStaticMarkup(<LeaveShipPrompt />);
    expect(html).toContain('id="leave-ship-prompt"');
    expect(html).toContain('LEAVE SHIP');
    expect(html).toContain('role="status"');
  });

  it('unmounts (renders null) while not docked and not landed (on foot, in flight, or in space)', () => {
    expect(renderToStaticMarkup(<LeaveShipPrompt />)).toBe('');

    // In flight: neither store is armed.
    setDockedIndicator(false);
    setCanExitShip(false);
    expect(renderToStaticMarkup(<LeaveShipPrompt />)).toBe('');

    // Docked, then both stores clear (the disembark frame) → gone.
    setDockedIndicator(true);
    expect(renderToStaticMarkup(<LeaveShipPrompt />)).toContain('id="leave-ship-prompt"');
    setDockedIndicator(false);
    setCanExitShip(false);
    expect(renderToStaticMarkup(<LeaveShipPrompt />)).toBe('');
  });
});
