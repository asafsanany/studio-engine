import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeServer } from './shutdown.js';

// CVP-89: a restart with a browser open waited out the whole 5 s grace period. These tests use a
// real HTTP server and real keep-alive connections, because the bug lived in how Node's server
// treats them: its keep-alive timeout is set far above any time these tests take, so only
// `closeServer` can end a connection quickly.

const servers: Server[] = [];
const agents: http.Agent[] = [];

afterEach(() => {
  for (const agent of agents.splice(0)) agent.destroy();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    if (server.listening) server.close();
  }
});

interface Fixture {
  server: Server;
  port: number;
  agent: http.Agent;
  /** The responses of /stream that are still open, oldest first. */
  streams: ServerResponse[];
}

async function listen(): Promise<Fixture> {
  const streams: ServerResponse[] = [];
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: hello\n\n');
      streams.push(res);
      return;
    }
    res.end('ok');
  });
  server.keepAliveTimeout = 60_000;
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const agent = new http.Agent({ keepAlive: true, maxSockets: 4 });
  agents.push(agent);
  return { server, port: (server.address() as AddressInfo).port, agent, streams };
}

/** A finished request: the connection stays open, idle, like a browser's after a fetch. */
function fetchOnce({ port, agent }: Fixture, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path, agent }, (res) => {
        res.resume();
        res.on('end', resolve);
      })
      .on('error', reject);
  });
}

/** Opens /stream and resolves once its first frame has arrived; `ended` settles when it ends. */
function openStream({
  port,
  agent,
}: Fixture): Promise<{ ended: Promise<void>; closed: Promise<void> }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/stream', agent }, (res) => {
      const ended = new Promise<void>((done) => res.on('end', done));
      const closed = new Promise<void>((done) => res.on('close', done));
      res.on('error', () => {});
      res.once('data', () => resolve({ ended, closed }));
    });
    req.on('error', reject);
  });
}

describe('closeServer', () => {
  it('closes at once when the only things open are a browser event stream that is ending and an idle keep-alive connection', async () => {
    const fixture = await listen();
    await fetchOnce(fixture, '/jobs');
    const stream = await openStream(fixture);
    const onGraceOver = vi.fn();

    const startedAt = Date.now();
    const closing = closeServer(fixture.server, { graceMs: 5_000, onGraceOver });
    // The engine ends the event streams when it stops; the connection is idle only after that.
    setTimeout(() => {
      for (const res of fixture.streams) res.end();
    }, 50);
    await closing;
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(1_000);
    expect(onGraceOver).not.toHaveBeenCalled();
    await stream.ended;
    expect(fixture.server.listening).toBe(false);
  });

  it('closes an idle server straight away', async () => {
    const fixture = await listen();
    await fetchOnce(fixture, '/jobs');

    const startedAt = Date.now();
    await closeServer(fixture.server, { graceMs: 5_000 });

    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it('leaves a connection that is still busy alone until the grace period is over, then cuts it', async () => {
    const fixture = await listen();
    const stream = await openStream(fixture);
    const onGraceOver = vi.fn();

    const startedAt = Date.now();
    await closeServer(fixture.server, { graceMs: 300, onGraceOver, sweepMs: 10 });
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeGreaterThanOrEqual(290);
    expect(onGraceOver).toHaveBeenCalledTimes(1);
    await stream.closed;
  });

  it('rejects with the error of server.close() when the server is not running', async () => {
    const server = http.createServer();
    servers.push(server);

    await expect(closeServer(server, { graceMs: 5_000 })).rejects.toThrow(/not running/i);
  });
});
