import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InvalidArgumentError } from '../../src/index.js';
import { createProxyFetch } from '../../src/utils/proxy.js';
import { startEchoServer, startHttpProxy, type TestServer } from '../helpers/proxies.js';

let origin: TestServer & { port: number };
let proxy: TestServer & { seen: string[] };

beforeAll(async () => {
  origin = await startEchoServer();
  proxy = await startHttpProxy();
});
afterAll(async () => {
  await proxy.close();
  await origin.close();
});

async function echo(response: Response) {
  expect(response.status).toBe(200);
  return (await response.json()) as { method: string; path: string; marker: string | null; body: string };
}

describe('HTTP proxy', () => {
  it('routes plain URLs through the proxy', async () => {
    const proxied = await createProxyFetch(proxy.url);
    expect(await echo(await proxied(`${origin.url}/plain?x=1`))).toMatchObject({
      method: 'GET',
      path: '/plain?x=1',
    });
    expect(proxy.seen.join(' ')).toContain(`127.0.0.1:${origin.port}/plain`);
  });

  it('accepts a built-in Request (regression: it became the URL "[object Request]")', async () => {
    const proxied = await createProxyFetch(proxy.url);
    const request = new Request(`${origin.url}/player`, { method: 'POST', body: 'from-request' });
    expect(await echo(await proxied(request))).toMatchObject({
      method: 'POST',
      path: '/player',
      body: 'from-request',
    });
    // youtubei.js style: the Request carries URL and method, init carries body and headers.
    const reply = await echo(
      await proxied(new Request(`${origin.url}/next`, { method: 'POST' }), {
        body: 'from-init',
        headers: { 'x-marker': 'init-header' },
      }),
    );
    expect(reply).toMatchObject({ method: 'POST', path: '/next', body: 'from-init', marker: 'init-header' });
  });
});

describe('proxy URLs', () => {
  it('rejects unsupported schemes and garbage', async () => {
    await expect(createProxyFetch('ftp://127.0.0.1:21')).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(createProxyFetch('socks5://127.0.0.1:1080')).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(createProxyFetch('not a url')).rejects.toBeInstanceOf(InvalidArgumentError);
  });
});
