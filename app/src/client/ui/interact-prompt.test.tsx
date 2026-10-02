import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { InteractPrompt } from './interact-prompt';

describe('InteractPrompt (TASK-33)', () => {
  it('renders #interact-prompt with the prompt text when the raycast has a target', () => {
    const html = renderToStaticMarkup(<InteractPrompt text="[E] Take ore" />);
    expect(html).toContain('id="interact-prompt"');
    expect(html).toContain('[E] Take ore');
    expect(html).toContain('role="status"');
    // Bottom-center affordance, pointer-transparent (never blocks the view).
    expect(html).toContain('bottom:4.5rem');
    expect(html).toContain('pointer-events:none');
  });

  it('renders null (zero cost) when nothing is in range', () => {
    expect(renderToStaticMarkup(<InteractPrompt text={null} />)).toBe('');
  });
});
