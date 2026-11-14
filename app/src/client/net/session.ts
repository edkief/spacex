const TOKEN_KEY = 'drift.session.token';

/** What the server returns for a claimed or resumed session. */
export interface SessionInfo {
  token: string;
  playerId: string;
  callsign: string;
  shipId: string;
  homeSystemId: string;
}

/** A failed REST call, carrying the server's structured error code. */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

type Fetch = typeof fetch;

/** Parses a JSON response, turning non-2xx answers into ApiError with the server's code. */
async function readJson(response: Response): Promise<Record<string, unknown>> {
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (response.ok) return body;
  const code = typeof body['code'] === 'string' ? body['code'] : 'internal';
  const message = typeof body['message'] === 'string' ? body['message'] : response.statusText;
  throw new ApiError(response.status, code, message);
}

/** Reads the stored session token; storage may be unavailable (private mode), then undefined. */
export function loadToken(storage: Pick<Storage, 'getItem'> = localStorage): string | undefined {
  try {
    return storage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function storeToken(token: string, storage: Pick<Storage, 'setItem'> = localStorage): void {
  try {
    storage.setItem(TOKEN_KEY, token);
  } catch {
    // Without storage the session simply does not survive a reload.
  }
}

export function clearToken(storage: Pick<Storage, 'removeItem'> = localStorage): void {
  try {
    storage.removeItem(TOKEN_KEY);
  } catch {
    // Nothing to clear.
  }
}

/** Claims a callsign: POST /api/callsigns. Throws ApiError (e.g. `callsign-taken`). */
export async function claimCallsign(
  callsign: string,
  fetcher: Fetch = fetch,
): Promise<SessionInfo> {
  const response = await fetcher('/api/callsigns', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callsign }),
  });
  return (await readJson(response)) as unknown as SessionInfo;
}

/** Resumes a stored session: GET /api/session. Undefined when the token is no longer valid. */
export async function resumeSession(
  token: string,
  fetcher: Fetch = fetch,
): Promise<SessionInfo | undefined> {
  const response = await fetcher('/api/session', { headers: { authorization: `Bearer ${token}` } });
  if (response.status === 401) return undefined;
  const body = await readJson(response);
  return { ...(body as unknown as Omit<SessionInfo, 'token'>), token };
}

/** What the client needs before connecting: GET /api/config. */
export interface ClientConfig {
  galaxySeed: string;
  wsPath: string;
  protocolVersion: number;
}

/** Fetches the galaxy seed, socket path and protocol version from the server. */
export async function fetchClientConfig(fetcher: Fetch = fetch): Promise<ClientConfig> {
  const body = await readJson(await fetcher('/api/config'));
  if (typeof body['galaxySeed'] !== 'string' || typeof body['wsPath'] !== 'string') {
    throw new Error('malformed /api/config response');
  }
  return body as unknown as ClientConfig;
}
