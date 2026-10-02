import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PresenceStore } from '@client/net/presence';
import { PlayerList } from './player-list';

/**
 * TASK-36 step 4: the PlayerList regime icons — a walking figure
 * (data-mode="foot") for on-foot players vs a ship (data-mode="ship") in the
 * cockpit. Static markup with a REAL PresenceStore: applyActiveEntities
 * flips the icons exactly when the entity list changes.
 */

const ME = { playerId: 'p-me', callsign: 'drifter' };

function store(): PresenceStore {
  const s = new PresenceStore();
  s.setSelf(ME);
  return s;
}

describe('PlayerList regime icons', () => {
  it('renders the self row (on foot) + a foot row for a remote character', () => {
    const s = store();
    s.setSelfOnFoot(true);
    s.applySnapshot([{ playerId: 'p-a', callsign: 'alice', shipId: 's-a' }]);
    s.applyActiveEntities([{ kind: 'character', playerId: 'p-a', callsign: 'alice' }]);

    const html = renderToStaticMarkup(<PlayerList store={s} />);
    expect(html).toContain('drifter (you)');
    expect(html.match(/data-mode="foot"/g)).toHaveLength(2); // self + alice
    expect(html).not.toContain('data-mode="ship"');
  });

  it('switches the remote row to the ship icon when the character leaves', () => {
    const s = store();
    s.setSelfOnFoot(true);
    s.applySnapshot([{ playerId: 'p-a', callsign: 'alice', shipId: 's-a' }]);
    s.applyActiveEntities([{ kind: 'character', playerId: 'p-a', callsign: 'alice' }]);
    s.applyActiveEntities([{ kind: 'ship', playerId: 'p-a', callsign: 'alice' }]); // re-entered

    const html = renderToStaticMarkup(<PlayerList store={s} />);
    expect(html.match(/data-mode="foot"/g)).toHaveLength(1); // self only
    expect(html.match(/data-mode="ship"/g)).toHaveLength(1); // alice back in the ship
  });

  it('renders nothing without a self row', () => {
    expect(renderToStaticMarkup(<PlayerList store={new PresenceStore()} />)).toBe('');
  });
});
