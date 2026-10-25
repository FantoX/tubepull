import type * as Undici from 'undici';
import { InvalidArgumentError } from '../errors.js';

/** Use undici's fetch so its dispatcher matches the client. */
export async function createProxyFetch(proxy: string): Promise<typeof fetch> {
  try {
    new URL(proxy);
  } catch {
    throw new InvalidArgumentError(`Invalid proxy URL: ${proxy}`);
  }
  if (!/^https?:/i.test(proxy)) {
    throw new InvalidArgumentError(`Unsupported proxy protocol in ${proxy}; use http:// or https://.`);
  }
  let undici: typeof Undici;
  try {
    undici = await import('undici');
  } catch (cause) {
    throw new InvalidArgumentError('Proxy support needs the optional "undici" package: npm i undici', {
      cause,
    });
  }
  const dispatcher = new undici.ProxyAgent(proxy);
  const proxied = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    // Unpack Node's Request: undici would otherwise stringify it as a URL.

    if (input instanceof Request) {
      const fromRequest: RequestInit = {
        method: input.method,
        headers: input.headers,
        redirect: input.redirect,
        signal: input.signal,
      };
      if (init?.body === undefined && input.body) fromRequest.body = await input.arrayBuffer();
      return undici.fetch(input.url, { ...fromRequest, ...init, dispatcher } as never) as unknown as Response;
    }
    return undici.fetch(input as never, { ...init, dispatcher } as never) as unknown as Response;
  };
  return proxied as typeof fetch;
}
