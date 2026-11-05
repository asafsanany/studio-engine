// Acting as people who come in through Tailscale Serve (Team plan, TM6). The engine listens on
// loopback and tells people apart by the `Tailscale-User-Login` / `Tailscale-User-Name` headers that
// Serve sets, trusted only on a loopback socket whose Host is one of the Mac's `*.ts.net` names
// (remote/access.ts, remote/viewer.ts). The e2e engine is told that name and the owner's login
// through config.json (`startEngine({ config })`); from here a request is a Serve request when it
// carries the Host and the headers, which is exactly what Serve sends:
//
//   rawRequest / ApiClient   node:http requests with the headers of a person, a Funnel visitor
//                            (Host, no login) or nobody, and the path sent byte for byte (`fetch`
//                            would tidy `..`, `//` and the like before they leave)
//   openStream               the live stream /api/events as one of them, frame by frame
//   startServeProxy          a loopback proxy a browser can use: it does what Serve does (replaces
//                            the Host, the Origin and the Tailscale headers), so the real web app
//                            can be driven as one person

import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  request,
  type Server,
} from 'node:http';
import { type AddressInfo, connect } from 'node:net';

/** The Mac's Tailscale name, as the engine's config.json is told it. */
export const SERVE_HOST = 'studio-mac.tail1234.ts.net';

export interface Person {
  login: string;
  name: string;
}

export const ADMIN: Person = { login: 'owner@example.com', name: 'The owner' };
export const YAEL: Person = { login: 'yael@example.com', name: 'Yael' };
export const AMIT: Person = { login: 'amit@example.com', name: 'Amit' };
/** On no list: the engine must not know them. */
export const STRANGER: Person = { login: 'stranger@example.com', name: 'Stranger' };

/** Who is asking: a person through Serve, Funnel (Serve's Host and no login), or this Mac itself. */
export type Caller = Person | 'funnel' | 'local';

/** The headers a request of this caller carries when it reaches the engine. */
export function headersOf(caller: Caller): Record<string, string> {
  if (caller === 'local') return {};
  const base = { host: SERVE_HOST, 'x-forwarded-for': '100.64.0.7', 'x-forwarded-proto': 'https' };
  if (caller === 'funnel') return base;
  return {
    ...base,
    'tailscale-user-login': caller.login,
    'tailscale-user-name': caller.name,
  };
}

export interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface RawOptions {
  method?: string;
  /** Sent byte for byte as the request line's target, `..` and `//` included. */
  path: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
}

/** One request with exactly these headers (no defaults but the ones Node needs). */
export function rawRequest(base: string, options: RawOptions): Promise<RawResponse> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: url.hostname,
        port: url.port,
        method: options.method ?? 'GET',
        path: options.path,
        headers: options.headers,
        setHost: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.setTimeout(20_000, () => req.destroy(new Error(`timeout: ${options.path}`)));
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

export interface ApiResponse<T = unknown> {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
  json: T;
}

/** The API as one caller. `json` is `undefined` when the answer is not JSON. */
export class ApiClient {
  constructor(
    readonly base: string,
    readonly caller: Caller,
    private readonly extraHeaders: Record<string, string> = {},
  ) {}

  headers(extra: Record<string, string> = {}): Record<string, string> {
    // `Host` is the one header Node would set itself; `local` sends the engine's own.
    const host: Record<string, string> =
      this.caller === 'local' ? { host: new URL(this.base).host } : {};
    return { ...host, ...headersOf(this.caller), ...this.extraHeaders, ...extra };
  }

  async send<T = unknown>(
    method: string,
    path: string,
    json?: unknown,
    extra: Record<string, string> = {},
  ): Promise<ApiResponse<T>> {
    const body = json === undefined ? undefined : JSON.stringify(json);
    const response = await rawRequest(this.base, {
      method,
      path,
      headers: {
        ...this.headers(extra),
        ...(body === undefined
          ? {}
          : {
              'content-type': 'application/json',
              'content-length': String(Buffer.byteLength(body)),
            }),
      },
      body,
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      parsed = undefined;
    }
    return {
      status: response.status,
      headers: response.headers,
      text: response.body,
      json: parsed as T,
    };
  }

  get<T = unknown>(path: string, extra?: Record<string, string>) {
    return this.send<T>('GET', path, undefined, extra);
  }
}

/** One open `/api/events` stream. */
export interface EventStream {
  status: number;
  /** Every frame received so far, raw. */
  frames: string[];
  /** The `data:` frames that are JSON, parsed. */
  events: { type: string; [key: string]: unknown }[];
  /** Resolves when the server (or `close`) ended the stream. */
  closed: Promise<void>;
  isClosed(): boolean;
  close(): void;
}

/** Opens the live stream as a caller and resolves once the response head has arrived. */
export function openStream(
  base: string,
  caller: Caller,
  options: { path?: string; headers?: Record<string, string> } = {},
): Promise<EventStream> {
  const url = new URL(base);
  const host = caller === 'local' ? { host: url.host } : {};
  return new Promise((resolve, reject) => {
    const frames: string[] = [];
    const events: EventStream['events'] = [];
    let ended = false;
    let res: IncomingMessage | undefined;
    let markClosed: () => void = () => {};
    const closed = new Promise<void>((done) => {
      markClosed = done;
    });
    const req = request(
      {
        host: url.hostname,
        port: url.port,
        method: 'GET',
        path: options.path ?? '/api/events',
        headers: { ...host, ...headersOf(caller), accept: 'text/event-stream', ...options.headers },
        setHost: false,
      },
      (response) => {
        res = response;
        let buffer = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          buffer += chunk;
          for (;;) {
            const end = buffer.indexOf('\n\n');
            if (end === -1) break;
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            frames.push(frame);
            const data = frame
              .split('\n')
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trim())
              .join('');
            if (data === '') continue;
            try {
              events.push(JSON.parse(data));
            } catch {
              // Not JSON: it stays in `frames`.
            }
          }
        });
        const finish = () => {
          ended = true;
          markClosed();
        };
        response.on('end', finish);
        response.on('close', finish);
        response.on('error', finish);
        resolve({
          status: response.statusCode ?? 0,
          frames,
          events,
          closed,
          isClosed: () => ended,
          close: () => {
            req.destroy();
            response.destroy();
            finish();
          },
        });
      },
    );
    req.on('error', (error) => {
      if (res === undefined) reject(error);
    });
    req.end();
  });
}

export interface ServeProxy {
  /** `http://127.0.0.1:<port>`: what a browser opens. */
  url: string;
  close(): Promise<void>;
}

/**
 * A proxy in front of the engine that does what Tailscale Serve does for one person: it sets the
 * Host to the Mac's name, replaces the Origin of a browser write to match (the page sits behind
 * Serve's https name), drops any Tailscale header the browser sent and adds this person's. `null`
 * makes it Funnel: the Host, and no login at all.
 */
export async function startServeProxy(target: URL, person: Person | null): Promise<ServeProxy> {
  const sockets = new Set<import('node:net').Socket>();
  const server: Server = createServer((incoming, outgoing) => {
    const headers: Record<string, string | string[] | undefined> = { ...incoming.headers };
    for (const name of Object.keys(headers)) {
      if (name.startsWith('tailscale-') || name.startsWith('x-forwarded-')) delete headers[name];
    }
    headers.host = SERVE_HOST;
    if (headers.origin !== undefined) headers.origin = `http://${SERVE_HOST}`;
    if (headers.referer !== undefined) headers.referer = `http://${SERVE_HOST}/`;
    headers['x-forwarded-for'] = '100.64.0.7';
    headers['x-forwarded-proto'] = 'http';
    if (person !== null) {
      headers['tailscale-user-login'] = person.login;
      headers['tailscale-user-name'] = person.name;
    }
    const upstream = request(
      {
        host: target.hostname,
        port: target.port,
        method: incoming.method,
        path: incoming.url,
        headers,
        setHost: false,
      },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
        response.on('error', () => outgoing.destroy());
      },
    );
    upstream.on('error', () => {
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end();
    });
    outgoing.on('close', () => upstream.destroy());
    incoming.pipe(upstream);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/**
 * Bytes straight onto a socket, for requests Node's own client would not make (an absolute-form
 * request line, two Host headers). Resolves to what came back until the server closed or 1.5 s
 * of quiet.
 */
export function rawSocket(
  base: string,
  text: string,
): Promise<{ status: number; head: string; body: string }> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(url.port), url.hostname);
    let data = '';
    let timer: NodeJS.Timeout | undefined;
    const done = () => {
      clearTimeout(timer);
      socket.destroy();
      const [head = '', ...rest] = data.split('\r\n\r\n');
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1] ?? 0);
      resolve({ status, head, body: rest.join('\r\n\r\n') });
    };
    socket.on('connect', () => socket.write(text));
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8');
      clearTimeout(timer);
      timer = setTimeout(done, 400);
    });
    socket.on('error', reject);
    socket.on('close', done);
    timer = setTimeout(done, 1_500);
  });
}
