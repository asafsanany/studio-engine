import type { FontsListResponse, ServerEvent } from '@studio/shared';
import type { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FONT_LIST_KEY, fontKey } from './fonts-query';
import { createJobEventsClient } from './job-events';
import {
  createTestQueryClient,
  fakeEventSources,
  makeFontFace,
  makeFontFamilyDetail,
  makeFontFamilySummary,
  makeFontRequest,
  manualTimers,
} from './test-utils';

// The Fonts caches follow the font events: each carries the summary, so the list and the family's
// pane are patched in place; a hello loads every Fonts query again.

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

const list = () => queryClient.getQueryData<FontsListResponse>(FONT_LIST_KEY);
const heebo = makeFontFamilySummary();
const karantina = makeFontFamilySummary({
  slug: 'karantina',
  name: 'Karantina',
  weights: [300, 400, 700],
  weightsLabel: '3 weights',
  used: 0,
  usedLabel: 'Not used yet',
  isNew: true,
});
const seeded: FontsListResponse = { families: [heebo], catalog: [makeFontFace()], requests: [] };

describe('the Fonts caches and the events', () => {
  it('take font.changed into the list, and over a pane that is cached', () => {
    queryClient.setQueryData(FONT_LIST_KEY, seeded);
    queryClient.setQueryData(fontKey('heebo'), makeFontFamilyDetail({ used: 14, usedIn: 14 }));
    const { sources, onUnreadableEvent } = start();
    const used = { ...heebo, used: 15, usedLabel: '15 jobs' };

    sources.latest.emit({ type: 'font.changed', family: used } satisfies ServerEvent);

    expect(onUnreadableEvent).not.toHaveBeenCalled();
    expect(list()?.families).toEqual([used]);
    expect(queryClient.getQueryData(fontKey('heebo'))).toMatchObject({ used: 15, usedIn: 15 });
  });

  it('put a family that arrives in the list A to Z, and ask for the catalog again', () => {
    queryClient.setQueryData(FONT_LIST_KEY, seeded);
    const { sources } = start();

    sources.latest.emit({ type: 'font.changed', family: karantina } satisfies ServerEvent);

    expect(list()?.families.map((family) => family.slug)).toEqual(['heebo', 'karantina']);
    expect(queryClient.getQueryState(FONT_LIST_KEY)?.isInvalidated).toBe(true);
  });

  it('leave a pane nobody loaded alone', () => {
    queryClient.setQueryData(FONT_LIST_KEY, seeded);
    const { sources } = start();
    sources.latest.emit({ type: 'font.changed', family: heebo } satisfies ServerEvent);
    expect(queryClient.getQueryData(fontKey('heebo'))).toBeUndefined();
  });

  it('take font.removed out of the list with its faces and reset the pane', () => {
    queryClient.setQueryData(FONT_LIST_KEY, seeded);
    queryClient.setQueryData(fontKey('heebo'), makeFontFamilyDetail());
    const { sources } = start();

    sources.latest.emit({ type: 'font.removed', slug: 'heebo' } satisfies ServerEvent);

    expect(list()?.families).toEqual([]);
    expect(list()?.catalog).toEqual([]);
    expect(queryClient.getQueryData(fontKey('heebo'))).toBeUndefined();
  });

  it('load the list again on font.requested (the banner needs the job’s name), and no pane', () => {
    queryClient.setQueryData(FONT_LIST_KEY, seeded);
    queryClient.setQueryData(fontKey('heebo'), makeFontFamilyDetail());
    const { sources } = start();

    sources.latest.emit({ type: 'font.requested', name: 'Gotham Bold' } satisfies ServerEvent);

    expect(queryClient.getQueryState(FONT_LIST_KEY)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(fontKey('heebo'))?.isInvalidated).toBe(false);
    // What was on screen stays until the new answer comes.
    expect(list()).toEqual(seeded);
  });

  it('take the request out of the list on font.request.dismissed, and load the list again', () => {
    const falcon = makeFontRequest({ id: 'a3c19e0b7d44', name: 'Falcon' });
    const gotham = makeFontRequest({ id: 'b4d20f1c8e55', name: 'Gotham Bold' });
    queryClient.setQueryData(FONT_LIST_KEY, { ...seeded, requests: [falcon, gotham] });
    queryClient.setQueryData(fontKey('heebo'), makeFontFamilyDetail());
    const { sources, onUnreadableEvent } = start();

    sources.latest.emit({
      type: 'font.request.dismissed',
      id: 'a3c19e0b7d44',
    } satisfies ServerEvent);

    expect(onUnreadableEvent).not.toHaveBeenCalled();
    expect(list()?.requests).toEqual([gotham]);
    expect(queryClient.getQueryState(FONT_LIST_KEY)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(fontKey('heebo'))?.isInvalidated).toBe(false);
  });

  it('load every Fonts query again on a hello', () => {
    queryClient.setQueryData(FONT_LIST_KEY, seeded);
    queryClient.setQueryData(fontKey('heebo'), makeFontFamilyDetail());
    const { sources } = start();

    sources.latest.emit({ type: 'hello' } satisfies ServerEvent);

    expect(queryClient.getQueryState(FONT_LIST_KEY)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(fontKey('heebo'))?.isInvalidated).toBe(true);
  });
});
