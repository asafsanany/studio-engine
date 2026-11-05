import { JOB_STATES, type Series } from '@studio/shared';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/data';
import { deferred, makeFormatJob, makeJob, makeSeries } from '@/data/test-utils';
import {
  askToStartSeries,
  confirmStartSeries,
  createStartSeriesDialogStore,
  nextEpisodeNames,
  type StartSeriesDeps,
  type StartSeriesTarget,
} from './start-series-dialog';

/** A ready job whose folder is "שאלות נפוצות 5". */
const READY = makeJob({
  id: 'faq-5',
  name: 'שאלות נפוצות 5',
  client: 'עו״ד דוד לוי',
  clientId: 'client-1',
  state: 'ready',
  output: { fileName: 'faq-5.mp4', durationSec: 34, width: 1080, height: 1920, sizeBytes: 1 },
});

/** What the dialog remembers about READY. */
const TARGET: StartSeriesTarget = {
  jobId: 'faq-5',
  jobName: 'שאלות נפוצות 5',
  clientId: 'client-1',
  client: 'עו״ד דוד לוי',
  suggested: 'שאלות נפוצות',
  durationSec: 34,
};

const STARTED: Series = makeSeries({ name: 'שאלות נפוצות', formatJobId: 'faq-5' });

function deps(overrides: Partial<StartSeriesDeps> = {}) {
  const calls = {
    startSeries: vi.fn<StartSeriesDeps['startSeries']>(() => Promise.resolve(STARTED)),
    done: vi.fn<StartSeriesDeps['done']>(),
    refused: vi.fn<StartSeriesDeps['refused']>(),
  };
  return { calls, deps: { ...calls, ...overrides } satisfies StartSeriesDeps };
}

/** A store with the question on screen for READY. */
function asking() {
  const store = createStartSeriesDialogStore();
  askToStartSeries(READY, store);
  return store;
}

describe('the Start a series dialog store', () => {
  it('starts closed, with nothing to show', () => {
    expect(createStartSeriesDialogStore().getState()).toMatchObject({
      phase: 'closed',
      target: null,
      name: '',
      problem: null,
    });
  });

  it('opens the question for a ready job, with the name its folder suggests already in the input', () => {
    const store = createStartSeriesDialogStore();
    askToStartSeries(READY, store);
    expect(store.getState()).toMatchObject({
      phase: 'asking',
      target: TARGET,
      name: 'שאלות נפוצות',
      problem: null,
    });
  });

  it.each([
    ['מיתוס או אמת 5', 'מיתוס או אמת'],
    ['מיתוס או אמת #5', 'מיתוס או אמת'],
    ['Spring menu', 'Spring menu'],
  ])('suggests the name of "%s" without its number: "%s"', (jobName, suggested) => {
    const store = createStartSeriesDialogStore();
    askToStartSeries(makeFormatJob({ name: jobName, seriesId: null, episode: null }), store);
    expect(store.getState().name).toBe(suggested);
    expect(store.getState().target?.suggested).toBe(suggested);
  });

  it('remembers the length of the job’s export for the caption under its still', () => {
    const store = createStartSeriesDialogStore();
    askToStartSeries({ ...READY, output: null }, store);
    expect(store.getState().target?.durationSec).toBeNull();
  });

  it.each(JOB_STATES.filter((state) => state !== 'ready'))(
    'does not open for a job that is %s: only an approved job can start a series',
    (state) => {
      const store = createStartSeriesDialogStore();
      askToStartSeries(makeJob({ state }), store);
      expect(store.getState().phase).toBe('closed');
    },
  );

  it('takes what is typed, and a refusal of the old name goes away with it', () => {
    const store = asking();
    store.setState({ problem: 'taken' });
    store.getState().setName('שאלות נפוצות – ערוץ 2');
    expect(store.getState()).toMatchObject({ name: 'שאלות נפוצות – ערוץ 2', problem: null });
  });

  it('closes on cancel, Escape or a click outside', () => {
    const store = asking();
    store.getState().dismiss();
    expect(store.getState().phase).toBe('closed');
    // The job stays for the fade-out.
    expect(store.getState().target).toEqual(TARGET);
  });

  it('forgets everything when the page is left', () => {
    const store = asking();
    store.getState().reset();
    expect(store.getState()).toMatchObject({ phase: 'closed', target: null, name: '' });
  });
});

describe('confirming the name', () => {
  it('sends the name as it was typed, trimmed', () => {
    const store = asking();
    store.getState().setName('  מיתוס או אמת  ');
    expect(store.getState().confirm()).toEqual({ jobId: 'faq-5', name: 'מיתוס או אמת' });
    expect(store.getState().phase).toBe('saving');
  });

  it.each(['', '   '])('sends nothing while the name is empty (%j): the button is off', (name) => {
    const store = asking();
    store.getState().setName(name);
    expect(store.getState().confirm()).toBeNull();
    expect(store.getState().phase).toBe('asking');
  });

  it.each([
    ['a/b', 'A series name can’t contain / or :.'],
    ['.hidden', 'A series name can’t start with . or _.'],
    ['_Style', 'A series name can’t start with . or _.'],
  ])('does not ask the server about "%s": it says why under the input', (name, problem) => {
    const store = asking();
    store.getState().setName(name);
    expect(store.getState().confirm()).toBeNull();
    expect(store.getState()).toMatchObject({ phase: 'asking', problem });
  });

  it('does nothing when no question is on screen', () => {
    expect(createStartSeriesDialogStore().getState().confirm()).toBeNull();
  });
});

describe('confirmStartSeries', () => {
  it('sends the job and the name, then closes the dialog and tells the person', async () => {
    const store = asking();
    const { calls, deps: d } = deps();
    await confirmStartSeries(d, store);
    expect(calls.startSeries).toHaveBeenCalledExactlyOnceWith({
      jobId: 'faq-5',
      name: 'שאלות נפוצות',
    });
    expect(store.getState().phase).toBe('closed');
    expect(calls.done).toHaveBeenCalledExactlyOnceWith(TARGET, STARTED);
    expect(calls.refused).not.toHaveBeenCalled();
  });

  it('sends the name the person changed it to', async () => {
    const store = asking();
    store.getState().setName('שאלות נפוצות – לילה');
    const { calls, deps: d } = deps();
    await confirmStartSeries(d, store);
    expect(calls.startSeries).toHaveBeenCalledWith({ jobId: 'faq-5', name: 'שאלות נפוצות – לילה' });
  });

  it('asks nothing of the server while the name is empty', async () => {
    const store = asking();
    store.getState().setName('');
    const { calls, deps: d } = deps();
    await confirmStartSeries(d, store);
    expect(calls.startSeries).not.toHaveBeenCalled();
    expect(store.getState().phase).toBe('asking');
  });

  it('keeps the dialog in "saving", closed to Cancel and Escape, until the answer is in', async () => {
    const store = asking();
    const answer = deferred<Series>();
    const { calls, deps: d } = deps({ startSeries: () => answer.promise });
    const running = confirmStartSeries(d, store);
    expect(store.getState().phase).toBe('saving');
    store.getState().dismiss();
    expect(store.getState().phase).toBe('saving');
    // A second press while it is in flight is not a second request.
    await confirmStartSeries(d, store);
    answer.resolve(STARTED);
    await running;
    expect(store.getState().phase).toBe('closed');
    expect(calls.done).toHaveBeenCalledOnce();
  });

  it('puts a refused name (422) under the input and keeps the dialog open for another', async () => {
    const store = asking();
    const taken = new ApiError(422, 'This client already has a series called שאלות נפוצות.');
    const { calls, deps: d } = deps({ startSeries: () => Promise.reject(taken) });
    await confirmStartSeries(d, store);
    expect(store.getState()).toMatchObject({
      phase: 'asking',
      name: 'שאלות נפוצות',
      problem: 'This client already has a series called שאלות נפוצות.',
    });
    expect(calls.done).not.toHaveBeenCalled();
    expect(calls.refused).not.toHaveBeenCalled();

    // The person types another name and tries again.
    store.getState().setName('שאלות נפוצות – לילה');
    expect(store.getState().problem).toBeNull();
    await confirmStartSeries(deps().deps, store);
    expect(store.getState().phase).toBe('closed');
  });

  it('closes the dialog and says why when the job can’t start a series (409)', async () => {
    const store = asking();
    const busy = new ApiError(409, 'This client’s style is being learned. Try again in a minute.');
    const { calls, deps: d } = deps({ startSeries: () => Promise.reject(busy) });
    await confirmStartSeries(d, store);
    expect(store.getState().phase).toBe('closed');
    expect(calls.refused).toHaveBeenCalledExactlyOnceWith(TARGET, busy.message);
    expect(calls.done).not.toHaveBeenCalled();
  });

  it('says so when the engine can’t be reached', async () => {
    const store = asking();
    const { calls, deps: d } = deps({
      startSeries: () => Promise.reject(new ApiError(0, 'Cannot reach the Studio Engine server.')),
    });
    await confirmStartSeries(d, store);
    expect(store.getState().phase).toBe('closed');
    expect(calls.refused).toHaveBeenCalledWith(TARGET, 'Cannot reach the Studio Engine server.');
  });

  it('still tells the person when the page was left while the request ran', async () => {
    const store = asking();
    const answer = deferred<Series>();
    const { calls, deps: d } = deps({ startSeries: () => answer.promise });
    const running = confirmStartSeries(d, store);
    store.getState().reset();
    answer.resolve(STARTED);
    await running;
    expect(calls.done).toHaveBeenCalledExactlyOnceWith(TARGET, STARTED);
    expect(store.getState().phase).toBe('closed');
  });
});

describe('nextEpisodeNames', () => {
  it('counts on from the job’s own number, under the name in the input', () => {
    expect(nextEpisodeNames('שאלות נפוצות', TARGET)).toEqual(['שאלות נפוצות 6', 'שאלות נפוצות 7']);
    expect(nextEpisodeNames('Q&A', TARGET)).toEqual(['Q&A 6', 'Q&A 7']);
  });

  it('uses the suggested name while the input is empty', () => {
    expect(nextEpisodeNames('  ', TARGET)).toEqual(['שאלות נפוצות 6', 'שאלות נפוצות 7']);
  });

  it('counts a job with no number as episode 1', () => {
    const target = { jobName: 'Spring menu', suggested: 'Spring menu' };
    expect(nextEpisodeNames('Spring menu', target)).toEqual(['Spring menu 2', 'Spring menu 3']);
  });

  it('reads a "#" in front of the number', () => {
    const target = { jobName: 'מיתוס או אמת #12', suggested: 'מיתוס או אמת' };
    expect(nextEpisodeNames('מיתוס או אמת', target)).toEqual([
      'מיתוס או אמת 13',
      'מיתוס או אמת 14',
    ]);
  });
});
