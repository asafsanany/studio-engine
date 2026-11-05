import type { GraphicDetail, GraphicSummary, ServerEvent } from '@studio/shared';
import type { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GRAPHIC_LIST_KEY, graphicKey } from './graphics-query';
import { createJobEventsClient } from './job-events';
import {
  createTestQueryClient,
  fakeEventSources,
  GRAPHIC_ID,
  makeGraphicDetail,
  makeGraphicMessage,
  makeGraphicSummary,
  manualTimers,
} from './test-utils';

// The graphics caches follow the graphic events: each carries what changed, so the list and the
// graphic's page are patched in place; a hello loads every graphics query again.

let queryClient: QueryClient;
beforeEach(() => {
  queryClient = createTestQueryClient();
});

function start() {
  const sources = fakeEventSources();
  const onUnreadableEvent = vi.fn();
  createJobEventsClient({
    queryClient,
    eventSourceFactory: sources.factory,
    timers: manualTimers().timers,
    onUnreadableEvent,
    page: null,
  }).start();
  return { sources, onUnreadableEvent };
}

const list = () => queryClient.getQueryData<GraphicSummary[]>(GRAPHIC_LIST_KEY);
const page = () => queryClient.getQueryData<GraphicDetail>(graphicKey(GRAPHIC_ID));

describe('the graphics caches and the events', () => {
  it('take graphic.changed into the list and the page, with its message', () => {
    queryClient.setQueryData(GRAPHIC_LIST_KEY, []);
    queryClient.setQueryData(graphicKey(GRAPHIC_ID), makeGraphicDetail());
    const { sources, onUnreadableEvent } = start();
    const graphic = makeGraphicSummary({ status: 'making', makingVersion: 3 });
    const message = makeGraphicMessage({ id: 'm3', version: 3, status: 'making', step: 0 });

    sources.latest.emit({ type: 'graphic.changed', graphic, message } satisfies ServerEvent);

    expect(onUnreadableEvent).not.toHaveBeenCalled();
    expect(list()).toEqual([graphic]);
    expect(page()).toMatchObject({ status: 'making', makingVersion: 3 });
    expect(page()?.messages.at(-1)).toEqual(message);
  });

  it('take how many videos used a graphic into its page, and leave a page nobody loaded alone', () => {
    queryClient.setQueryData(GRAPHIC_LIST_KEY, [makeGraphicSummary()]);
    queryClient.setQueryData(graphicKey(GRAPHIC_ID), makeGraphicDetail({ usedIn: 1 }));
    const { sources, onUnreadableEvent } = start();
    const graphic = makeGraphicSummary();

    sources.latest.emit({ type: 'graphic.changed', graphic, usedIn: 2 } satisfies ServerEvent);

    expect(onUnreadableEvent).not.toHaveBeenCalled();
    expect(page()?.usedIn).toBe(2);
    expect(list()).toEqual([graphic]);
    // no page cached for this graphic: nothing is made up, the page asks when it opens
    const other = makeGraphicSummary({ id: '000000000002', name: 'Title' });
    sources.latest.emit({
      type: 'graphic.changed',
      graphic: other,
      usedIn: 5,
    } satisfies ServerEvent);
    expect(queryClient.getQueryData(graphicKey('000000000002'))).toBeUndefined();
  });

  it('keep a page’s count when an event does not carry one', () => {
    queryClient.setQueryData(GRAPHIC_LIST_KEY, [makeGraphicSummary()]);
    queryClient.setQueryData(graphicKey(GRAPHIC_ID), makeGraphicDetail({ usedIn: 3 }));
    const { sources } = start();

    sources.latest.emit({
      type: 'graphic.changed',
      graphic: makeGraphicSummary({ uses: false }),
    } satisfies ServerEvent);

    expect(page()).toMatchObject({ uses: false, usedIn: 3 });
  });

  it('take graphic.removed out of the list and reset the page', () => {
    queryClient.setQueryData(GRAPHIC_LIST_KEY, [makeGraphicSummary()]);
    queryClient.setQueryData(graphicKey(GRAPHIC_ID), makeGraphicDetail());
    const { sources } = start();

    sources.latest.emit({ type: 'graphic.removed', id: GRAPHIC_ID });

    expect(list()).toEqual([]);
    expect(page()).toBeUndefined();
  });

  it('load every graphics query again on hello', () => {
    queryClient.setQueryData(GRAPHIC_LIST_KEY, [makeGraphicSummary()]);
    queryClient.setQueryData(graphicKey(GRAPHIC_ID), makeGraphicDetail());
    const { sources } = start();

    sources.latest.emit({ type: 'hello' });

    expect(queryClient.getQueryState(GRAPHIC_LIST_KEY)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(graphicKey(GRAPHIC_ID))?.isInvalidated).toBe(true);
  });

  it('leave the graphics alone for the other events', () => {
    queryClient.setQueryData(GRAPHIC_LIST_KEY, [makeGraphicSummary()]);
    const { sources } = start();

    sources.latest.emit({ type: 'money.changed' });

    expect(queryClient.getQueryState(GRAPHIC_LIST_KEY)?.isInvalidated).toBe(false);
  });
});
