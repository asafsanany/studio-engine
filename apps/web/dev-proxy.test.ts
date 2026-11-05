import { EventEmitter } from 'node:events';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureApiProxy, createApiProxy } from './dev-proxy.ts';

// These tests run the real Vite proxy (middleware mode, no files, no sockets but the two below)
// in front of a throwaway upstream, because what is being fixed is how http-proxy behaves when the
// upstream goes away: a fake would only repeat what we believe it does.

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

function stop(server: http.Server): () => Promise<void> {
  return () =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
}

/** An upstream whose `handler` answers every request. `kill()` is the engine dying. */
async function startUpstream(handler: http.RequestListener) {
  const server = http.createServer(handler);
  const port = await listen(server);
  closers.push(stop(server));
  return { port, kill: stop(server) };
}

/** A server of the app's own proxy table (`createApiProxy`) pointing at `target`. */
async function startDevServer(target: string): Promise<number> {
  const vite: ViteDevServer = await createViteServer({
    configFile: false,
    logLevel: 'silent',
    appType: 'custom',
    optimizeDeps: { noDiscovery: true },
    server: { middlewareMode: true, ws: false, watch: null, proxy: createApiProxy(target) },
  });
  const front = http.createServer(vite.middlewares);
  const port = await listen(front);
  closers.push(async () => {
    await stop(front)();
    await vite.close();
  });
  return port;
}

/** A GET through the dev server. Resolves with the response once its head has arrived. */
function get(port: number, path: string): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, resolve).on('error', reject);
  });
}

/** Resolves when the client side of `res` is over, however: ended, aborted or closed. */
function whenOver(res: http.IncomingMessage): Promise<{ complete: boolean }> {
  return new Promise((resolve) => {
    res.on('error', () => {}); // an aborted response reports ECONNRESET; the test reads `complete`
    res.on('close', () => resolve({ complete: res.complete }));
    res.resume();
  });
}

function sseUpstream(): http.RequestListener {
  return (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write('data: {"type":"hello"}\n\n');
    const ping = setInterval(() => res.write(': ping\n\n'), 50);
    res.on('close', () => clearInterval(ping));
  };
}

describe('the /api dev proxy and an engine that goes away', () => {
  it('ends the stream the browser holds when the engine dies, so EventSource sees the error', async () => {
    const engine = await startUpstream(sseUpstream());
    const port = await startDevServer(`http://127.0.0.1:${engine.port}`);
    const stream = await get(port, '/api/events');
    const over = whenOver(stream);

    await engine.kill();

    // Without the hook this never settles (the browser would hold the connection for ever).
    await expect(over).resolves.toEqual({ complete: false });
  });

  it('answers 502 and ends when the engine is down as the browser asks (the reconnect attempts)', async () => {
    const engine = await startUpstream(sseUpstream());
    const target = `http://127.0.0.1:${engine.port}`;
    await engine.kill();
    const port = await startDevServer(target);

    const response = await get(port, '/api/events');
    const over = whenOver(response);

    expect(response.statusCode).toBe(502);
    await expect(over).resolves.toEqual({ complete: true });
  });

  it('a stream opens again after the engine is back (nothing is left stuck on the way)', async () => {
    const first = await startUpstream(sseUpstream());
    const upstreamPort = first.port;
    const port = await startDevServer(`http://127.0.0.1:${upstreamPort}`);
    const stream = await get(port, '/api/events');
    const over = whenOver(stream);
    await first.kill();
    await over;

    // The engine restarts on the same port.
    const again = http.createServer(sseUpstream());
    await new Promise<void>((resolve) => again.listen(upstreamPort, '127.0.0.1', resolve));
    closers.push(stop(again));

    const reopened = await get(port, '/api/events');
    expect(reopened.statusCode).toBe(200);
    expect(reopened.headers['content-type']).toContain('text/event-stream');
    reopened.destroy();
  });

  it('also ends a plain response that the engine cut off half way', async () => {
    const engine = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' });
      res.write('[{"id":');
      setTimeout(() => res.destroy(), 50);
    });
    const port = await startDevServer(`http://127.0.0.1:${engine.port}`);

    const response = await get(port, '/api/jobs');

    await expect(whenOver(response)).resolves.toEqual({ complete: false });
  });

  it('leaves a response that ended properly alone', async () => {
    const engine = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('[1,2,3]');
    });
    const port = await startDevServer(`http://127.0.0.1:${engine.port}`);

    const response = await get(port, '/api/jobs');
    let body = '';
    response.setEncoding('utf8');
    response.on('data', (chunk: string) => {
      body += chunk;
    });

    await expect(whenOver(response)).resolves.toEqual({ complete: true });
    expect(body).toBe('[1,2,3]');
  });
});

describe('the /api dev proxy and server-sent events', () => {
  it('opens the stream at once, marked as not to be cached or transformed', async () => {
    // The upstream sends its head and then nothing: the browser must still see the stream open.
    const engine = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.flushHeaders();
    });
    const port = await startDevServer(`http://127.0.0.1:${engine.port}`);

    const stream = await get(port, '/api/events');

    expect(stream.statusCode).toBe(200);
    expect(stream.headers['cache-control']).toBe('no-cache, no-transform');
    expect(stream.headers['x-accel-buffering']).toBe('no');
    stream.destroy();
  });

  it('does not mark other responses', async () => {
    const engine = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'max-age=5' });
      res.end('[]');
    });
    const port = await startDevServer(`http://127.0.0.1:${engine.port}`);

    const response = await get(port, '/api/jobs');
    response.resume();

    expect(response.headers['cache-control']).toBe('max-age=5');
    expect(response.headers['x-accel-buffering']).toBeUndefined();
  });
});

describe('createApiProxy', () => {
  it('proxies /api to the given target through the hook', () => {
    const table = createApiProxy('http://127.0.0.1:4999');
    expect(Object.keys(table)).toEqual(['/api']);
    expect(table['/api']).toMatchObject({
      target: 'http://127.0.0.1:4999',
      configure: configureApiProxy,
    });
  });
});

describe('the proxy "error" event', () => {
  /** A stand-in for the proxy server: all the hook uses is `on`. */
  function hooked() {
    const proxy = new EventEmitter();
    configureApiProxy(proxy as unknown as Parameters<typeof configureApiProxy>[0]);
    return proxy;
  }

  it('destroys a response whose head is already out (a stream cut by a reset)', () => {
    const proxy = hooked();
    const res = { headersSent: true, writableEnded: false, destroy: vi.fn() };
    proxy.emit('error', new Error('read ECONNRESET'), {}, res);
    expect(res.destroy).toHaveBeenCalledTimes(1);
  });

  it('leaves a response whose head is not out to Vite, which answers 502', () => {
    const proxy = hooked();
    const res = { headersSent: false, writableEnded: false, destroy: vi.fn() };
    proxy.emit('error', new Error('connect ECONNREFUSED'), {}, res);
    expect(res.destroy).not.toHaveBeenCalled();
  });

  it('leaves a response that has been ended, and a WebSocket socket, alone', () => {
    const proxy = hooked();
    const ended = { headersSent: true, writableEnded: true, destroy: vi.fn() };
    const socket = { destroy: vi.fn() } as unknown as Socket;
    proxy.emit('error', new Error('x'), {}, ended);
    proxy.emit('error', new Error('x'), {}, socket);
    expect(ended.destroy).not.toHaveBeenCalled();
    expect(socket.destroy).not.toHaveBeenCalled();
  });
});
