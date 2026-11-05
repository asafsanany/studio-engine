import { canChangeSeries, JOB_STATES, type Job } from '@studio/shared';
import { Check, CircleMinus, Layers2 } from 'lucide-react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeEpisodeJob, makeFormatJob, makeJob, makeSeriesSummary } from '@/data/test-utils';
import { rowMenuEntries } from '@/features/jobs/row-menu';
import {
  FORMAT_NOT_READY_REASON,
  NO_SERIES_MENU,
  NOT_IN_A_SERIES_OPTION,
  SERIES_SUBMENU_ID,
  type SeriesMenuContext,
  seriesMenuEntries,
} from './series-menu';
import { startSeriesDialogStore } from './start-series/start-series-dialog';
import { asFormatDialogStore } from './use-as-format/use-as-format-dialog';

const idle = { run: () => {}, busy: false };

/** What the menu shows of its entries (their handlers are new functions each time). */
const shown = (entries: ReturnType<typeof rowMenuEntries>) =>
  entries.map((entry) =>
    entry.type === 'item'
      ? { id: entry.id, label: entry.label, disabled: entry.disabled ?? false }
      : { id: entry.id },
  );

/** The ids of the entries, in order. */
const ids = (entries: ReturnType<typeof seriesMenuEntries>) => entries.map((entry) => entry.id);

const MYTH = makeSeriesSummary();
const FAQ = makeSeriesSummary({ id: '5d1c0a9e7b21', name: 'שאלות נפוצות', formatJobId: 'faq-5' });
const on: SeriesMenuContext = { enabled: true, clientSeries: [MYTH] };

/** A job of `state` that is in no series. */
const free = (state: Job['state']) => makeJob({ state });

beforeEach(() => {
  startSeriesDialogStore.getState().reset();
  asFormatDialogStore.getState().reset();
});

describe('seriesMenuEntries: series off', () => {
  it('has nothing for any state, with the empty menu or with series known', () => {
    expect(NO_SERIES_MENU).toEqual({ enabled: false, clientSeries: [] });
    for (const state of JOB_STATES) {
      expect(seriesMenuEntries(makeJob({ state }), NO_SERIES_MENU), state).toEqual([]);
      expect(
        seriesMenuEntries(makeJob({ state }), { enabled: false, clientSeries: [MYTH] }),
        state,
      ).toEqual([]);
      expect(
        seriesMenuEntries(makeEpisodeJob({ state }), { enabled: false, clientSeries: [MYTH] }),
        state,
      ).toEqual([]);
    }
  });

  it('leaves every row menu as it was', () => {
    for (const job of [
      ...JOB_STATES.map((state) => makeJob({ state })),
      makeEpisodeJob(),
      makeFormatJob(),
    ]) {
      expect(
        shown(rowMenuEntries(job, idle, null, { enabled: false, clientSeries: [MYTH] })),
      ).toEqual(shown(rowMenuEntries(job, idle)));
    }
  });
});

describe('seriesMenuEntries: a job in no series', () => {
  it('a ready job offers "Start a series from this…", whether or not the client has series', () => {
    for (const context of [on, { enabled: true, clientSeries: [] }]) {
      const entries = seriesMenuEntries(free('ready'), context);
      expect(ids(entries)).toEqual(['series-start']);
      expect(entries[0]).toMatchObject({
        type: 'item',
        label: 'Start a series from this…',
        icon: Layers2,
      });
    }
  });

  it('asks the page for the Start a series dialog for the job', () => {
    const job = free('ready');
    const [start] = seriesMenuEntries(job, on);
    if (start?.type !== 'item') throw new Error('not an item');
    start.onSelect();
    expect(startSeriesDialogStore.getState()).toMatchObject({
      phase: 'asking',
      target: { jobId: job.id },
    });
  });

  it.each(['arriving', 'queued', 'held'] as const)(
    'a %s job of a client that has series gets a Series submenu after a line',
    (state) => {
      const entries = seriesMenuEntries(free(state), { enabled: true, clientSeries: [MYTH, FAQ] });
      expect(ids(entries)).toEqual(['series-separator', SERIES_SUBMENU_ID]);
      const submenu = entries[1];
      if (submenu?.type !== 'submenu') throw new Error('not a submenu');
      expect(submenu).toMatchObject({ label: 'Series', icon: Layers2, trailing: null });
      expect(submenu.disabled).toBeUndefined();
      expect(submenu.options).toEqual([
        { id: MYTH.id, label: MYTH.name, hint: '' },
        { id: FAQ.id, label: FAQ.name, hint: '' },
        { id: NOT_IN_A_SERIES_OPTION, label: 'Not in a series', hint: '' },
      ]);
      // In no series: the last choice is the checked one.
      expect(submenu.value).toBe(NOT_IN_A_SERIES_OPTION);
    },
  );

  it.each(['arriving', 'queued', 'held'] as const)(
    'a %s job of a client with no series has nothing',
    (state) => {
      expect(seriesMenuEntries(free(state), { enabled: true, clientSeries: [] })).toEqual([]);
    },
  );

  it.each(['editing', 'review', 'failed', 'cancelled'] as const)(
    'a %s job has nothing: it has started, so it keeps its place',
    (state) => {
      expect(canChangeSeries({ state })).toBe(false);
      expect(seriesMenuEntries(free(state), on)).toEqual([]);
    },
  );

  it('choosing a series puts the job in it, and "Not in a series" takes it out', () => {
    const setJobSeries = vi.fn();
    const entries = seriesMenuEntries(free('queued'), {
      enabled: true,
      clientSeries: [MYTH, FAQ],
      setJobSeries,
    });
    const submenu = entries[1];
    if (submenu?.type !== 'submenu') throw new Error('not a submenu');
    submenu.onValueChange(FAQ.id);
    expect(setJobSeries).toHaveBeenLastCalledWith(FAQ.id);
    submenu.onValueChange(NOT_IN_A_SERIES_OPTION);
    // The job is in none already: nothing to ask the server.
    expect(setJobSeries).toHaveBeenCalledTimes(1);
  });
});

describe('seriesMenuEntries: an episode', () => {
  it('a queued episode has the Series submenu with its series checked, and "Open the series"', () => {
    const entries = seriesMenuEntries(makeEpisodeJob(), on);
    expect(ids(entries)).toEqual(['series-separator', SERIES_SUBMENU_ID, 'series-open']);
    const [, submenu, open] = entries;
    if (submenu?.type !== 'submenu') throw new Error('not a submenu');
    expect(submenu.value).toBe(MYTH.id);
    expect(open).toMatchObject({
      type: 'item',
      label: 'Open the series מיתוס או אמת',
      bidi: 'מיתוס או אמת',
      icon: Layers2,
    });
  });

  it('"Not in a series" takes the episode out, and its own series is not asked again', () => {
    const setJobSeries = vi.fn();
    const entries = seriesMenuEntries(makeEpisodeJob(), { ...on, setJobSeries });
    const submenu = entries[1];
    if (submenu?.type !== 'submenu') throw new Error('not a submenu');
    submenu.onValueChange(MYTH.id);
    expect(setJobSeries).not.toHaveBeenCalled();
    submenu.onValueChange(NOT_IN_A_SERIES_OPTION);
    expect(setJobSeries).toHaveBeenCalledWith(null);
  });

  it('"Open the series" hands the series to the page', () => {
    const openSeries = vi.fn();
    const entries = seriesMenuEntries(makeEpisodeJob(), { ...on, openSeries });
    const open = entries.find((entry) => entry.id === 'series-open');
    if (open?.type !== 'item') throw new Error('not an item');
    open.onSelect();
    expect(openSeries).toHaveBeenCalledWith(MYTH);
  });

  it.each(['editing', 'review', 'failed', 'cancelled'] as const)(
    'an episode that is %s has only "Open the series", after a line',
    (state) => {
      expect(ids(seriesMenuEntries(makeEpisodeJob({ state }), on))).toEqual([
        'series-separator',
        'series-open',
      ]);
    },
  );

  it('an episode whose series is not loaded yet has nothing to name', () => {
    expect(seriesMenuEntries(makeEpisodeJob(), { enabled: true, clientSeries: [] })).toEqual([]);
    expect(
      seriesMenuEntries(makeEpisodeJob({ state: 'ready' }), { enabled: true, clientSeries: [] }),
    ).toEqual([]);
  });

  it('a ready episode offers "Open the series" and "Use as the series format…"', () => {
    const job = makeEpisodeJob({ state: 'ready', episode: 6 });
    const entries = seriesMenuEntries(job, on);
    // A ready job's menu has the line of its stage group before these: no line of their own.
    expect(shown(entries)).toEqual([
      { id: 'series-open', label: 'Open the series מיתוס או אמת', disabled: false },
      { id: 'series-format', label: 'Use as the series format…', disabled: false },
    ]);
    expect(entries[1]).toMatchObject({ type: 'item', icon: Layers2 });
  });

  it('"Use as the series format…" asks the page for the dialog, with the series it is about', () => {
    const job = makeEpisodeJob({ state: 'ready' });
    const entries = seriesMenuEntries(job, on);
    const format = entries.find((entry) => entry.id === 'series-format');
    if (format?.type !== 'item') throw new Error('not an item');
    format.onSelect();
    expect(asFormatDialogStore.getState()).toMatchObject({
      phase: 'asking',
      target: { jobId: job.id, seriesId: MYTH.id, formatJobId: MYTH.formatJobId },
    });
  });

  it('the format job says so: a disabled "This episode is the format" with a check', () => {
    const entries = seriesMenuEntries(makeFormatJob(), on);
    expect(ids(entries)).toEqual(['series-open', 'series-is-format']);
    expect(entries[1]).toMatchObject({
      type: 'item',
      label: 'This episode is the format',
      icon: Check,
      disabled: true,
    });
  });
});

describe('seriesMenuEntries: a series’ own page', () => {
  const onPage: SeriesMenuContext = { ...on, onSeriesPage: true };

  it('has no "Open the series" and no Series submenu: the episode can be taken out instead', () => {
    const setJobSeries = vi.fn();
    const entries = seriesMenuEntries(makeEpisodeJob(), { ...onPage, setJobSeries });
    expect(shown(entries)).toEqual([
      { id: 'series-separator' },
      // Only an approved episode can be the format: the item is there and says no.
      { id: 'series-format', label: 'Use as the series format…', disabled: true },
      // The way out comes last, as on the board.
      { id: 'series-take-out', label: 'Take out of the series', disabled: false },
    ]);
    expect(entries[2]).toMatchObject({ icon: CircleMinus });
    const takeOut = entries[2];
    if (takeOut?.type !== 'item') throw new Error('not an item');
    takeOut.onSelect();
    expect(setJobSeries).toHaveBeenCalledWith(null);
  });

  it('an episode that has started cannot be taken out, and cannot be the format yet', () => {
    expect(shown(seriesMenuEntries(makeEpisodeJob({ state: 'review' }), onPage))).toEqual([
      { id: 'series-separator' },
      { id: 'series-format', label: 'Use as the series format…', disabled: true },
    ]);
  });

  it('a ready episode can be the format; the format job says it is', () => {
    expect(shown(seriesMenuEntries(makeEpisodeJob({ state: 'ready' }), onPage))).toEqual([
      { id: 'series-format', label: 'Use as the series format…', disabled: false },
    ]);
    expect(shown(seriesMenuEntries(makeFormatJob(), onPage))).toEqual([
      { id: 'series-is-format', label: 'This episode is the format', disabled: true },
    ]);
  });
});

describe('the disabled "Use as the series format…"', () => {
  it('says why, as its tooltip (board SeriesPage); the enabled one has no reason', () => {
    const onPage: SeriesMenuContext = { ...on, onSeriesPage: true };
    const notReady = seriesMenuEntries(makeEpisodeJob({ state: 'review' }), onPage).find(
      (entry) => entry.id === 'series-format',
    );
    expect(notReady).toMatchObject({ disabled: true, disabledReason: FORMAT_NOT_READY_REASON });
    expect(FORMAT_NOT_READY_REASON).toBe('Only an approved episode can be the format');
    const ready = seriesMenuEntries(makeEpisodeJob({ state: 'ready' }), onPage).find(
      (entry) => entry.id === 'series-format',
    );
    expect(ready).not.toHaveProperty('disabledReason');
  });
});

describe('rowMenuEntries with series on', () => {
  it('puts the series items after the stage entries and before the archive group', () => {
    const job = makeFormatJob({ delivery: null });
    const entries = rowMenuEntries(job, { ...idle, archive: () => {} }, null, on);
    const order = entries.map((entry) => entry.id);
    const look = order.indexOf('use-look');
    expect(look).toBeGreaterThan(-1);
    expect(order.slice(look + 1)).toEqual([
      'series-open',
      'series-is-format',
      'archive-separator',
      'archive',
    ]);
  });

  it('puts the series items of a queued episode after its actions, behind a line', () => {
    const order = rowMenuEntries(makeEpisodeJob(), idle, null, on).map((entry) => entry.id);
    expect(order.slice(-3)).toEqual(['series-separator', SERIES_SUBMENU_ID, 'series-open']);
  });

  it('gives every entry a key of its own, in every state', () => {
    for (const job of [
      ...JOB_STATES.map((state) => makeJob({ state })),
      ...JOB_STATES.map((state) => makeEpisodeJob({ state })),
      makeFormatJob(),
    ]) {
      const keys = rowMenuEntries(job, idle, null, on).map((entry) => entry.id);
      expect(new Set(keys).size, `${job.state} ${job.seriesId}`).toBe(keys.length);
    }
  });

  it('never ends the menu or doubles a line', () => {
    for (const job of [
      ...JOB_STATES.map((state) => makeJob({ state })),
      ...JOB_STATES.map((state) => makeEpisodeJob({ state })),
    ]) {
      const entries = rowMenuEntries(job, idle, null, on);
      expect(entries.at(-1)?.type, job.state).not.toBe('separator');
      entries.forEach((entry, index) => {
        if (entry.type === 'separator') expect(entries[index - 1]?.type).not.toBe('separator');
      });
    }
  });
});
