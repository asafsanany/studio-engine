import type { GraphicMessage, GraphicSummary, LutSummary, ServerEvent } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { makeSeries } from '../clients/test-utils.js';
import { makeFontFamilySummary } from '../fonts/test-utils.js';
import { createEventBus } from './bus.js';
import {
  type ClientStream,
  COALESCE_MS,
  HEARTBEAT_MS,
  openClientStream,
  type StreamTimers,
} from './client-stream.js';
import { FakeTimers, makeJob } from './test-utils.js';

// One client's stream on its own: a real bus, fake timers and clock, and `send` / `ping` that
// record what would have been written.

interface Harness {
  bus: ReturnType<typeof createEventBus>;
  timers: FakeTimers;
  /** What was sent, with the fake time of each frame (`ping` shows as 'ping'). */
  sent: { at: number; frame: ServerEvent | 'ping' }[];
  stream: ClientStream;
  /** The events sent so far, pings left out. */
  events(): ServerEvent[];
}

function open(options: { coalesceMs?: number; heartbeatMs?: number } = {}): Harness {
  const bus = createEventBus();
  const timers = new FakeTimers();
  const sent: Harness['sent'] = [];
  const stream = openClientStream({
    bus,
    send: (event) => sent.push({ at: timers.now, frame: event }),
    ping: () => sent.push({ at: timers.now, frame: 'ping' }),
    timers,
    now: timers.clock,
    ...options,
  });
  return {
    bus,
    timers,
    sent,
    stream,
    events: () => sent.flatMap((entry) => (entry.frame === 'ping' ? [] : [entry.frame])),
  };
}

const upsert = (id: string, subProgress: string | null = null, etaSec: number | null = null) =>
  ({
    type: 'job.upsert',
    job: makeJob({ id, subProgress, etaSec }),
  }) satisfies ServerEvent;

const subOf = (event: ServerEvent | undefined) =>
  event?.type === 'job.upsert' ? event.job.subProgress : undefined;

describe('hello', () => {
  it('is the first thing sent, once, before any event', () => {
    const { sent, bus } = open();
    expect(sent).toEqual([{ at: expect.any(Number), frame: { type: 'hello' } }]);

    bus.publish(upsert('a'));

    expect(sent.map((entry) => entry.frame)).toEqual([{ type: 'hello' }, upsert('a')]);
  });

  it('is not forwarded from the bus: it belongs to a connection', () => {
    const { sent, bus } = open();
    bus.publish({ type: 'hello' });
    expect(sent).toHaveLength(1);
  });
});

describe('forwarding', () => {
  it('sends the first upsert of a job at once, whole', () => {
    const { events, bus } = open();
    bus.publish(upsert('a', '1/5'));
    expect(events()).toEqual([{ type: 'hello' }, upsert('a', '1/5')]);
  });

  it('sends job.remove at once', () => {
    const { events, bus } = open();
    bus.publish({ type: 'job.remove', id: 'a' });
    expect(events()).toEqual([{ type: 'hello' }, { type: 'job.remove', id: 'a' }]);
  });

  it('keeps the order of events about different jobs', () => {
    const { events, bus } = open();
    bus.publish(upsert('a'));
    bus.publish(upsert('b'));
    bus.publish({ type: 'job.remove', id: 'a' });
    expect(events().slice(1)).toEqual([upsert('a'), upsert('b'), { type: 'job.remove', id: 'a' }]);
  });
});

describe('coalescing job.upsert', () => {
  it('holds a burst and sends only the latest when the 250 ms window ends', () => {
    const { events, bus, timers } = open();
    bus.publish(upsert('a', '1/5')); // leading edge: out now
    timers.advance(10);
    bus.publish(upsert('a', '2/5'));
    timers.advance(10);
    bus.publish(upsert('a', '3/5'));
    timers.advance(10);
    bus.publish(upsert('a', '4/5'));

    expect(events().map(subOf)).toEqual([undefined, '1/5']);

    timers.advance(COALESCE_MS - 30 - 1);
    expect(events().map(subOf)).toEqual([undefined, '1/5']);
    timers.advance(1);
    expect(events().map(subOf)).toEqual([undefined, '1/5', '4/5']);
  });

  it('sends exactly 250 ms after the previous frame of that job', () => {
    const { sent, bus, timers } = open();
    const start = timers.now;
    bus.publish(upsert('a', '1/5'));
    timers.advance(100);
    bus.publish(upsert('a', '2/5'));
    timers.advance(1_000);

    const upserts = sent.filter((entry) => entry.frame !== 'ping' && entry.frame.type !== 'hello');
    expect(upserts.map((entry) => entry.at - start)).toEqual([0, COALESCE_MS]);
  });

  it('sends nothing more when nothing was held, and leaves no timer behind', () => {
    const { events, bus, timers } = open();
    bus.publish(upsert('a'));
    const timersWithStream = timers.pending; // the heartbeat
    timers.advance(1_000);
    expect(events()).toHaveLength(2);
    expect(timers.pending).toBe(timersWithStream);
  });

  it('sends the next upsert of a quiet job at once', () => {
    const { events, bus, timers } = open();
    bus.publish(upsert('a', '1/5'));
    timers.advance(COALESCE_MS);
    bus.publish(upsert('a', '2/5'));
    expect(events().map(subOf)).toEqual([undefined, '1/5', '2/5']);
  });

  it('sends at most one frame per window for a job that never stops reporting', () => {
    const { sent, bus, timers } = open();
    for (let i = 0; i < 100; i += 1) {
      bus.publish(upsert('a', `${i}/100`));
      timers.advance(20); // 2 s of chatter
    }
    timers.advance(COALESCE_MS);

    const frames = sent.flatMap((entry) =>
      entry.frame !== 'ping' && entry.frame.type === 'job.upsert' ? [entry] : [],
    );
    for (let i = 1; i < frames.length; i += 1) {
      expect((frames[i]?.at ?? 0) - (frames[i - 1]?.at ?? 0)).toBeGreaterThanOrEqual(COALESCE_MS);
    }
    expect(frames.length).toBeLessThanOrEqual(2_000 / COALESCE_MS + 2);
    // The last word is never lost.
    const last = frames.at(-1)?.frame;
    expect(last !== 'ping' && last?.type === 'job.upsert' && last.job.subProgress).toBe('99/100');
  });

  it('windows each job on its own', () => {
    const { events, bus, timers } = open();
    bus.publish(upsert('a', '1/5'));
    bus.publish(upsert('b', '1/5'));
    bus.publish(upsert('a', '2/5'));
    bus.publish(upsert('b', '2/5'));
    expect(events().slice(1)).toEqual([upsert('a', '1/5'), upsert('b', '1/5')]);

    timers.advance(COALESCE_MS);
    expect(events().slice(3)).toEqual([upsert('a', '2/5'), upsert('b', '2/5')]);
  });

  it('does not treat an unchanged updatedAt as a duplicate: ETA ticks get through', () => {
    const { events, bus, timers } = open();
    // Same updatedAt in all three: only etaSec moves (E5).
    bus.publish(upsert('a', null, 240));
    bus.publish(upsert('a', null, 239));
    bus.publish(upsert('a', null, 238));
    timers.advance(COALESCE_MS);
    timers.advance(1_000);
    bus.publish(upsert('a', null, 200));

    const etas = events().flatMap((event) =>
      event.type === 'job.upsert' ? [event.job.etaSec] : [],
    );
    expect(etas).toEqual([240, 238, 200]);
  });

  it('honours another window', () => {
    const { events, bus, timers } = open({ coalesceMs: 1_000 });
    bus.publish(upsert('a', '1/5'));
    bus.publish(upsert('a', '2/5'));
    timers.advance(999);
    expect(events().map(subOf)).toEqual([undefined, '1/5']);
    timers.advance(1);
    expect(events().map(subOf)).toEqual([undefined, '1/5', '2/5']);
  });
});

describe('client.upsert', () => {
  const style = (state: 'analysing' | 'ready') =>
    ({
      type: 'client.upsert',
      style: {
        clientId: '1c9823704bf5',
        client: 'Northwind Bakery',
        state,
        version: 1,
        updatedAt: '2026-10-20T14:05:00.000Z',
        error: null,
        sourceJobId: null,
      },
    }) satisfies ServerEvent;

  it('is forwarded as it is, every time, with no coalescing', () => {
    const { bus, events } = open();

    bus.publish(style('analysing'));
    bus.publish(style('ready'));

    expect(events()).toEqual([{ type: 'hello' }, style('analysing'), style('ready')]);
  });

  it('keeps its place among the job events', () => {
    const { bus, events } = open();

    bus.publish(upsert('a'));
    bus.publish(style('ready'));
    bus.publish({ type: 'job.remove', id: 'a' });

    expect(events().slice(1)).toEqual([
      upsert('a'),
      style('ready'),
      { type: 'job.remove', id: 'a' },
    ]);
  });

  it('is not sent once the stream is closed', () => {
    const { bus, events, stream } = open();
    stream.close();

    bus.publish(style('ready'));

    expect(events()).toEqual([{ type: 'hello' }]);
  });
});

describe('client.added and client.removed', () => {
  const added = {
    type: 'client.added',
    clientId: '1c9823704bf5',
    client: 'Northwind Bakery',
  } satisfies ServerEvent;
  const removed = { ...added, type: 'client.removed' } satisfies ServerEvent;

  it('are forwarded as they are, every time, in order and with no coalescing', () => {
    const { bus, events } = open();

    bus.publish(added);
    bus.publish(removed);
    bus.publish(added);

    expect(events()).toEqual([{ type: 'hello' }, added, removed, added]);
  });

  it('keep their place among the job events', () => {
    const { bus, events } = open();

    bus.publish(upsert('a'));
    bus.publish(added);
    bus.publish({ type: 'job.remove', id: 'a' });

    expect(events().slice(1)).toEqual([upsert('a'), added, { type: 'job.remove', id: 'a' }]);
  });

  it('are not sent once the stream is closed', () => {
    const { bus, events, stream } = open();
    stream.close();

    bus.publish(added);
    bus.publish(removed);

    expect(events()).toEqual([{ type: 'hello' }]);
  });
});

describe('note events (W5)', () => {
  const note = (id: string, text: string) =>
    ({
      type: 'note.upsert',
      note: {
        id,
        jobId: 'a1b2c3d4e5f6',
        round: null,
        atSec: 2.4,
        kind: 'text',
        text,
        audioFile: null,
        audioSec: null,
        transcriptStatus: null,
        addToStyle: false,
        addToSeries: false,
        createdAt: '2026-10-20T14:00:00.000Z',
        sentAt: null,
        routeStatus: null,
        route: null,
        fixId: null,
        fixedAt: null,
      },
    }) satisfies ServerEvent;
  const removed = (id: string) =>
    ({ type: 'note.remove', jobId: 'a1b2c3d4e5f6', noteId: id }) satisfies ServerEvent;

  it('forwards note.upsert and note.remove as they are, every time, with no coalescing', () => {
    const { bus, events } = open();

    bus.publish(note('n1', 'First'));
    bus.publish(note('n1', 'Second'));
    bus.publish(note('n1', 'Third'));
    bus.publish(removed('n1'));
    bus.publish(removed('n1'));

    expect(events()).toEqual([
      { type: 'hello' },
      note('n1', 'First'),
      note('n1', 'Second'),
      note('n1', 'Third'),
      removed('n1'),
      removed('n1'),
    ]);
  });

  it('keeps their place among the job events, and a remove never overtakes an upsert', () => {
    const { bus, events, timers } = open();

    bus.publish(upsert('a', '1/5'));
    bus.publish(upsert('a', '2/5')); // held for the coalescing window
    bus.publish(note('n1', 'Typed'));
    bus.publish(removed('n1'));
    timers.advance(COALESCE_MS);

    expect(events().slice(1)).toEqual([
      upsert('a', '1/5'),
      note('n1', 'Typed'),
      removed('n1'),
      upsert('a', '2/5'),
    ]);
  });

  it('sends nothing after the stream is closed', () => {
    const { bus, events, stream } = open();
    stream.close();

    bus.publish(note('n1', 'Typed'));
    bus.publish(removed('n1'));

    expect(events()).toEqual([{ type: 'hello' }]);
  });
});

describe('money.changed (Phase 4)', () => {
  const changed = { type: 'money.changed' } satisfies ServerEvent;

  it('is forwarded as it is, every time, in order with the job events', () => {
    const { bus, events, timers } = open();

    bus.publish(upsert('a', '1/5'));
    bus.publish(upsert('a', '2/5')); // held for the coalescing window
    bus.publish(changed);
    bus.publish(changed);
    timers.advance(COALESCE_MS);

    expect(events()).toEqual([
      { type: 'hello' },
      upsert('a', '1/5'),
      changed,
      changed,
      upsert('a', '2/5'),
    ]);
  });

  it('is sent to every open stream and to none that has closed', () => {
    const bus = createEventBus();
    const frames: ServerEvent[][] = [[], []];
    const streams = frames.map((list) =>
      openClientStream({ bus, send: (event) => list.push(event), ping: () => {} }),
    );

    bus.publish(changed);
    streams[0]?.close();
    bus.publish(changed);

    expect(frames[0]).toEqual([{ type: 'hello' }, changed]);
    expect(frames[1]).toEqual([{ type: 'hello' }, changed, changed]);
    streams[1]?.close();
  });
});

describe('series.changed and series.removed (Series plan §5)', () => {
  const series = makeSeries();
  const changed = { type: 'series.changed', series } satisfies ServerEvent;
  const learning = {
    type: 'series.changed',
    series: { ...series, state: 'learning', version: 2 },
  } satisfies ServerEvent;
  const removed = {
    type: 'series.removed',
    seriesId: series.id,
    clientId: series.clientId,
  } satisfies ServerEvent;

  it('are forwarded as they are, every time, with no coalescing', () => {
    const { bus, events } = open();

    bus.publish(changed);
    bus.publish(learning);
    bus.publish(learning);
    bus.publish(removed);
    bus.publish(removed);

    expect(events()).toEqual([{ type: 'hello' }, changed, learning, learning, removed, removed]);
  });

  it('keep their place among the job events', () => {
    const { bus, events, timers } = open();

    bus.publish(upsert('a', '1/5'));
    bus.publish(upsert('a', '2/5')); // held for the coalescing window
    bus.publish(changed);
    bus.publish(removed);
    timers.advance(COALESCE_MS);

    expect(events().slice(1)).toEqual([upsert('a', '1/5'), changed, removed, upsert('a', '2/5')]);
  });

  it('go to every open stream and to none that has closed', () => {
    const bus = createEventBus();
    const frames: ServerEvent[][] = [[], []];
    const streams = frames.map((list) =>
      openClientStream({ bus, send: (event) => list.push(event), ping: () => {} }),
    );

    bus.publish(changed);
    streams[0]?.close();
    bus.publish(removed);

    expect(frames[0]).toEqual([{ type: 'hello' }, changed]);
    expect(frames[1]).toEqual([{ type: 'hello' }, changed, removed]);
    streams[1]?.close();
  });

  it('close the stream when the connection cannot take them, like any other event', () => {
    const bus = createEventBus();
    const stream = openClientStream({
      bus,
      send: (event) => {
        if (event.type === 'series.changed') throw new Error('socket closed');
      },
      ping: () => {},
    });

    bus.publish(changed);

    expect(stream.closed).toBe(true);
  });
});

describe('graphic.changed and graphic.removed (Graphics plan, "Live updates")', () => {
  const graphic: GraphicSummary = {
    id: '3f9a1c2b7d4e',
    name: 'Name on a white pill',
    kind: 'lower-third',
    lengthSec: 3,
    version: 1,
    uses: true,
    status: 'making',
    makingVersion: 2,
    failedVersion: null,
    updatedAt: '2026-10-22T10:00:00.000Z',
  };
  const message: GraphicMessage = {
    id: 'm2',
    role: 'claude',
    text: '',
    refs: [],
    effort: null,
    version: 2,
    status: 'making',
    step: 0,
    error: null,
    startedAt: '2026-10-22T10:00:00.000Z',
    endedAt: null,
    createdAt: '2026-10-22T10:00:00.000Z',
  };
  const step0 = { type: 'graphic.changed', graphic, message } satisfies ServerEvent;
  const step1 = {
    type: 'graphic.changed',
    graphic,
    message: { ...message, step: 1 },
  } satisfies ServerEvent;
  const renamed = { type: 'graphic.changed', graphic } satisfies ServerEvent;
  const removed = { type: 'graphic.removed', id: graphic.id } satisfies ServerEvent;

  it('are forwarded as they are, every time and in order, with no coalescing', () => {
    const { bus, events } = open();

    bus.publish(step0);
    bus.publish(step1);
    bus.publish(step1);
    bus.publish(renamed);
    bus.publish(removed);

    expect(events()).toEqual([{ type: 'hello' }, step0, step1, step1, renamed, removed]);
  });

  it('keep their place among the job events', () => {
    const { bus, events, timers } = open();

    bus.publish(upsert('a', '1/5'));
    bus.publish(upsert('a', '2/5')); // held for the coalescing window
    bus.publish(step0);
    bus.publish(removed);
    timers.advance(COALESCE_MS);

    expect(events().slice(1)).toEqual([upsert('a', '1/5'), step0, removed, upsert('a', '2/5')]);
  });

  it('close the stream when the connection cannot take them, like any other event', () => {
    const bus = createEventBus();
    const stream = openClientStream({
      bus,
      send: (event) => {
        if (event.type === 'graphic.removed') throw new Error('socket closed');
      },
      ping: () => {},
    });

    bus.publish(removed);

    expect(stream.closed).toBe(true);
  });
});

describe('lut.changed and lut.removed (LUTs plan, "Events")', () => {
  const lut: LutSummary = {
    slug: 'golden-hour-warm',
    name: 'Golden Hour Warm',
    kind: 'look',
    size: 33,
    owner: 'yours',
    used: 0,
    usedLabel: 'Not used yet',
    addedAt: '2026-10-24T10:00:00.000Z',
    isNew: true,
  };
  const changed = { type: 'lut.changed', lut } satisfies ServerEvent;
  const renamed = {
    type: 'lut.changed',
    lut: { ...lut, slug: 'sunset-amber', name: 'Sunset Amber' },
  } satisfies ServerEvent;
  const removed = { type: 'lut.removed', slug: 'sunset-amber' } satisfies ServerEvent;

  it('are forwarded as they are, every time and in order, with no coalescing', () => {
    const { bus, events } = open();

    bus.publish(changed);
    bus.publish(changed);
    bus.publish(renamed);
    bus.publish(removed);

    expect(events()).toEqual([{ type: 'hello' }, changed, changed, renamed, removed]);
  });

  it('keep their place among the job events', () => {
    const { bus, events, timers } = open();

    bus.publish(upsert('a', '1/5'));
    bus.publish(upsert('a', '2/5')); // held for the coalescing window
    bus.publish(changed);
    bus.publish(removed);
    timers.advance(COALESCE_MS);

    expect(events().slice(1)).toEqual([upsert('a', '1/5'), changed, removed, upsert('a', '2/5')]);
  });

  it('close the stream when the connection cannot take them, like any other event', () => {
    const bus = createEventBus();
    const stream = openClientStream({
      bus,
      send: (event) => {
        if (event.type === 'lut.removed') throw new Error('socket closed');
      },
      ping: () => {},
    });

    bus.publish(removed);

    expect(stream.closed).toBe(true);
  });
});

describe('font.changed and font.removed (Fonts plan, "API")', () => {
  const family = makeFontFamilySummary({ slug: 'karantina', name: 'Karantina', isNew: true });
  const changed = { type: 'font.changed', family } satisfies ServerEvent;
  const again = {
    type: 'font.changed',
    family: { ...family, weights: [300, 400, 700], weightsLabel: '3 weights' },
  } satisfies ServerEvent;
  const removed = { type: 'font.removed', slug: 'karantina' } satisfies ServerEvent;

  it('are forwarded as they are, every time and in order, with no coalescing', () => {
    const { bus, events } = open();

    bus.publish(changed);
    bus.publish(changed);
    bus.publish(again);
    bus.publish(removed);

    expect(events()).toEqual([{ type: 'hello' }, changed, changed, again, removed]);
  });

  it('keep their place among the job events', () => {
    const { bus, events, timers } = open();

    bus.publish(upsert('a', '1/5'));
    bus.publish(upsert('a', '2/5')); // held for the coalescing window
    bus.publish(changed);
    bus.publish(removed);
    timers.advance(COALESCE_MS);

    expect(events().slice(1)).toEqual([upsert('a', '1/5'), changed, removed, upsert('a', '2/5')]);
  });

  it('close the stream when the connection cannot take them, like any other event', () => {
    const bus = createEventBus();
    const stream = openClientStream({
      bus,
      send: (event) => {
        if (event.type === 'font.removed') throw new Error('socket closed');
      },
      ping: () => {},
    });

    bus.publish(removed);

    expect(stream.closed).toBe(true);
  });
});

describe('font.requested (Fonts plan, FN16)', () => {
  const requested = { type: 'font.requested', name: 'Gotham Bold' } satisfies ServerEvent;

  it('is forwarded as it is, every time and in order, with no coalescing', () => {
    const { bus, events } = open();

    bus.publish(requested);
    bus.publish({ type: 'font.requested', name: 'Avenir' });
    bus.publish(requested);

    expect(events()).toEqual([
      { type: 'hello' },
      requested,
      { type: 'font.requested', name: 'Avenir' },
      requested,
    ]);
  });

  it('keeps its place among the job events', () => {
    const { bus, events, timers } = open();

    bus.publish(upsert('a', '1/5'));
    bus.publish(upsert('a', '2/5')); // held for the coalescing window
    bus.publish(requested);
    timers.advance(COALESCE_MS);

    expect(events().slice(1)).toEqual([upsert('a', '1/5'), requested, upsert('a', '2/5')]);
  });
});

describe('font.request.dismissed (Fonts, C52)', () => {
  const dismissed = { type: 'font.request.dismissed', id: 'a3c19e0b7d44' } satisfies ServerEvent;

  it('is forwarded as it is, in order, with no coalescing', () => {
    const { bus, events, timers } = open();

    bus.publish(upsert('a', '1/5'));
    bus.publish(upsert('a', '2/5')); // held for the coalescing window
    bus.publish(dismissed);
    timers.advance(COALESCE_MS);

    expect(events().slice(1)).toEqual([upsert('a', '1/5'), dismissed, upsert('a', '2/5')]);
  });
});

describe('job.music (Soundtrack)', () => {
  const view = { canMake: false, whyNot: 'Music v3 is still being made.', rev: 1 };
  const music = (jobId: string, picked: 'v1' | 'v2' | null, making: boolean) =>
    ({
      type: 'job.music',
      jobId,
      music: {
        v: 1,
        source: 'made',
        reason: null,
        file: null,
        plan: null,
        picked,
        versions: [],
        picks: [],
        making: making ? { id: 'v3', ask: null, startedAt: '2026-10-23T10:00:00.000Z' } : null,
        failure: null,
        song: null,
        songFailure: null,
        ...view,
      },
    }) satisfies ServerEvent;

  it('is forwarded as it is, every time and in order, with no coalescing', () => {
    const { bus, events } = open();
    const making = music('a', 'v1', true);
    const made = music('a', 'v2', false);
    const none = { type: 'job.music', jobId: 'b', music: null } satisfies ServerEvent;

    bus.publish(making);
    bus.publish(made);
    bus.publish(made);
    bus.publish(none);

    expect(events()).toEqual([{ type: 'hello' }, making, made, made, none]);
  });

  it('keeps its place among the job events', () => {
    const { bus, events, timers } = open();
    const made = music('a', 'v2', false);

    bus.publish(upsert('a', '1/5'));
    bus.publish(upsert('a', '2/5')); // held for the coalescing window
    bus.publish(made);
    timers.advance(COALESCE_MS);

    expect(events().slice(1)).toEqual([upsert('a', '1/5'), made, upsert('a', '2/5')]);
  });

  it('closes the stream when the connection cannot take it, like any other event', () => {
    const bus = createEventBus();
    const stream = openClientStream({
      bus,
      send: (event) => {
        if (event.type === 'job.music') throw new Error('socket closed');
      },
      ping: () => {},
    });

    bus.publish(music('a', 'v1', false));

    expect(stream.closed).toBe(true);
  });
});

describe('job.generate (Generated videos)', () => {
  const generateEvent = (jobId: string, done: number, spendUsd: number) =>
    ({
      type: 'job.generate',
      jobId,
      generate: {
        phase: 'clips',
        counts: {
          voice: { done: 7, total: 7 },
          looks: { done: 3, total: 3 },
          keyframes: { done: 7, total: 7 },
          clips: { done, total: 6 },
          belowBar: 0,
        },
        spendUsd,
        budgetUsd: 3,
      },
    }) satisfies ServerEvent;

  it('is forwarded as it is, every time and in order, with no coalescing', () => {
    const { bus, events } = open();
    const sequence = [
      generateEvent('a', 1, 0.4),
      generateEvent('a', 2, 0.8),
      generateEvent('a', 2, 0.8),
      generateEvent('b', 5, 2.1),
    ];

    for (const event of sequence) bus.publish(event);

    expect(events()).toEqual([{ type: 'hello' }, ...sequence]);
  });

  it('keeps its place among the job events', () => {
    const { bus, events, timers } = open();
    const moved = generateEvent('a', 3, 1.2);

    bus.publish(upsert('a', '1/5'));
    bus.publish(upsert('a', '2/5')); // held for the coalescing window
    bus.publish(moved);
    timers.advance(COALESCE_MS);

    expect(events().slice(1)).toEqual([upsert('a', '1/5'), moved, upsert('a', '2/5')]);
  });

  it('closes the stream when the connection cannot take it, like any other event', () => {
    const bus = createEventBus();
    const stream = openClientStream({
      bus,
      send: (event) => {
        if (event.type === 'job.generate') throw new Error('socket closed');
      },
      ping: () => {},
    });

    bus.publish(generateEvent('a', 1, 0.4));

    expect(stream.closed).toBe(true);
  });
});

describe('job.fix (quick fixes)', () => {
  const fixEvent = (jobId: string, status: 'queued' | 'running' | 'fixed', step: number | null) =>
    ({
      type: 'job.fix',
      jobId,
      fix: {
        id: 'f1',
        jobId,
        noteId: 'n1',
        round: 1,
        status,
        step: step as never,
        stepLabel: step === null ? null : 'Changing the caption font',
        said: status === 'fixed' ? 'The captions are Heebo Bold now.' : null,
        why: null,
        model: 'sonnet',
        effort: 'medium',
        startedAt: status === 'queued' ? null : '2026-10-25T09:00:00.000Z',
        endedAt: status === 'fixed' ? '2026-10-25T09:00:48.000Z' : null,
        durationSec: status === 'fixed' ? 48 : null,
        hasCompare: status === 'fixed',
      },
    }) satisfies ServerEvent;

  it('is forwarded as it is, every time and in order, with no coalescing', () => {
    const { bus, events } = open();
    const sequence = [
      fixEvent('a', 'queued', null),
      fixEvent('a', 'running', 0),
      fixEvent('a', 'running', 1),
      fixEvent('a', 'running', 1),
      fixEvent('a', 'fixed', null),
    ];

    for (const event of sequence) bus.publish(event);

    expect(events()).toEqual([{ type: 'hello' }, ...sequence]);
  });

  it('keeps its place among the job events', () => {
    const { bus, events, timers } = open();
    const landed = fixEvent('a', 'fixed', null);

    bus.publish(upsert('a', '1/5'));
    bus.publish(upsert('a', '2/5')); // held for the coalescing window
    bus.publish(landed);
    timers.advance(COALESCE_MS);

    expect(events().slice(1)).toEqual([upsert('a', '1/5'), landed, upsert('a', '2/5')]);
  });
});

describe('client-instagram (Clients × Instagram)', () => {
  const changed = { type: 'client-instagram', clientId: '1c9823704bf5' } satisfies ServerEvent;

  it('is forwarded as it is, every time and in order, with no coalescing', () => {
    const { bus, events } = open();

    bus.publish(changed);
    bus.publish(changed);
    bus.publish({ ...changed, clientId: 'b2c3d4e5f6a1' });

    expect(events()).toEqual([
      { type: 'hello' },
      changed,
      changed,
      { type: 'client-instagram', clientId: 'b2c3d4e5f6a1' },
    ]);
  });

  it('keeps its place among the job events', () => {
    const { bus, events } = open();

    bus.publish(upsert('a'));
    bus.publish(changed);
    bus.publish({ type: 'job.remove', id: 'a' });

    expect(events().slice(1)).toEqual([upsert('a'), changed, { type: 'job.remove', id: 'a' }]);
  });

  it('closes the stream when the connection cannot take it, like any other event', () => {
    const bus = createEventBus();
    const stream = openClientStream({
      bus,
      send: (event) => {
        if (event.type === 'client-instagram') throw new Error('socket closed');
      },
      ping: () => {},
    });

    bus.publish(changed);

    expect(stream.closed).toBe(true);
  });
});

describe('job.remove', () => {
  it('is never coalesced', () => {
    const { events, bus } = open();
    bus.publish({ type: 'job.remove', id: 'a' });
    bus.publish({ type: 'job.remove', id: 'a' });
    bus.publish({ type: 'job.remove', id: 'b' });
    expect(events().slice(1)).toEqual([
      { type: 'job.remove', id: 'a' },
      { type: 'job.remove', id: 'a' },
      { type: 'job.remove', id: 'b' },
    ]);
  });

  it('goes out right after the upsert of the same job, inside its window', () => {
    const { events, bus } = open();
    bus.publish(upsert('a'));
    bus.publish({ type: 'job.remove', id: 'a' });
    expect(events().slice(1)).toEqual([upsert('a'), { type: 'job.remove', id: 'a' }]);
  });

  it('drops the upsert that was held for that job, and its timer', () => {
    const { events, bus, timers } = open();
    bus.publish(upsert('a', '1/5'));
    bus.publish(upsert('a', '2/5')); // held
    bus.publish({ type: 'job.remove', id: 'a' });
    timers.advance(1_000);

    expect(events().slice(1)).toEqual([upsert('a', '1/5'), { type: 'job.remove', id: 'a' }]);
  });

  it('leaves the held upserts of other jobs alone', () => {
    const { events, bus, timers } = open();
    bus.publish(upsert('a', '1/5'));
    bus.publish(upsert('b', '1/5'));
    bus.publish(upsert('b', '2/5')); // held
    bus.publish({ type: 'job.remove', id: 'a' });
    timers.advance(COALESCE_MS);

    expect(events().slice(1)).toEqual([
      upsert('a', '1/5'),
      upsert('b', '1/5'),
      { type: 'job.remove', id: 'a' },
      upsert('b', '2/5'),
    ]);
  });

  it('lets a job with the same id come back, and sends it at once', () => {
    const { events, bus } = open();
    bus.publish(upsert('a', '1/5'));
    bus.publish({ type: 'job.remove', id: 'a' });
    bus.publish(upsert('a', 'again'));
    expect(events().slice(1)).toEqual([
      upsert('a', '1/5'),
      { type: 'job.remove', id: 'a' },
      upsert('a', 'again'),
    ]);
  });
});

describe('heartbeat', () => {
  it('pings every 15 s and not before', () => {
    const { sent, timers } = open();
    const pings = () => sent.filter((entry) => entry.frame === 'ping').length;

    timers.advance(HEARTBEAT_MS - 1);
    expect(pings()).toBe(0);
    timers.advance(1);
    expect(pings()).toBe(1);
    timers.advance(HEARTBEAT_MS);
    expect(pings()).toBe(2);
    timers.advance(HEARTBEAT_MS * 10);
    expect(pings()).toBe(12);
  });

  it('honours another interval', () => {
    const { sent, timers } = open({ heartbeatMs: 1_000 });
    timers.advance(3_500);
    expect(sent.filter((entry) => entry.frame === 'ping')).toHaveLength(3);
  });
});

describe('close', () => {
  it('frees the bus listener and every timer', () => {
    const { bus, timers, stream } = open();
    expect(bus.listenerCount()).toBe(1);
    bus.publish(upsert('a', '1/5'));
    bus.publish(upsert('a', '2/5')); // a held upsert and its timer
    bus.publish(upsert('b', '1/5'));
    bus.publish(upsert('b', '2/5'));
    expect(timers.pending).toBe(3); // two windows and the heartbeat

    stream.close();

    expect(stream.closed).toBe(true);
    expect(bus.listenerCount()).toBe(0);
    expect(timers.pending).toBe(0);
  });

  it('sends nothing after it', () => {
    const { events, bus, timers, stream, sent } = open();
    bus.publish(upsert('a', '1/5'));
    bus.publish(upsert('a', '2/5'));
    stream.close();
    const count = sent.length;

    bus.publish(upsert('a', '3/5'));
    bus.publish({ type: 'job.remove', id: 'a' });
    timers.advance(HEARTBEAT_MS * 3);

    expect(sent).toHaveLength(count);
    expect(events().map(subOf)).toEqual([undefined, '1/5']);
  });

  it('can be called twice, and resolves whenClosed', async () => {
    const { stream } = open();
    let resolved = false;
    void stream.whenClosed.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    stream.close();
    stream.close();
    await stream.whenClosed;
    expect(resolved).toBe(true);
  });

  it('closes itself when a write throws, and frees the listener', () => {
    const bus = createEventBus();
    const timers = new FakeTimers();
    let broken = false;
    const stream = openClientStream({
      bus,
      send: () => {
        if (broken) throw new Error('socket closed');
      },
      ping: () => {},
      timers,
      now: timers.clock,
    });
    expect(bus.listenerCount()).toBe(1);

    broken = true;
    bus.publish(upsert('a'));

    expect(stream.closed).toBe(true);
    expect(bus.listenerCount()).toBe(0);
    expect(timers.pending).toBe(0);
  });

  it('never subscribes when hello cannot be written', () => {
    const bus = createEventBus();
    const timers = new FakeTimers();
    const stream = openClientStream({
      bus,
      send: () => {
        throw new Error('socket closed');
      },
      ping: () => {},
      timers,
      now: timers.clock,
    });
    expect(stream.closed).toBe(true);
    expect(bus.listenerCount()).toBe(0);
    expect(timers.pending).toBe(0);
  });

  it('does not let a stream stop another', () => {
    const bus = createEventBus();
    const timers = new FakeTimers();
    const seen: ServerEvent[][] = [[], []];
    const streams = seen.map((into) =>
      openClientStream({
        bus,
        send: (event) => into.push(event),
        ping: () => {},
        timers,
        now: timers.clock,
      }),
    );
    expect(bus.listenerCount()).toBe(2);

    streams[0]?.close();
    bus.publish(upsert('a'));

    expect(bus.listenerCount()).toBe(1);
    expect(seen[0]).toEqual([{ type: 'hello' }]);
    expect(seen[1]).toEqual([{ type: 'hello' }, upsert('a')]);
  });
});

describe('timers that fire early', () => {
  it('wait out the rest of the window instead of breaking the one-frame-per-window promise', () => {
    // A timer implementation that runs callbacks when told, whatever the clock says.
    const callbacks: { callback: () => void; ms: number }[] = [];
    const timers: StreamTimers = {
      setTimeout: (callback, ms) => {
        callbacks.push({ callback, ms });
        return callbacks.length;
      },
      clearTimeout: () => {},
    };
    let now = 0;
    const sent: ServerEvent[] = [];
    const bus = createEventBus();
    openClientStream({ bus, send: (e) => sent.push(e), ping: () => {}, timers, now: () => now });

    bus.publish(upsert('a', '1/5'));
    now = 100;
    bus.publish(upsert('a', '2/5'));
    const flush = callbacks.at(-1);
    expect(flush?.ms).toBe(150);

    now = 240; // the timer fires 10 ms early by the clock
    flush?.callback();
    expect(sent.map(subOf)).toEqual([undefined, '1/5']);
    expect(callbacks.at(-1)?.ms).toBe(10);

    now = 250;
    callbacks.at(-1)?.callback();
    expect(sent.map(subOf)).toEqual([undefined, '1/5', '2/5']);
  });
});

describe('many jobs', () => {
  it('stays correct across many jobs, quiet ones included', () => {
    const { events, bus, timers } = open();
    for (let i = 0; i < 600; i += 1) {
      bus.publish(upsert(`job-${i}`, 'x'));
      timers.advance(COALESCE_MS);
    }
    // Still correct afterwards: a quiet job's next upsert goes out at once.
    bus.publish(upsert('job-0', 'again'));
    expect(subOf(events().at(-1))).toBe('again');
    expect(events()).toHaveLength(602);
  });
});

describe('an editor’s stream (Team plan, TM2)', () => {
  const MINE = 'client-mine';
  const THEIRS = 'client-theirs';
  const mine = (id: string, extra: Partial<Parameters<typeof makeJob>[0]> = {}) =>
    makeJob({ id, clientId: MINE, ...extra });
  const theirs = (id: string) => makeJob({ id, clientId: THEIRS });

  function openScoped(
    visible: Set<string> = new Set([MINE]),
    existing = [mine('m1'), theirs('t1')],
  ) {
    const bus = createEventBus();
    const timers = new FakeTimers();
    const sent: ServerEvent[] = [];
    const jobs = new Map(existing.map((job) => [job.id, job]));
    const stream = openClientStream({
      bus,
      scope: {
        canSee: (clientId) => visible.has(clientId),
        clientOfJob: (id) => jobs.get(id)?.clientId ?? null,
        jobs: () => jobs.values(),
      },
      send: (event) => sent.push(event),
      ping: () => {},
      timers,
      now: timers.clock,
    });
    return { bus, timers, sent, stream, visible, jobs };
  }

  it('sends hello, and only the jobs of the editor’s clients', () => {
    const { bus, sent } = openScoped();
    bus.publish({ type: 'job.upsert', job: theirs('t1') });
    bus.publish({ type: 'job.upsert', job: mine('m1') });
    expect(sent).toEqual([{ type: 'hello' }, { type: 'job.upsert', job: mine('m1') }]);
  });

  it('leaves the price, currency and pay date out of an upsert, held ones included; an admin’s stream keeps them', () => {
    const delivery = {
      deliveredAt: '2026-10-21T09:00:00.000Z',
      price: 40,
      currency: 'ILS',
      paidOn: '2026-10-25',
    };
    const { bus, timers, sent } = openScoped();
    bus.publish({ type: 'job.upsert', job: mine('m1', { delivery }) });
    // Inside the window: held, and sent stripped when it ends.
    bus.publish({ type: 'job.upsert', job: mine('m1', { delivery, step: 3 }) });
    timers.advance(COALESCE_MS);
    expect(sent.slice(1)).toEqual([
      { type: 'job.upsert', job: mine('m1', { delivery: { deliveredAt: delivery.deliveredAt } }) },
      {
        type: 'job.upsert',
        job: mine('m1', { delivery: { deliveredAt: delivery.deliveredAt }, step: 3 }),
      },
    ]);
    expect(JSON.stringify(sent)).not.toMatch(/"price"|"currency"|"paidOn"/);

    const admin = open();
    admin.bus.publish({ type: 'job.upsert', job: mine('m1', { delivery }) });
    expect(admin.events().at(-1)).toEqual({ type: 'job.upsert', job: mine('m1', { delivery }) });
  });

  it('removes only jobs it knows: the seed, and every job it sent', () => {
    const { bus, sent } = openScoped();
    bus.publish({ type: 'job.remove', id: 't1' });
    bus.publish({ type: 'job.remove', id: 'unknown' });
    bus.publish({ type: 'job.remove', id: 'm1' }); // in the seed
    bus.publish({ type: 'job.upsert', job: mine('m2') });
    bus.publish({ type: 'job.remove', id: 'm2' }); // seen on the stream
    bus.publish({ type: 'job.remove', id: 'm2' }); // twice: the second is not news
    expect(sent).toEqual([
      { type: 'hello' },
      { type: 'job.remove', id: 'm1' },
      { type: 'job.upsert', job: mine('m2') },
      { type: 'job.remove', id: 'm2' },
    ]);
  });

  it('tells the browser to drop a job that the editor may no longer see', () => {
    const { bus, sent, visible } = openScoped();
    bus.publish({ type: 'job.upsert', job: mine('m1', { step: 2 }) });
    visible.clear();
    bus.publish({ type: 'job.upsert', job: mine('m1', { step: 3 }) });
    bus.publish({ type: 'job.upsert', job: mine('m1', { step: 4 }) });
    expect(sent.map((event) => event.type)).toEqual(['hello', 'job.upsert', 'job.remove']);
  });

  it('drops the notes, music, fix, client, series and removal events of other clients', () => {
    const { bus, sent } = openScoped();
    const note = (jobId: string) =>
      ({ type: 'note.upsert', note: { id: 'n', jobId } }) as unknown as ServerEvent;
    const fix = (jobId: string) =>
      ({ type: 'job.fix', jobId, fix: { id: 'f1', jobId } }) as unknown as ServerEvent;
    const generate = (jobId: string) =>
      ({ type: 'job.generate', jobId, generate: { phase: 'plan' } }) as unknown as ServerEvent;
    const events: ServerEvent[] = [
      note('t1'),
      { type: 'note.remove', jobId: 't1', noteId: 'n' },
      { type: 'job.music', jobId: 't1', music: null },
      fix('t1'),
      generate('t1'),
      { type: 'client.added', clientId: THEIRS, client: 'Theirs' },
      { type: 'client.removed', clientId: THEIRS, client: 'Theirs' },
      { type: 'client.upsert', style: { clientId: THEIRS } as never },
      { type: 'series.changed', series: makeSeries({ clientId: THEIRS }) },
      { type: 'series.removed', seriesId: 's', clientId: THEIRS },
    ];
    for (const event of events) bus.publish(event);
    expect(sent).toEqual([{ type: 'hello' }]);

    const own: ServerEvent[] = [
      note('m1'),
      { type: 'note.remove', jobId: 'm1', noteId: 'n' },
      { type: 'job.music', jobId: 'm1', music: null },
      fix('m1'),
      generate('m1'),
      { type: 'client.added', clientId: MINE, client: 'Mine' },
      { type: 'client.removed', clientId: MINE, client: 'Mine' },
      { type: 'client.upsert', style: { clientId: MINE } as never },
      { type: 'series.changed', series: makeSeries({ clientId: MINE }) },
      { type: 'series.removed', seriesId: 's', clientId: MINE },
    ];
    for (const event of own) bus.publish(event);
    expect(sent.slice(1)).toEqual(own);
  });

  it('sends the client-instagram events of the editor’s clients only', () => {
    const { bus, sent } = openScoped();
    bus.publish({ type: 'client-instagram', clientId: THEIRS });
    expect(sent).toEqual([{ type: 'hello' }]);

    bus.publish({ type: 'client-instagram', clientId: MINE });
    expect(sent.slice(1)).toEqual([{ type: 'client-instagram', clientId: MINE }]);
  });

  it('sends money.changed and the graphics events to nobody but an admin', () => {
    const { bus, sent } = openScoped();
    bus.publish({ type: 'money.changed' });
    bus.publish({ type: 'graphic.removed', id: 'g' });
    expect(sent).toEqual([{ type: 'hello' }]);
  });

  it('sends the LUT and font events to nobody but an admin', () => {
    const { bus, sent } = openScoped();
    bus.publish({ type: 'lut.removed', slug: 'golden-hour-warm' });
    bus.publish({ type: 'font.changed', family: makeFontFamilySummary() });
    bus.publish({ type: 'font.removed', slug: 'heebo' });
    bus.publish({ type: 'font.requested', name: 'Gotham Bold' });
    bus.publish({ type: 'font.request.dismissed', id: 'a3c19e0b7d44' });
    expect(sent).toEqual([{ type: 'hello' }]);
  });

  it('closes at access.changed and sends nothing about it; an admin’s stream stays open', () => {
    const { bus, sent, stream } = openScoped();
    const admin = open();
    bus.publish({ type: 'access.changed' });
    expect(stream.closed).toBe(true);
    expect(sent).toEqual([{ type: 'hello' }]);

    admin.bus.publish({ type: 'access.changed' });
    expect(admin.stream.closed).toBe(false);
    expect(admin.events()).toEqual([{ type: 'hello' }]);
  });

  it('lets a stream without a scope ask whether access.changed ends it', () => {
    const bus = createEventBus();
    let end = false;
    const stream = openClientStream({
      bus,
      closeOnAccessChange: () => end,
      send: () => {},
      ping: () => {},
    });
    bus.publish({ type: 'access.changed' });
    expect(stream.closed).toBe(false);
    end = true;
    bus.publish({ type: 'access.changed' });
    expect(stream.closed).toBe(true);
  });
});
