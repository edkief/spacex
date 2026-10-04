// @vitest-environment happy-dom
/**
 * TASK-52: interaction line tests — the single bottom-center prompt line
 * (the '#interact-prompt' pill, hidden when nothing is in range), the mining
 * radial drawn around it ('#mining-hud', the conic-gradient angle written by
 * the rAF loop from the server's miningProgress — verified with a live
 * render), and the 'Backpack full' / 'Depleted' states. The prompt EXCLUSIVITY
 * (two targets in range → only the nearest shows) is enforced one level
 * below, by the raycast (interaction.test.ts: resolveInteract +
 * nextPromptState — this line renders EXACTLY the one resolved prompt).
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { __resetMining, setMiningActive, setMiningEnded } from '@client/state/mining';

import { InteractionLine, miningHudStatus, miningRingGradient } from './interaction-line';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  __resetMining();
});

function mount(text: string | null): void {
  act(() => root.render(<InteractionLine text={text} />));
}

describe('mining helpers (TASK-38, moved into the line)', () => {
  it('miningRingGradient maps 0..1 to 0..360 deg (clamped)', () => {
    expect(miningRingGradient(0)).toBe('conic-gradient(#7dd3fc 0deg, rgba(42, 51, 70, 0.55) 0deg)');
    expect(miningRingGradient(0.25)).toBe(
      'conic-gradient(#7dd3fc 90deg, rgba(42, 51, 70, 0.55) 90deg)',
    );
    expect(miningRingGradient(1)).toBe(
      'conic-gradient(#7dd3fc 360deg, rgba(42, 51, 70, 0.55) 360deg)',
    );
    expect(miningRingGradient(2)).toBe(miningRingGradient(1)); // clamped
    expect(miningRingGradient(-1)).toBe(miningRingGradient(0)); // clamped
  });

  it('miningHudStatus: full → Backpack full, depleted → Depleted, else nothing', () => {
    expect(
      miningHudStatus({
        kind: 'active',
        frame: { depositId: 'd', progress: 0.5, units: 1, status: 'full' },
      }),
    ).toBe('Backpack full');
    expect(
      miningHudStatus({
        kind: 'active',
        frame: { depositId: 'd', progress: 0.5, units: 1, status: 'mining' },
      }),
    ).toBeNull();
    expect(
      miningHudStatus({ kind: 'ended', frame: { depositId: 'd', reason: 'depleted', units: 3 } }),
    ).toBe('Depleted');
    expect(
      miningHudStatus({ kind: 'ended', frame: { depositId: 'd', reason: 'stopped', units: 3 } }),
    ).toBeNull();
    expect(miningHudStatus({ kind: 'idle' })).toBeNull();
  });
});

describe('InteractionLine (TASK-52)', () => {
  it('renders null (zero cost) when nothing is in range and no channel runs', () => {
    mount(null);
    expect(container.innerHTML).toBe('');
  });

  it('renders the #interact-prompt line exactly while a prompt is up', () => {
    mount('[E] Take iron x3');
    expect(container.innerHTML).toContain('id="interact-prompt"');
    expect(container.innerHTML).toContain('[E] Take iron x3');
    expect(container.innerHTML).not.toContain('id="mining-hud"');

    mount(null);
    expect(container.innerHTML).toBe('');
  });

  it('draws the mining radial AROUND the line while a channel runs (rAF angle write)', async () => {
    setMiningActive({ depositId: 'd1', progress: 0.25, units: 2, status: 'mining' });
    mount('Hold [E] to mine iron');
    expect(container.innerHTML).toContain('id="mining-hud"');
    // The units counter sits inside the ring.
    expect(container.innerHTML).toContain('Hold [E] to mine iron');

    // Let the rAF loop run (happy-dom's rAF is real-time) — the angle write
    // lands on the ref'd div (no React re-render).
    const ring = container.querySelector('#mining-hud > div') as HTMLDivElement;
    expect(ring).toBeTruthy();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(ring.style.background).toBe(miningRingGradient(0.25));

    // A new server echo moves the angle on the NEXT frame.
    act(() => {
      setMiningActive({ depositId: 'd1', progress: 0.75, units: 3, status: 'mining' });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(ring.style.background).toBe(miningRingGradient(0.75));
  });

  it("shows 'Backpack full' while the channel is paused at the cap", () => {
    setMiningActive({ depositId: 'd1', progress: 1, units: 9, status: 'full' });
    mount('Hold [E] to mine iron');
    expect(container.innerHTML).toContain('Backpack full');
  });

  it("shows 'Depleted' after a depleted end frame", () => {
    setMiningEnded({ depositId: 'd1', reason: 'depleted', units: 4 });
    mount(null);
    expect(container.innerHTML).toContain('Depleted');
  });
});
