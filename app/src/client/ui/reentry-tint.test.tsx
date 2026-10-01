import { beforeEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { __resetReentryTint, setReentryTint } from '@client/state/reentry';

import { ReentryTint } from './reentry-tint';

describe('ReentryTint overlay (TASK-28.2)', () => {
  beforeEach(() => __resetReentryTint());

  it('renders the orange rim with inline opacity = the live tint when tint > 0', () => {
    setReentryTint(0.25);
    const html = renderToStaticMarkup(<ReentryTint />);
    expect(html).toContain('id="reentry-tint"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('opacity:0.25');
    expect(html).toContain('pointer-events:none');
    expect(html).toContain('z-index:80');
    expect(html).toContain('radial-gradient(ellipse at center');
    expect(html).toContain('255,120,30');
  });

  it('tracks a different tint value in the rendered opacity', () => {
    setReentryTint(0.4);
    const html = renderToStaticMarkup(<ReentryTint />);
    expect(html).toContain('opacity:0.4');
  });

  it('unmounts (renders null) when the tint is 0 or below', () => {
    expect(renderToStaticMarkup(<ReentryTint />)).toBe('');
    setReentryTint(-1); // clamped to 0
    expect(renderToStaticMarkup(<ReentryTint />)).toBe('');
  });
});
