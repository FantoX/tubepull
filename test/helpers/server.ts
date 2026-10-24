import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

/** What to do with one request. `undefined` serves it normally. */
export type Fault =
  | undefined
  | { kind: 'status'; status: number; retryAfter?: string }
  | { kind: 'drop'; afterBytes: number }
  | { kind: 'stall'; afterBytes: number };

export interface RequestRecord {
  path: string;
  query: URLSearchParams;
  start: number;
  end: number;
  status: number;
  bytes: number;
  headers: http.IncomingHttpHeaders;
}

export interface MediaServerOptions {
  /** How the server reads ranges: googlevideo-style `range=` query, standard header, or ignore ranges. */
  rangeMode?: 'query' | 'header' | 'ignore';
  /** Called for every request, in order; return a fault to inject. */
  fault?: (request: { path: string; index: number; perPath: number; start: number }) => Fault;
  /** Hide Content-Length on full responses (unknown size). */
  hideLength?: boolean;
}

export interface MediaServer {
  url: string;
  requests: RequestRecord[];
  bytesServed(path?: string): number;
  close(): Promise<void>;
}

/**
 * This function is used for a local HTTP server that serves byte ranges of in-memory files, with
 * deterministic fault injection for retry/resume tests.
 */
export async function startMediaServer(
  files: Record<string, Buffer>,
  options: MediaServerOptions = {},
): Promise<MediaServer> {
  const { rangeMode = 'query' } = options;
  const requests: RequestRecord[] = [];
  const perPath = new Map<string, number>();
  const sockets = new Set<Socket>();
  let index = 0;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const data = files[path];
    const count = (perPath.get(path) ?? 0) + 1;
    perPath.set(path, count);

    let start = 0;
    let end = data ? data.length - 1 : 0;
    let partial = false;
    if (rangeMode === 'query' && url.searchParams.has('range')) {
      const [a, b] = (url.searchParams.get('range') ?? '').split('-').map(Number);
      start = a ?? 0;
      end = Math.min(b ?? end, end);
    } else if (rangeMode === 'header' && req.headers.range) {
      const match = /bytes=(\d+)-(\d*)/.exec(req.headers.range);
      start = Number(match?.[1] ?? 0);
      end = match?.[2] ? Math.min(Number(match[2]), end) : end;
      partial = true;
    }

    const record: RequestRecord = {
      path,
      query: url.searchParams,
      start,
      end,
      status: 200,
      bytes: 0,
      headers: req.headers,
    };
    requests.push(record);
    const fault = options.fault?.({ path, index: index++, perPath: count, start });

    if (!data) {
      record.status = 404;
      res.writeHead(404).end('not found');
      return;
    }
    if (fault?.kind === 'status') {
      record.status = fault.status;
      res.writeHead(fault.status, fault.retryAfter ? { 'Retry-After': fault.retryAfter } : {}).end('fault');
      return;
    }
    if (start >= data.length) {
      record.status = 416;
      res.writeHead(416, { 'Content-Range': `bytes */${data.length}` }).end();
      return;
    }

    const body = data.subarray(start, end + 1);
    const headers: http.OutgoingHttpHeaders = { 'Content-Type': 'application/octet-stream' };
    if (!options.hideLength) headers['Content-Length'] = body.length;
    if (partial) headers['Content-Range'] = `bytes ${start}-${end}/${data.length}`;
    record.status = partial ? 206 : 200;
    res.writeHead(record.status, headers);

    if (fault?.kind === 'drop' || fault?.kind === 'stall') {
      const head = body.subarray(0, Math.min(fault.afterBytes, body.length));
      record.bytes = head.length;
      res.write(head, () => {
        if (fault.kind === 'drop') setTimeout(() => res.socket?.destroy(), 20);
        // 'stall': never finish; the client must time out.
      });
      return;
    }
    record.bytes = body.length;
    res.end(body);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    bytesServed: (path?: string) =>
      requests.filter((r) => !path || r.path === path).reduce((n, r) => n + r.bytes, 0),
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/** Deterministic pseudo-random bytes. */
export function randomBuffer(size: number, seed = 1): Buffer {
  const out = Buffer.allocUnsafe(size);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < size; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}
