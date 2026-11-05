import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  type ClientSeriesResponse,
  clientSeriesResponseSchema,
  SERIES_MESSAGES,
  type SeriesActionResponse,
  type SeriesResponse,
  type SetJobSeriesRequest,
  seriesActionResponseSchema,
  seriesFormatRequestSchema,
  seriesNotFoundMessage,
  seriesResponseSchema,
  setJobSeriesRequestSchema,
  setJobSeriesResponseSchema,
  startSeriesRequestSchema,
  undoSeriesResponseSchema,
} from './api.ts';
import { jobSchema } from './job.ts';
import { reviewNoteSchema } from './review-note.ts';
import {
  canChangeSeries,
  episodeFrom,
  matchSeries,
  normalizeSeriesName,
  SERIES_NAME_MAX_LENGTH,
  SERIES_STATES,
  SERIES_UNDO_MS,
  type Series,
  type SeriesSummary,
  seriesNameFrom,
  seriesNameKey,
  seriesNameProblem,
  seriesSchema,
  seriesStateSchema,
  seriesSummarySchema,
} from './series.ts';
import { JOB_STATES } from './status.ts';
import {
  episodeJob,
  formatJob,
  jobsByState,
  makeJob,
  makeReviewNote,
  makeSeries,
  makeSeriesSummary,
  SERIES_NAME,
  seriesByState,
} from './test-fixtures.ts';

describe('SeriesState', () => {
  it('lists the three states in lifecycle order', () => {
    expect(SERIES_STATES).toEqual(['learning', 'ready', 'failed']);
  });

  it.each(['', 'none', 'analysing', 'Ready', null])('rejects %j', (value) => {
    expect(seriesStateSchema.safeParse(value).success).toBe(false);
  });
});

describe('Series', () => {
  it.each(Object.values(seriesByState))('parses a $state series unchanged', (series) => {
    expect(seriesSchema.parse(series)).toEqual(series);
  });

  it('survives a JSON round trip, Hebrew names included', () => {
    const series = makeSeries();
    expect(seriesSchema.parse(JSON.parse(JSON.stringify(series)))).toEqual(series);
    expect(series.name).toBe('מיתוס או אמת');
  });

  it('carries the pass of a learning series: a series pass names its job, a read pass its files', () => {
    expect(seriesByState.learning.pass).toEqual({
      kind: 'series',
      mode: 'start',
      fileCount: 0,
      jobId: formatJob.id,
      job: formatJob.name,
    });
    const reading = makeSeries({
      state: 'learning',
      pass: { kind: 'series-read', mode: null, fileCount: 1, jobId: null, job: null },
    });
    expect(seriesSchema.parse(reading)).toEqual(reading);
  });

  it.each([
    ['no format job', { formatJobId: '' }],
    ['a negative version', { version: -1 }],
    ['an empty error', { error: '' }],
    ['a pass of an unknown kind', { pass: { kind: 'learn', mode: null, fileCount: 0 } }],
    ['no createdAt', { createdAt: undefined }],
  ])('rejects %s', (_label, change) => {
    expect(seriesSchema.safeParse({ ...makeSeries(), ...change }).success).toBe(false);
  });

  it('a summary has exactly the fields the client page lists', () => {
    const summary = makeSeriesSummary();
    expect(seriesSummarySchema.parse(summary)).toEqual(summary);
    expect(Object.keys(summary).sort()).toEqual(
      [
        'episodeCount',
        'error',
        'formatJob',
        'formatJobId',
        'id',
        'lastEpisodeAt',
        'name',
        'state',
        'updatedAt',
        'version',
      ].sort(),
    );
    expect(
      seriesSummarySchema.parse(makeSeriesSummary({ episodeCount: 0, lastEpisodeAt: null })),
    ).toMatchObject({ episodeCount: 0, lastEpisodeAt: null });
  });

  it('infers its shapes', () => {
    expectTypeOf<Series['state']>().toEqualTypeOf<'learning' | 'ready' | 'failed'>();
    expectTypeOf<SeriesSummary['episodeCount']>().toEqualTypeOf<number>();
  });
});

describe('Job and ReviewNote carry the series fields', () => {
  it('every job fixture parses, and a new job is in no series', () => {
    for (const job of [...Object.values(jobsByState), formatJob, episodeJob]) {
      expect(jobSchema.parse(job)).toEqual(job);
    }
    expect(makeJob()).toMatchObject({ seriesId: null, episode: null });
  });

  it('an episode names its series and number; the format job is one too', () => {
    expect(episodeJob).toMatchObject({ seriesId: makeSeries().id, episode: 6 });
    expect(formatJob).toMatchObject({ seriesId: makeSeries().id, episode: 5, state: 'ready' });
  });

  it('both fields are required, and an episode is a whole number', () => {
    const { seriesId: _seriesId, ...withoutSeries } = makeJob();
    expect(jobSchema.safeParse(withoutSeries).success).toBe(false);
    expect(jobSchema.safeParse(makeJob({ episode: 1.5 })).success).toBe(false);
    expect(jobSchema.safeParse(makeJob({ seriesId: '' })).success).toBe(false);
  });

  it('a review note says whether it goes into the series', () => {
    expect(reviewNoteSchema.parse(makeReviewNote({ addToSeries: true })).addToSeries).toBe(true);
    const { addToSeries: _addToSeries, ...without } = makeReviewNote();
    expect(reviewNoteSchema.safeParse(without).success).toBe(false);
  });
});

describe('seriesNameFrom and episodeFrom', () => {
  it.each([
    ['מיתוס או אמת 5', 'מיתוס או אמת', 5],
    ['מיתוס או אמת #6', 'מיתוס או אמת', 6],
    ['מיתוס או אמת#7', 'מיתוס או אמת', 7],
    ['שאלות נפוצות 12 ', 'שאלות נפוצות', 12],
    ['Show # 3', 'Show', 3],
    ['Show 007', 'Show', 7],
    ['Season 2 Episode 4', 'Season 2 Episode', 4],
  ])('%j is %j, episode %d', (jobName, name, episode) => {
    expect(seriesNameFrom(jobName)).toBe(name);
    expect(episodeFrom(jobName)).toBe(episode);
  });

  it.each(['Spring menu', 'מיתוס או אמת', 'Show #', '2026', '#4', ''])(
    'a name with no number (or only one) comes back unchanged: %j',
    (jobName) => {
      expect(seriesNameFrom(jobName)).toBe(jobName);
      expect(episodeFrom(jobName)).toBeNull();
    },
  );
});

describe('matchSeries', () => {
  const names = [SERIES_NAME, 'שאלות נפוצות', 'Kova Weekly'];

  it('joins a folder named after a series plus a number, with its episode', () => {
    expect(matchSeries('מיתוס או אמת 6', names)).toEqual({ name: SERIES_NAME, episode: 6 });
    expect(matchSeries('מיתוס או אמת #6', names)).toEqual({ name: SERIES_NAME, episode: 6 });
    expect(matchSeries('שאלות נפוצות 2', names)).toEqual({ name: 'שאלות נפוצות', episode: 2 });
  });

  it('compares trimmed, in NFC and ignoring case, and answers the name as given', () => {
    expect(matchSeries('kova weekly 3', names)).toEqual({ name: 'Kova Weekly', episode: 3 });
    expect(matchSeries(`${SERIES_NAME.normalize('NFD')} 7`, names)).toEqual({
      name: SERIES_NAME,
      episode: 7,
    });
    expect(matchSeries('Café 1', ['Café'])).toEqual({ name: 'Café', episode: 1 });
  });

  it('never matches a name without a number, or another show', () => {
    expect(matchSeries(SERIES_NAME, names)).toBeNull();
    expect(matchSeries('מיתוס 6', names)).toBeNull();
    expect(matchSeries('מיתוס או אמת חדש 6', names)).toBeNull();
    expect(matchSeries('מיתוס או אמת 6', [])).toBeNull();
  });

  it('takes the longest of two names that both match', () => {
    expect(matchSeries('show 4', ['Show', 'show '])).toEqual({ name: 'show ', episode: 4 });
    expect(matchSeries('show 4', ['show ', 'Show'])).toEqual({ name: 'show ', episode: 4 });
  });

  it('keys names the same way for the database', () => {
    expect(seriesNameKey('  Kova Weekly ')).toBe('kova weekly');
    expect(seriesNameKey('Café')).toBe(seriesNameKey('Café'));
  });
});

describe('seriesNameProblem', () => {
  it.each([SERIES_NAME, '  Kova Weekly  ', 'Q&A', 'א'.repeat(SERIES_NAME_MAX_LENGTH)])(
    'accepts %j',
    (name) => {
      expect(seriesNameProblem(name)).toBeNull();
    },
  );

  it.each([
    ['', 'Give the series a name.'],
    ['   ', 'Give the series a name.'],
    ['א'.repeat(SERIES_NAME_MAX_LENGTH + 1), 'A series name can have at most 80 characters.'],
    ['A/B', 'A series name can’t contain / or :.'],
    ['A:B', 'A series name can’t contain / or :.'],
    ['A\u0007B', 'A series name can’t contain control characters.'],
    ['.hidden', 'A series name can’t start with . or _.'],
    ['_Style', 'A series name can’t start with . or _.'],
  ])('refuses %j: %s', (name, problem) => {
    expect(seriesNameProblem(name)).toBe(problem);
  });

  it('keeps names trimmed and in NFC', () => {
    expect(normalizeSeriesName('  Café ')).toBe('Café');
  });
});

describe('canChangeSeries', () => {
  it.each(JOB_STATES)('%s', (state) => {
    expect(canChangeSeries({ state })).toBe(['arriving', 'queued', 'held'].includes(state));
  });
});

describe('the series routes', () => {
  it('GET /api/clients/:clientId/series answers { series }', () => {
    const body = { series: [makeSeriesSummary()] };
    expect(clientSeriesResponseSchema.parse(body)).toEqual(body);
    expect(clientSeriesResponseSchema.parse({ series: [] })).toEqual({ series: [] });
    expect(clientSeriesResponseSchema.safeParse([makeSeriesSummary()]).success).toBe(false);
  });

  it('GET /api/series/:seriesId answers { series, markdown }, markdown null while there is none', () => {
    const body = { series: makeSeries(), markdown: '# Series: מיתוס או אמת\n' };
    expect(seriesResponseSchema.parse(body)).toEqual(body);
    const learning = { series: seriesByState.learning, markdown: null };
    expect(seriesResponseSchema.parse(learning)).toEqual(learning);
  });

  it('the actions answer { series }, and Undo { ok: true }', () => {
    const body = { series: seriesByState.learning };
    expect(seriesActionResponseSchema.parse(body)).toEqual(body);
    expect(undoSeriesResponseSchema.parse({ ok: true })).toEqual({ ok: true });
    expect(undoSeriesResponseSchema.safeParse({ ok: false }).success).toBe(false);
    expect(setJobSeriesResponseSchema.parse(episodeJob)).toEqual(episodeJob);
  });

  it('takes { name }, { jobId } and { seriesId } bodies; the name is judged by the server', () => {
    expect(startSeriesRequestSchema.parse({ name: '' })).toEqual({ name: '' });
    expect(startSeriesRequestSchema.safeParse({}).success).toBe(false);
    expect(seriesFormatRequestSchema.parse({ jobId: 'j1' })).toEqual({ jobId: 'j1' });
    expect(seriesFormatRequestSchema.safeParse({ jobId: '' }).success).toBe(false);
    expect(setJobSeriesRequestSchema.parse({ seriesId: null })).toEqual({ seriesId: null });
    expect(setJobSeriesRequestSchema.parse({ seriesId: 's1' })).toEqual({ seriesId: 's1' });
    expect(setJobSeriesRequestSchema.safeParse({ seriesId: '' }).success).toBe(false);
    expect(setJobSeriesRequestSchema.safeParse({}).success).toBe(false);
  });

  it('says the refusals in the words of the plan', () => {
    expect(SERIES_MESSAGES.off).toBe('Series are off.');
    expect(SERIES_MESSAGES.nameTaken).toBe('A series with this name already exists.');
    expect(SERIES_MESSAGES.notFinished).toBe('Only a finished job can start a series.');
    expect(SERIES_MESSAGES.styleBusy).toBe(
      'The style is being analysed. Try again when it’s done.',
    );
    expect(seriesNotFoundMessage('622212180eef')).toBe('Series 622212180eef not found');
    expect(SERIES_UNDO_MS).toBe(10_000);
  });

  it('infers its shapes', () => {
    expectTypeOf<ClientSeriesResponse>().toEqualTypeOf<{ series: SeriesSummary[] }>();
    expectTypeOf<SeriesResponse>().toEqualTypeOf<{ series: Series; markdown: string | null }>();
    expectTypeOf<SeriesActionResponse>().toEqualTypeOf<{ series: Series }>();
    expectTypeOf<SetJobSeriesRequest>().toEqualTypeOf<{ seriesId: string | null }>();
  });
});
