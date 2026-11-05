import { request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import type { ServerEvent } from '@studio/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { createEventBus } from '../events/bus.js';
import { FakeTimers, makeJob, SseReader } from '../events/test-utils.js';
import { type EventsRouteOptions, PING_FRAME } from './events.js';

// The route on `app.request` (a real Response whose body is read frame by frame), with fake timers
// where time matters; then once over a real socket, where headers and disconnects are the real thing.

const readers: SseReader[] = [];
const upsert = (id: string, subProgress: string | null = null): ServerEvent => ({
  type: 'job.upsert',
  job: makeJob({ id, subProgress }),
});

afterEach(async () => {
  for (const reader of readers.splice(0)) await reader.cancel().catch(() => {});
});

function harness(options: Partial<EventsRouteOptions> = {}) {
  const bus = createEventBus();
  const app = createApp({ events: { bus, ...options } });
  async function connect(): Promise<{ response: Response; reader: SseReader }> {
    const response = await app.request('/api/events');
    const reader = new SseReader(response);
    readers.push(reader);
    return { response, reader };
  }
  return { bus, app, connect };
}

/** Waits until `check` stops throwing: the abort of a stream reaches the bus a moment later. */
async function eventually(check: () => void, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      check();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

describe('GET /api/events', () => {
  it('answers a text/event-stream that nothing may buffer or transform', async () => {
    const { connect } = harness();
    const { response } = await connect();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/event-stream/);
    expect(response.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
  });

  it('sends hello first, as a data line', async () => {
    const { connect } = harness();
    const { reader } = await connect();

    expect(await reader.frame()).toBe('data: {"type":"hello"}');
  });

  it('sends each bus event as one data line of JSON', async () => {
    const { connect, bus } = harness();
    const { reader } = await connect();
    expect(await reader.event()).toEqual({ type: 'hello' });

    bus.publish(upsert('a', '1/5'));
    bus.publish({ type: 'job.remove', id: 'b' });

    const frame = await reader.frame();
    expect(frame).toBe(`data: ${JSON.stringify(upsert('a', '1/5'))}`);
    expect(frame?.split('\n')).toHaveLength(1);
    expect(await reader.event()).toEqual({ type: 'job.remove', id: 'b' });
  });

  it('sends the same events to two clients', async () => {
    const { connect, bus } = harness();
    const first = await connect();
    const second = await connect();
    expect(bus.listenerCount()).toBe(2);

    bus.publish(upsert('a', '1/5'));
    bus.publish({ type: 'job.remove', id: 'b' });

    for (const { reader } of [first, second]) {
      expect(await reader.events()).toEqual([
        { type: 'hello' },
        upsert('a', '1/5'),
        { type: 'job.remove', id: 'b' },
      ]);
    }
  });

  it('does not replay what happened before a client connected', async () => {
    const { connect, bus } = harness();
    bus.publish(upsert('a'));

    const { reader } = await connect();

    expect(await reader.events()).toEqual([{ type: 'hello' }]);
  });

  it('frees the bus listener when the client disconnects', async () => {
    const { connect, bus } = harness();
    const first = await connect();
    const second = await connect();
    await first.reader.event();
    await second.reader.event();
    expect(bus.listenerCount()).toBe(2);

    await first.reader.cancel();
    await eventually(() => expect(bus.listenerCount()).toBe(1));

    // The one that stayed still hears everything.
    bus.publish(upsert('a'));
    expect(await second.reader.event()).toEqual(upsert('a'));

    await second.reader.cancel();
    await eventually(() => expect(bus.listenerCount()).toBe(0));
  });

  it('frees the heartbeat and the held upserts of a client that disconnects', async () => {
    const timers = new FakeTimers();
    const { connect, bus } = harness({ timers, now: timers.clock });
    const { reader } = await connect();
    await reader.event();
    bus.publish(upsert('a', '1/5'));
    bus.publish(upsert('a', '2/5')); // held, with a timer
    expect(timers.pending).toBe(2);

    await reader.cancel();

    await eventually(() => expect(timers.pending).toBe(0));
    expect(bus.listenerCount()).toBe(0);
  });

  it('pings with a named event every 15 s, which a browser shows to the page', async () => {
    const timers = new FakeTimers();
    const { connect } = harness({ timers, now: timers.clock });
    const { reader } = await connect();
    expect(await reader.event()).toEqual({ type: 'hello' });

    timers.advance(14_999);
    expect(await reader.quiet(30)).toBe(true);
    timers.advance(1);
    expect(await reader.frame()).toBe('event: ping\ndata:');
    timers.advance(15_000);
    expect(await reader.frame()).toBe('event: ping\ndata:');
  });

  it('thins a burst of upserts of one job to one per 250 ms', async () => {
    const timers = new FakeTimers();
    const { connect, bus } = harness({ timers, now: timers.clock });
    const { reader } = await connect();
    expect(await reader.event()).toEqual({ type: 'hello' });

    for (let i = 1; i <= 5; i += 1) bus.publish(upsert('a', `${i}/5`));
    expect(await reader.event()).toEqual(upsert('a', '1/5'));
    expect(await reader.quiet(30)).toBe(true);

    timers.advance(250);
    expect(await reader.event()).toEqual(upsert('a', '5/5'));
    expect(await reader.quiet(30)).toBe(true);
  });

  it('keeps coalescing out of the bus: every upsert still reaches other listeners', async () => {
    const { connect, bus } = harness();
    const seen: ServerEvent[] = [];
    bus.subscribe((event) => seen.push(event));
    await connect();

    for (let i = 1; i <= 5; i += 1) bus.publish(upsert('a', `${i}/5`));

    expect(seen).toHaveLength(5);
  });

  it('ends every stream when the signal aborts, and frees the listeners', async () => {
    const controller = new AbortController();
    const { connect, bus } = harness({ signal: controller.signal });
    const first = await connect();
    const second = await connect();
    await first.reader.event();
    await second.reader.event();

    controller.abort();

    for (const { reader } of [first, second]) {
      expect(await reader.frame()).toBeNull();
      expect(reader.ended).toBe(true);
    }
    expect(bus.listenerCount()).toBe(0);
  });

  it('answers an empty stream, and subscribes to nothing, when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { connect, bus } = harness({ signal: controller.signal });

    const { reader } = await connect();

    expect(await reader.frame()).toBeNull();
    expect(reader.ended).toBe(true);
    expect(bus.listenerCount()).toBe(0);
  });

  it('cuts off a client that does not read, instead of queueing for it for ever', async () => {
    const { connect, bus } = harness({ maxBacklog: 3 });
    const response = await (await connect()).response;
    expect(response.status).toBe(200);
    // Never read: the connection takes nothing, so frames pile up behind it.
    for (let i = 0; i < 10; i += 1) bus.publish(upsert(`job-${i}`));

    await eventually(() => expect(bus.listenerCount()).toBe(0));
  });

  it('is a plain 404 JSON where no bus was given', async () => {
    const response = await createApp({}).request('/api/events');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
  });
});

// --- over a real socket -------------------------------------------------------------------------

describe('GET /api/events over HTTP', () => {
  const closers: (() => void)[] = [];
  afterEach(() => {
    for (const close of closers.splice(0)) close();
  });

  async function listen(options: Partial<EventsRouteOptions> = {}) {
    const bus = createEventBus();
    const app = createApp({ events: { bus, ...options } });
    // serve() returns a union incl. HTTP/2; this is the plain HTTP/1 server (as in index.ts).
    const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }) as Server;
    await new Promise<void>((resolve) => server.once('listening', resolve));
    closers.push(() => {
      server.closeAllConnections();
      server.close();
    });
    const { port } = server.address() as AddressInfo;

    function get(): Promise<{ res: IncomingMessage; chunks: string[]; destroy(): void }> {
      return new Promise((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port, path: '/api/events' }, (res) => {
          const chunks: string[] = [];
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => chunks.push(chunk));
          res.on('error', () => {});
          resolve({ res, chunks, destroy: () => req.destroy() });
        });
        req.on('error', reject);
        req.end();
        closers.push(() => req.destroy());
      });
    }
    return { bus, get };
  }

  it('streams: hello arrives with the headers, events arrive one by one as they happen', async () => {
    const { bus, get } = await listen();
    const { res, chunks } = await get();

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/event-stream/);
    expect(res.headers['cache-control']).toBe('no-cache, no-transform');
    expect(res.headers['x-accel-buffering']).toBe('no');
    expect(res.headers['transfer-encoding']).toBe('chunked');
    await eventually(() => expect(chunks.join('')).toBe('data: {"type":"hello"}\n\n'));

    bus.publish(upsert('a', '1/5'));
    await eventually(() => expect(chunks).toHaveLength(2));
    expect(chunks[1]).toBe(`data: ${JSON.stringify(upsert('a', '1/5'))}\n\n`);

    // Not held back until the stream ends: a second event is a second chunk, now.
    bus.publish({ type: 'job.remove', id: 'a' });
    await eventually(() => expect(chunks).toHaveLength(3));
    expect(chunks[2]).toBe('data: {"type":"job.remove","id":"a"}\n\n');
  });

  it('pings on its own', async () => {
    const { get } = await listen({ heartbeatMs: 25 });
    const { chunks } = await get();

    await eventually(() => expect(chunks.filter((chunk) => chunk === PING_FRAME).length).toBe(2));
  });

  it('frees the listener when the client goes away', async () => {
    const { bus, get } = await listen();
    const first = await get();
    const second = await get();
    await eventually(() => expect(bus.listenerCount()).toBe(2));

    first.destroy();
    await eventually(() => expect(bus.listenerCount()).toBe(1));
    second.destroy();
    await eventually(() => expect(bus.listenerCount()).toBe(0));
  });
});
