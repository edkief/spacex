import { beforeEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { __resetDockedIndicator, setDockedIndicator } from '@client/state/docked';

import { DockedIndicator } from './docked-indicator';

describe('DockedIndicator overlay (TASK-29.3)', () => {
  beforeEach(() => __resetDockedIndicator());

  it('renders the single #docked-indicator node with DOCKED text when docked', () => {
    setDockedIndicator(true);
    const html = renderToStaticMarkup(<DockedIndicator />);
    expect(html).toContain('id="docked-indicator"');
    expect(html).toContain('DOCKED');
    expect(html).toContain('role="status"');
    expect(html).toContain('pointer-events:none');
    expect(html).toContain('z-index:85');
    expect(html).toContain('ui-monospace');
  });

  it('unmounts (renders null) while the ship is not docked', () => {
    expect(renderToStaticMarkup(<DockedIndicator />)).toBe('');
    setDockedIndicator(true);
    setDockedIndicator(false);
    expect(renderToStaticMarkup(<DockedIndicator />)).toBe('');
  });
});
