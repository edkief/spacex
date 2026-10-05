/**
 * TASK-55: the settings REST client (GET/PUT /api/players/settings).
 *
 * Thin fetch wrappers — the UI never builds auth headers itself (the
 * panel gets the bearer token from the session store). Every failure
 * resolves to `null` / `false`: a settings write that can't reach the
 * server is cosmetic (the local store already applied the change LIVE —
 * the SettingsBridge), so the panel never blocks on it.
 */
import { type Settings, type SettingsUpdate } from '@shared/settings';

export function fetchSettings(token: string): Promise<Settings | null> {
  return fetch('/api/players/settings', {
    headers: { authorization: `Bearer ${token}` },
  })
    .then((res) => (res.ok ? (res.json() as Promise<Settings>) : null))
    .catch(() => null);
}

/** PUT a partial update; resolves true when the server accepted it. */
export function putSettings(token: string, update: SettingsUpdate): Promise<boolean> {
  return fetch('/api/players/settings', {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(update),
  })
    .then((res) => res.ok)
    .catch(() => false);
}
