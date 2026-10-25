import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';

export interface TestServer {
  url: string;
  close(): Promise<void>;
}

/** Support CONNECT and absolute-form requests from ProxyAgent. */
export async function startHttpProxy(): Promise<TestServer & { seen: string[] }> {
  const seen: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = http.createServer((request, response) => {
    seen.push(request.url ?? '');
    const target = new URL(request.url ?? '');
    const upstream = http.request(target, { method: request.method, headers: request.headers }, (reply) => {
      response.writeHead(reply.statusCode ?? 502, reply.headers);
      reply.pipe(response);
    });
    request.pipe(upstream);
  });
  server.on('connect', (request, client: net.Socket, head) => {
    seen.push(`CONNECT ${request.url ?? ''}`);
    const [host = '', port = '80'] = (request.url ?? '').split(/:(?=\d+$)/);
    const upstream = net.connect({ host, port: Number(port) }, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
    sockets.add(client);
    sockets.add(upstream);
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export async function startEchoServer(host = '127.0.0.1'): Promise<TestServer & { port: number }> {
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          method: request.method,
          path: request.url,
          marker: request.headers['x-marker'] ?? null,
          body: Buffer.concat(chunks).toString(),
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${host.includes(':') ? `[${host}]` : host}:${port}`,
    port,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
