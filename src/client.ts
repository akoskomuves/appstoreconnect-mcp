import { TokenProvider } from './auth.js';
import type { Config } from './config.js';
import { ASCError } from './errors.js';

const ASC_BASE_URL = 'https://api.appstoreconnect.apple.com';

export interface ASCClient {
  request<T>(path: string, init?: RequestInit): Promise<T>;
}

export function createASCClient(config: Config): ASCClient {
  const tokens = new TokenProvider(config);

  async function send(url: string, init: RequestInit): Promise<Response> {
    const token = await tokens.getToken();
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${token}`);
    headers.set('accept', 'application/json');
    if (init.body && !headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }
    return fetch(url, { ...init, headers });
  }

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = path.startsWith('http') ? path : `${ASC_BASE_URL}${path}`;

    let response = await send(url, init);
    if (response.status === 401) {
      tokens.invalidate();
      response = await send(url, init);
    }

    if (!response.ok) {
      let details: unknown;
      try {
        details = await response.json();
      } catch {
        details = await response.text().catch(() => undefined);
      }
      throw new ASCError(
        response.status,
        `App Store Connect API ${response.status} on ${init.method ?? 'GET'} ${path}`,
        details,
      );
    }

    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  return { request };
}
