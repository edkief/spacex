// @vitest-environment happy-dom
/**
 * TASK-53: the ESC menu — the centered modal shell (Resume / Systems /
 * Ships / Settings + the credits + callsign footer). Resume / Systems /
 * Ships call back to the menu stack (main.tsx owns the pops and the
 * chart/panel opens); Settings is the TASK-55 stub (toggles a status
 * line). The "world keeps moving" note is on the surface (multiplayer:
 * no pause, by design).
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetMenu, openMenu } from '@client/state/menu';

import { EscMenu } from './esc-menu';

let roots: Root[] = [];

function renderMenu(
  over: Partial<Parameters<typeof EscMenu>[0]> = {},
): HTMLDivElement {
  openMenu(); // the menu must be the top surface (its trap is live)
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <EscMenu
        callsign={over.callsign ?? 'Raven'}
        credits={over.credits === undefined ? 120 : over.credits}
        onResume={over.onResume ?? (() => {})}
        onSystems={over.onSystems ?? (() => {})}
        onShips={over.onShips ?? (() => {})}
      />,
    );
  });
  roots.push(root);
  return container;
}

const click = (el: HTMLDivElement, id: string): void => {
  act(() => {
    el.querySelector<HTMLButtonElement>(id)?.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
  });
};

beforeEach(() => __resetMenu());

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots = [];
  document.body.innerHTML = '';
});

describe('EscMenu (TASK-53)', () => {
  it('renders #esc-menu with the four items + the credits/callsign footer', () => {
    const el = renderMenu();
    expect(el.querySelector('#esc-menu')?.getAttribute('role')).toBe('dialog');
    for (const id of [
      '#esc-menu-resume',
      '#esc-menu-systems',
      '#esc-menu-ships',
      '#esc-menu-settings',
    ]) {
      expect(el.querySelector(id), `${id} rendered`).not.toBeNull();
    }
    expect(el.querySelector('#esc-menu-credits')?.textContent).toBe('120 cr');
    expect(el.querySelector('#esc-menu-callsign')?.textContent).toBe('Raven');
  });

  it('shows a dash footer before the first balance lands (null credits)', () => {
    const el = renderMenu({ credits: null });
    expect(el.querySelector('#esc-menu-credits')?.textContent).toBe('— cr');
  });

  it('documents that the world keeps moving (no pause — multiplayer)', () => {
    const el = renderMenu();
    expect(el.querySelector('#esc-menu')?.textContent).toContain(
      'The world keeps moving while the menu is open.',
    );
  });

  it('Resume / Systems / Ships each call back to the menu stack', () => {
    const onResume = vi.fn();
    const onSystems = vi.fn();
    const onShips = vi.fn();
    const el = renderMenu({ onResume, onSystems, onShips });
    click(el, '#esc-menu-resume');
    expect(onResume).toHaveBeenCalledTimes(1);
    click(el, '#esc-menu-systems');
    expect(onSystems).toHaveBeenCalledTimes(1);
    click(el, '#esc-menu-ships');
    expect(onShips).toHaveBeenCalledTimes(1);
  });

  it('Settings toggles the TASK-55 stub line (aria-pressed tracks it)', () => {
    const el = renderMenu();
    const btn = el.querySelector<HTMLButtonElement>('#esc-menu-settings');
    expect(btn?.getAttribute('aria-pressed')).toBe('false');
    expect(el.querySelector('#esc-menu-settings-stub')).toBeNull();
    click(el, '#esc-menu-settings');
    expect(el.querySelector('#esc-menu-settings')?.getAttribute('aria-pressed')).toBe('true');
    expect(el.querySelector('#esc-menu-settings-stub')?.textContent).toContain('TASK-55');
    click(el, '#esc-menu-settings');
    expect(el.querySelector('#esc-menu-settings-stub')).toBeNull();
  });
});
