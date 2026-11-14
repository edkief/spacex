import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '@client/App';
import { getDriftCanvas } from '@client/canvas';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('client shell', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders the shell without touching the stable canvas', () => {
    document.body.innerHTML = '<canvas id="drift-canvas"></canvas><div id="root"></div>';
    const canvas = getDriftCanvas();
    const root = createRoot(document.getElementById('root') as HTMLElement);

    act(() => {
      root.render(<App />);
    });
    act(() => {
      root.render(<App />);
    });

    expect(document.querySelector('[data-testid="app-shell"]')?.textContent).toContain('Drift');
    expect(getDriftCanvas()).toBe(canvas);
  });

  it('throws a clear error when the canvas is missing', () => {
    expect(() => getDriftCanvas()).toThrow(/drift-canvas/);
  });
});
