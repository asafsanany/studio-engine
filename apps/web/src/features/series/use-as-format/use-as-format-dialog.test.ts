import { JOB_STATES, type Series } from '@studio/shared';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/data';
import {
  deferred,
  makeEpisodeJob,
  makeFormatJob,
  makeJob,
  makeSeries,
  makeSeriesSummary,
} from '@/data/test-utils';
import {
  askToUseAsFormat,
  confirmUseAsFormat,
  createUseAsFormatDialogStore,
  type UseAsFormatDeps,
  type UseAsFormatTarget,
} from './use-as-format-dialog';

const SERIES = makeSeriesSummary();
const EPISODE = makeEpisodeJob({ state: 'ready' });

/** What the dialog remembers about EPISODE and SERIES. */
const TARGET: UseAsFormatTarget = {
  jobId: EPISODE.id,
  jobName: 'מיתוס או אמת 6',
  clientId: EPISODE.clientId,
  seriesId: SERIES.id,
  seriesName: 'מיתוס או אמת',
  formatJobId: SERIES.formatJobId,
  formatJobName: 'מיתוס או אמת 5',
};

const CHANGED: Series = makeSeries({ state: 'learning', formatJobId: EPISODE.id });

function deps(overrides: Partial<UseAsFormatDeps> = {}) {
  const calls = {
    setFormat: vi.fn<UseAsFormatDeps['setFormat']>(() => Promise.resolve(CHANGED)),
    done: vi.fn<UseAsFormatDeps['done']>(),
    refused: vi.fn<UseAsFormatDeps['refused']>(),
  };
  return { calls, deps: { ...calls, ...overrides } satisfies UseAsFormatDeps };
}

/** A store with the question on screen for EPISODE. */
function asking() {
  const store = createUseAsFormatDialogStore();
  askToUseAsFormat(EPISODE, SERIES, store);
  return store;
}

describe('the Use as format dialog store', () => {
  it('starts closed, with nothing to show', () => {
    expect(createUseAsFormatDialogStore().getState()).toMatchObject({
      phase: 'closed',
      target: null,
    });
  });

  it('opens the question for a ready episode, remembering the series and the format it has now', () => {
    expect(asking().getState()).toMatchObject({ phase: 'asking', target: TARGET });
  });

  it.each(JOB_STATES.filter((state) => state !== 'ready'))(
    'does not open for an episode that is %s: only an approved one can be the format',
    (state) => {
      const store = createUseAsFormatDialogStore();
      askToUseAsFormat(makeEpisodeJob({ state }), SERIES, store);
      expect(store.getState().phase).toBe('closed');
    },
  );

  it('does not open for the format job itself, nor for a job of another series or of none', () => {
    const store = createUseAsFormatDialogStore();
    askToUseAsFormat(makeFormatJob(), SERIES, store);
    askToUseAsFormat(makeJob({ state: 'ready' }), SERIES, store);
    askToUseAsFormat(makeEpisodeJob({ state: 'ready', seriesId: 'other' }), SERIES, store);
    expect(store.getState().phase).toBe('closed');
  });

  it('closes on cancel, Escape or a click outside, remembering the episode for the fade-out', () => {
    const store = asking();
    store.getState().dismiss();
    expect(store.getState()).toMatchObject({ phase: 'closed', target: TARGET });
  });

  it('forgets everything when the page is left', () => {
    const store = asking();
    store.getState().reset();
    expect(store.getState()).toMatchObject({ phase: 'closed', target: null });
  });
});

describe('confirmUseAsFormat', () => {
  it('asks the series to take the episode as its format, then closes and tells the person', async () => {
    const store = asking();
    const { calls, deps: d } = deps();
    await confirmUseAsFormat(d, store);
    expect(calls.setFormat).toHaveBeenCalledExactlyOnceWith({
      seriesId: SERIES.id,
      jobId: EPISODE.id,
    });
    expect(store.getState().phase).toBe('closed');
    expect(calls.done).toHaveBeenCalledExactlyOnceWith(TARGET, CHANGED);
    expect(calls.refused).not.toHaveBeenCalled();
  });

  it('keeps the dialog in "saving", closed to Cancel and Escape, until the answer is in', async () => {
    const store = asking();
    const answer = deferred<Series>();
    const { calls, deps: d } = deps({ setFormat: () => answer.promise });
    const running = confirmUseAsFormat(d, store);
    expect(store.getState().phase).toBe('saving');
    store.getState().dismiss();
    expect(store.getState().phase).toBe('saving');
    // A second press while it is in flight is not a second request.
    await confirmUseAsFormat(d, store);
    answer.resolve(CHANGED);
    await running;
    expect(store.getState().phase).toBe('closed');
    expect(calls.done).toHaveBeenCalledOnce();
  });

  it('closes the dialog and says why when the server refuses (409)', async () => {
    const store = asking();
    const busy = new ApiError(409, 'This series is being learned. Try again in a minute.');
    const { calls, deps: d } = deps({ setFormat: () => Promise.reject(busy) });
    await confirmUseAsFormat(d, store);
    expect(store.getState().phase).toBe('closed');
    expect(calls.refused).toHaveBeenCalledExactlyOnceWith(TARGET, busy.message);
    expect(calls.done).not.toHaveBeenCalled();
  });

  it('says so when the engine can’t be reached', async () => {
    const store = asking();
    const { calls, deps: d } = deps({
      setFormat: () => Promise.reject(new ApiError(0, 'Cannot reach the Studio Engine server.')),
    });
    await confirmUseAsFormat(d, store);
    expect(calls.refused).toHaveBeenCalledWith(TARGET, 'Cannot reach the Studio Engine server.');
  });

  it('does nothing when no question is on screen', async () => {
    const { calls, deps: d } = deps();
    await confirmUseAsFormat(d, createUseAsFormatDialogStore());
    expect(calls.setFormat).not.toHaveBeenCalled();
  });

  it('still tells the person when the page was left while the request ran', async () => {
    const store = asking();
    const answer = deferred<Series>();
    const { calls, deps: d } = deps({ setFormat: () => answer.promise });
    const running = confirmUseAsFormat(d, store);
    store.getState().reset();
    answer.resolve(CHANGED);
    await running;
    expect(calls.done).toHaveBeenCalledExactlyOnceWith(TARGET, CHANGED);
  });
});
