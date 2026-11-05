import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { createEngineOffline, OFFLINE_AFTER_MS } from './engine-offline';
import { createEngineLink, createJobEventsClient, RECONNECTING_DELAY_MS } from './job-events';
import { fakeEventSources, manualTimers } from './test-utils';

/**
 * A link and an offline watch over it, each with timers run by hand and one clock the test moves,
 * so the "5 s" is seen as the delay it asks for and as the time that has passed.
 */
function setup() {
  let time = 1_000_000;
  const linkClock = manualTimers();
  const offlineClock = manualTimers();
  const link = createEngineLink({ timers: linkClock.timers, now: () => time });
  const offline = createEngineOffline(link, { timers: offlineClock.timers, now: () => time });
  const changes: boolean[] = [];
  offline.subscribe(() => changes.push(offline.isOffline()));
  return {
    link,
    offline,
    linkClock,
    offlineClock,
    changes,
    advance(ms: number) {
      time += ms;
    },
    /** The 2 s of bad news pass: the link says "reconnecting". */
    reconnecting() {
      time += RECONNECTING_DELAY_MS;
      linkClock.fire();
    },
  };
}

describe('the engine link remembers when it last heard the engine and when the outage began', () => {
  it('has heard nothing and is not down at the start', () => {
    const { link } = setup();
    expect(link.lastHeardAt()).toBeNull();
    expect(link.downSince()).toBeNull();
  });

  it('lastHeardAt is the last answer, and an outage does not move it', () => {
    const { link, advance } = setup();
    link.markUp();
    const heard = link.lastHeardAt();
    expect(heard).toBe(1_000_000);

    advance(15_000);
    link.markDown();
    advance(4_000);
    link.markDown();
    expect(link.lastHeardAt()).toBe(heard);

    advance(1_000);
    link.markUp();
    expect(link.lastHeardAt()).toBe(1_020_000);
  });

  it('downSince is the first bad news, not the later ones, and clears when the engine answers', () => {
    const { link, advance } = setup();
    link.markDown();
    expect(link.downSince()).toBe(1_000_000);
    advance(3_000);
    link.markDown(); // more bad news is not a new outage
    expect(link.downSince()).toBe(1_000_000);

    link.markUp();
    expect(link.downSince()).toBeNull();
    advance(1_000);
    link.markDown();
    expect(link.downSince()).toBe(1_004_000);
  });
});

describe('the phone is offline after more than 5 s without the engine', () => {
  it('is 5 s, counted from the first bad news and not from the link’s own 2 s', () => {
    expect(OFFLINE_AFTER_MS).toBe(5_000);
    const { offline, link, offlineClock, changes, reconnecting } = setup();
    link.markDown();
    // The link's wait is not over: nothing is scheduled yet, and nothing shows.
    expect(offlineClock.pendingCount).toBe(0);
    expect(offline.isOffline()).toBe(false);

    reconnecting();
    // 2 s have passed, so 3 s are left of the 5.
    expect(offlineClock.delays).toEqual([3_000]);
    expect(offline.isOffline()).toBe(false);
    expect(changes).toEqual([]);

    offlineClock.fire();
    expect(offline.isOffline()).toBe(true);
    expect(changes).toEqual([true]);
  });

  it('waits only what is left when the link’s own wait ran late (a throttled background page)', () => {
    const { offline, link, offlineClock, advance, linkClock } = setup();
    link.markDown();
    advance(4_500); // the page was asleep: the 2 s timer fires 4.5 s later
    linkClock.fire();

    expect(offlineClock.delays).toEqual([500]);
    offlineClock.fire();
    expect(offline.isOffline()).toBe(true);
  });

  it('is offline at once when the link’s own wait ended after the 5 s', () => {
    const { offline, link, offlineClock, advance, linkClock } = setup();
    link.markDown();
    advance(9_000);
    linkClock.fire();

    expect(offlineClock.delays).toEqual([0]);
    offlineClock.fire();
    expect(offline.isOffline()).toBe(true);
  });

  it('a break shorter than 2 s shows nothing at all', () => {
    const { offline, link, offlineClock, changes } = setup();
    link.markDown();
    link.markUp();
    expect(offlineClock.pendingCount).toBe(0);
    expect(offline.isOffline()).toBe(false);
    expect(changes).toEqual([]);
  });

  it('a break of 2 to 5 s never shows the screen, and its wait is cancelled', () => {
    const { offline, link, offlineClock, changes, reconnecting } = setup();
    link.markDown();
    reconnecting();
    expect(offlineClock.pendingCount).toBe(1);

    link.markUp();

    expect(offlineClock.pendingCount).toBe(0);
    expect(offline.isOffline()).toBe(false);
    expect(changes).toEqual([]); // not even a true-then-false
  });

  it('goes away the moment the engine answers', () => {
    const { offline, link, offlineClock, changes, reconnecting } = setup();
    link.markDown();
    reconnecting();
    offlineClock.fire();
    expect(offline.isOffline()).toBe(true);

    link.markUp();

    expect(offline.isOffline()).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  it('more bad news while waiting or while offline neither stacks waits nor re-announces', () => {
    const { offline, link, offlineClock, changes, reconnecting } = setup();
    link.markDown();
    link.markDown();
    reconnecting();
    link.markDown();
    expect(offlineClock.delays).toEqual([3_000]);
    offlineClock.fire();
    link.markDown();
    expect(offlineClock.delays).toEqual([3_000]);
    expect(offline.isOffline()).toBe(true);
    expect(changes).toEqual([true]);
  });

  it('counts the next outage from its own start', () => {
    const { offline, link, offlineClock, advance, changes, reconnecting } = setup();
    link.markDown();
    reconnecting();
    offlineClock.fire();
    link.markUp();

    advance(60_000);
    link.markDown();
    reconnecting();

    expect(offline.isOffline()).toBe(false);
    expect(offlineClock.delays).toEqual([3_000, 3_000]);
    offlineClock.fire();
    expect(offline.isOffline()).toBe(true);
    expect(changes).toEqual([true, false, true]);
  });

  it('tells nobody once they have unsubscribed', () => {
    const { offline, link, offlineClock, reconnecting } = setup();
    const heard = vi.fn();
    const unsubscribe = offline.subscribe(heard);
    unsubscribe();
    link.markDown();
    reconnecting();
    offlineClock.fire();
    expect(heard).not.toHaveBeenCalled();
  });
});

describe('with the events stream', () => {
  /** The stream and the link of the app, with the clocks run by hand. */
  function start() {
    const parts = setup();
    const sources = fakeEventSources();
    const streamClock = manualTimers();
    const client = createJobEventsClient({
      queryClient: new QueryClient(),
      eventSourceFactory: sources.factory,
      timers: streamClock.timers,
      link: parts.link,
      page: null,
    });
    client.start();
    return { ...parts, sources, streamClock, client };
  }

  it('a stream that breaks and stays broken ends in the offline screen, and its return in the page', () => {
    const { offline, sources, streamClock, offlineClock, reconnecting, changes } = start();
    sources.latest.emit({ type: 'hello' });
    sources.latest.fail();
    reconnecting();
    offlineClock.fire();
    expect(offline.isOffline()).toBe(true);

    // The client keeps trying, and each attempt fails while the Mac is away.
    for (let i = 0; i < 3; i++) {
      streamClock.fire();
      sources.latest.fail();
      expect(offline.isOffline()).toBe(true);
    }
    // The Mac is back: the first frame of the new stream is enough.
    streamClock.fire();
    sources.latest.emit({ type: 'hello' });

    expect(offline.isOffline()).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  it('a ping alone brings the page back', () => {
    const { offline, sources, streamClock, offlineClock, reconnecting } = start();
    sources.latest.fail();
    reconnecting();
    offlineClock.fire();
    expect(offline.isOffline()).toBe(true);

    streamClock.fire();
    sources.latest.ping();

    expect(offline.isOffline()).toBe(false);
  });

  it('remembers when the stream last spoke, for "Last connected"', () => {
    const { link, sources, advance } = start();
    advance(30_000);
    sources.latest.emit({ type: 'hello' });
    const spoke = link.lastHeardAt();
    expect(spoke).toBe(1_030_000);

    advance(20_000);
    sources.latest.fail();
    advance(60_000);

    expect(link.lastHeardAt()).toBe(spoke);
  });
});
