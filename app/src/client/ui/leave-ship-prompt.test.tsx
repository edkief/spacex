import { beforeEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { __resetDockedIndicator, setDockedIndicator } from '@client/state/docked';

import { LeaveShipPrompt } from './leave-ship-prompt';

describe('LeaveShipPrompt (TASK-31)', () => {
  beforeEach(() => __resetDockedIndicator());

  it('renders #leave-ship-prompt with the E key cap while docked', () => {
    setDockedIndicator(true);
    const html = renderToStaticMarkup(<LeaveShipPrompt />);
    expect(html).toContain('id="leave-ship-prompt"');
    expect(html).toContain('LEAVE SHIP');
    expect(html).toContain('role="status"');
    expect(html).toContain('pointer-events:none');
    expect(html).toContain('ui-monospace');
  });

  it('unmounts (renders null) while not docked (on foot or in flight)', () => {
    expect(renderToStaticMarkup(<LeaveShipPrompt />)).toBe('');
    setDockedIndicator(true);
    setDockedIndicator(false);
    expect(renderToStaticMarkup(<LeaveShipPrompt />)).toBe('');
  });
});
