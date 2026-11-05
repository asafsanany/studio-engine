import type { LutListResponse, ServerEvent } from '@studio/shared';
import type { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJobEventsClient } from './job-events';
import { LUT_LIST_KEY, lutKey } from './luts-query';
import {
  createTestQueryClient,
  fakeEventSources,
  makeBuiltInLutSummary,
  makeLutDetail,
  makeLutSummary,
  manualTimers,
} from './test-utils';

// The LUTs caches follow the LUT events: each carries the summary, so the list and the LUT's pane
// are patched in place; a hello loads every LUTs query again.

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

const list = () => queryClient.getQueryData<LutListResponse>(LUT_LIST_KEY);
const empty: LutListResponse = { yours: [], builtIn: [], builtInAvailable: true };

describe('the LUTs caches and the events', () => {
  it('take lut.changed into the list, and over a pane that is cached', () => {
    queryClient.setQueryData(LUT_LIST_KEY, empty);
    queryClient.setQueryData(
      lutKey('golden-hour-warm'),
      makeLutDetail({ used: 0, usedLabel: 'Not used yet' }),
    );
    const { sources, onUnreadableEvent } = start();
    const lut = makeLutSummary({ isNew: true });

    sources.latest.emit({ type: 'lut.changed', lut } satisfies ServerEvent);

    expect(onUnreadableEvent).not.toHaveBeenCalled();
    expect(list()?.yours).toEqual([lut]);
    expect(queryClient.getQueryData(lutKey('golden-hour-warm'))).toMatchObject({
      used: 3,
      isNew: true,
    });
  });

  it('take a built-in row’s new count in place', () => {
    queryClient.setQueryData(LUT_LIST_KEY, { ...empty, builtIn: [makeBuiltInLutSummary()] });
    const { sources } = start();
    const used = makeBuiltInLutSummary({ used: 1, usedLabel: '1 job' });

    sources.latest.emit({ type: 'lut.changed', lut: used } satisfies ServerEvent);

    expect(list()?.builtIn).toEqual([used]);
    expect(list()?.yours).toEqual([]);
  });

  it('leave a pane nobody loaded alone', () => {
    queryClient.setQueryData(LUT_LIST_KEY, empty);
    const { sources } = start();
    sources.latest.emit({ type: 'lut.changed', lut: makeLutSummary() } satisfies ServerEvent);
    expect(queryClient.getQueryData(lutKey('golden-hour-warm'))).toBeUndefined();
  });

  it('take lut.removed out of the list and reset the pane', () => {
    queryClient.setQueryData(LUT_LIST_KEY, { ...empty, yours: [makeLutSummary()] });
    queryClient.setQueryData(lutKey('golden-hour-warm'), makeLutDetail());
    const { sources } = start();

    sources.latest.emit({ type: 'lut.removed', slug: 'golden-hour-warm' } satisfies ServerEvent);

    expect(list()?.yours).toEqual([]);
    expect(queryClient.getQueryData(lutKey('golden-hour-warm'))).toBeUndefined();
  });

  it('load every LUTs query again on a hello', () => {
    queryClient.setQueryData(LUT_LIST_KEY, empty);
    queryClient.setQueryData(lutKey('golden-hour-warm'), makeLutDetail());
    const { sources } = start();

    sources.latest.emit({ type: 'hello' } satisfies ServerEvent);

    expect(queryClient.getQueryState(LUT_LIST_KEY)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(lutKey('golden-hour-warm'))?.isInvalidated).toBe(true);
  });
});
