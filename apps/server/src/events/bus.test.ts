import type { ServerEvent } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { createEventBus, noopEventBus } from './bus.js';

const hello: ServerEvent = { type: 'hello' };
const removed: ServerEvent = { type: 'job.remove', id: 'abc' };

describe('createEventBus', () => {
  it('delivers each event to every subscriber, in order, before publish returns', () => {
    const bus = createEventBus();
    const first: ServerEvent[] = [];
    const second: ServerEvent[] = [];
    bus.subscribe((event) => first.push(event));
    bus.subscribe((event) => second.push(event));

    bus.publish(hello);
    bus.publish(removed);

    expect(first).toEqual([hello, removed]);
    expect(second).toEqual([hello, removed]);
  });

  it('stops delivering after unsubscribe, and unsubscribing twice is harmless', () => {
    const bus = createEventBus();
    const seen: ServerEvent[] = [];
    const stop = bus.subscribe((event) => seen.push(event));

    bus.publish(hello);
    stop();
    stop();
    bus.publish(removed);

    expect(seen).toEqual([hello]);
  });

  it('does not deliver earlier events to a late subscriber', () => {
    const bus = createEventBus();
    bus.publish(hello);
    const seen: ServerEvent[] = [];
    bus.subscribe((event) => seen.push(event));
    expect(seen).toEqual([]);
  });

  it('keeps going when a listener throws, and reports the error', () => {
    const errors: unknown[] = [];
    const bus = createEventBus({ onListenerError: (error) => errors.push(error) });
    const seen: ServerEvent[] = [];
    const boom = new Error('boom');
    bus.subscribe(() => {
      throw boom;
    });
    bus.subscribe((event) => seen.push(event));

    expect(() => bus.publish(hello)).not.toThrow();

    expect(seen).toEqual([hello]);
    expect(errors).toEqual([boom]);
  });

  it('swallows a listener error when no handler is given', () => {
    const bus = createEventBus();
    bus.subscribe(() => {
      throw new Error('boom');
    });
    expect(() => bus.publish(hello)).not.toThrow();
  });

  it('ignores changes to the subscriber list made while an event is being delivered', () => {
    const bus = createEventBus();
    const calls: string[] = [];
    let stopSecond = () => {};
    bus.subscribe(() => {
      calls.push('first');
      stopSecond();
      bus.subscribe(() => calls.push('late'));
    });
    stopSecond = bus.subscribe(() => calls.push('second'));

    bus.publish(hello);
    // The second listener was removed before its turn; the one added during the round waits.
    expect(calls).toEqual(['first']);

    calls.length = 0;
    bus.publish(hello);
    expect(calls).toEqual(['first', 'late']);
  });
});

describe('createEventBus, re-entrant publish', () => {
  const upsertOf = (id: string): ServerEvent => ({ type: 'job.remove', id });

  it('delivers an event published from a listener after the current one has reached everyone', () => {
    const bus = createEventBus();
    const first: string[] = [];
    const second: string[] = [];
    const id = (event: ServerEvent) => (event.type === 'job.remove' ? event.id : event.type);
    bus.subscribe((event) => {
      first.push(id(event));
      if (id(event) === 'a') bus.publish(upsertOf('b'));
    });
    bus.subscribe((event) => second.push(id(event)));

    bus.publish(upsertOf('a'));

    // Both listeners see a then b: the nested event does not jump the queue of the first.
    expect(first).toEqual(['a', 'b']);
    expect(second).toEqual(['a', 'b']);
  });

  it('has delivered everything, nested events included, when the outer publish returns', () => {
    const bus = createEventBus();
    const seen: ServerEvent[] = [];
    bus.subscribe((event) => {
      seen.push(event);
      if (event.type === 'hello') bus.publish(upsertOf('x'));
    });

    bus.publish(hello);

    expect(seen).toEqual([hello, upsertOf('x')]);
  });

  it('keeps delivering after an error handler that throws', () => {
    const bus = createEventBus({
      onListenerError: () => {
        throw new Error('handler');
      },
    });
    const seen: ServerEvent[] = [];
    bus.subscribe(() => {
      throw new Error('listener');
    });
    bus.subscribe((event) => seen.push(event));

    expect(() => bus.publish(hello)).not.toThrow();
    bus.publish(removed);

    expect(seen).toEqual([hello, removed]);
  });
});

describe('createEventBus, listenerCount', () => {
  it('counts the listeners that are subscribed', () => {
    const bus = createEventBus();
    expect(bus.listenerCount()).toBe(0);
    const stopFirst = bus.subscribe(() => {});
    const stopSecond = bus.subscribe(() => {});
    expect(bus.listenerCount()).toBe(2);
    stopFirst();
    stopFirst();
    expect(bus.listenerCount()).toBe(1);
    stopSecond();
    expect(bus.listenerCount()).toBe(0);
  });
});

describe('noopEventBus', () => {
  it('accepts events and subscribers and does nothing', () => {
    const seen: ServerEvent[] = [];
    const stop = noopEventBus.subscribe((event) => seen.push(event));
    noopEventBus.publish(hello);
    stop();
    expect(seen).toEqual([]);
  });
});
