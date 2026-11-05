import { jobSchema, seriesSchema, seriesSummarySchema } from '@studio/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { clientIdFor, seriesIdFor } from '../inbox/scan.js';
import type { StudioDb } from './database.js';
import { JobNotFoundError, JobRepository } from './job-repository.js';
import { NoteRepository } from './note-repository.js';
import {
  type NewSeries,
  SeriesNameTakenError,
  SeriesRepository,
  toSeries,
} from './series-repository.js';
import { fakeClock, makeScan, memoryDb, rawRow, T0 } from './test-utils.js';

const opened: StudioDb[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
});

const CLIENT = 'עו״ד דוד לוי';
const CLIENT_ID = clientIdFor(CLIENT);

function setup() {
  const clock = fakeClock();
  const db = memoryDb();
  opened.push(db);
  const series = new SeriesRepository(db, { clock });
  const jobs = new JobRepository(db, { clock });
  const notes = new NoteRepository(db, { clock });
  return { clock, db, series, jobs, notes };
}

function newSeries(overrides: Partial<NewSeries> = {}): NewSeries {
  return {
    clientId: CLIENT_ID,
    client: CLIENT,
    name: 'מיתוס או אמת',
    formatJobId: 'job000000005',
    formatJob: 'מיתוס או אמת 5',
    ...overrides,
  };
}

const START_PASS = {
  kind: 'series',
  mode: 'start',
  seriesId: seriesIdFor(CLIENT_ID, 'מיתוס או אמת'),
  series: 'מיתוס או אמת',
  jobId: 'job000000005',
  job: 'מיתוס או אמת 5',
};

describe('SeriesRepository.create', () => {
  it('stores a learning series at version 0, with the id seriesIdFor gives', () => {
    const { series } = setup();

    const created = series.create(newSeries({ lastPass: START_PASS }));

    expect(created).toEqual({
      id: seriesIdFor(CLIENT_ID, 'מיתוס או אמת'),
      clientId: CLIENT_ID,
      client: CLIENT,
      name: 'מיתוס או אמת',
      state: 'learning',
      error: null,
      version: 0,
      formatJobId: 'job000000005',
      formatJob: 'מיתוס או אמת 5',
      createdAt: T0,
      updatedAt: T0,
      lastPass: START_PASS,
    });
    expect(series.get(created.id)).toEqual(created);
  });

  it('keeps the name trimmed and in NFC', () => {
    const { series } = setup();
    const created = series.create(newSeries({ name: '  Café Weekly ' }));
    expect(created.name).toBe('Café Weekly');
    expect(created.id).toBe(seriesIdFor(CLIENT_ID, 'Café Weekly'));
  });

  it('refuses a name the client has already, whatever its case, and writes nothing', () => {
    const { series } = setup();
    series.create(newSeries({ name: 'Kova Weekly' }));

    expect(() => series.create(newSeries({ name: 'kova weekly ' }))).toThrow(SeriesNameTakenError);
    expect(() => series.create(newSeries({ name: 'kova weekly ' }))).toThrow(
      'A series with this name already exists.',
    );
    expect(series.listByClient(CLIENT_ID)).toHaveLength(1);
    // Another client may have a series of that name.
    expect(
      series.create(newSeries({ clientId: 'c2', client: 'Acme', name: 'Kova Weekly' })),
    ).toBeTruthy();
  });

  it('finds a series by name the way names compare', () => {
    const { series } = setup();
    const created = series.create(newSeries({ name: 'Kova Weekly' }));
    expect(series.getByName(CLIENT_ID, ' KOVA weekly')).toEqual(created);
    expect(series.getByName('c2', 'Kova Weekly')).toBeNull();
    expect(series.get('nope')).toBeNull();
  });
});

describe('SeriesRepository.update and remove', () => {
  it('changes what it is given, moves updatedAt, and clears with null', () => {
    const { series, clock } = setup();
    const created = series.create(newSeries({ lastPass: START_PASS }));
    clock.tick(4_000);

    const failed = series.update(created.id, {
      state: 'failed',
      error: 'Series stopped: no file.',
    });
    expect(failed).toMatchObject({
      state: 'failed',
      error: 'Series stopped: no file.',
      version: 0,
      lastPass: START_PASS,
      updatedAt: '2026-10-20T10:00:04.000Z',
      createdAt: T0,
    });

    clock.tick(1_000);
    const ready = series.update(created.id, { state: 'ready', error: null, version: 1 });
    expect(ready).toMatchObject({ state: 'ready', error: null, version: 1 });
    expect(series.get(created.id)).toEqual(ready);
  });

  it('writes nothing when nothing changes, and answers null for an unknown series', () => {
    const { series, clock } = setup();
    const created = series.create(newSeries());
    clock.tick(4_000);
    expect(series.update(created.id, { state: 'learning' })).toEqual(created);
    expect(series.update('nope', { state: 'ready' })).toBeNull();
  });

  it('removes the row and says whether it was there', () => {
    const { series } = setup();
    const created = series.create(newSeries());
    expect(series.remove(created.id)).toBe(true);
    expect(series.remove(created.id)).toBe(false);
    expect(series.get(created.id)).toBeNull();
  });
});

describe('SeriesRepository lists', () => {
  it('lists a client’s series by name, and every series by client', () => {
    const { series } = setup();
    series.create(newSeries({ name: 'שאלות נפוצות' }));
    series.create(newSeries({ name: 'Kova Weekly' }));
    series.create(newSeries({ clientId: 'ffffffffffff', client: 'Acme', name: 'Ascend' }));

    expect(series.listByClient(CLIENT_ID).map((one) => one.name)).toEqual([
      'Kova Weekly',
      'שאלות נפוצות',
    ]);
    expect(series.list().map((one) => one.name)).toEqual(['Kova Weekly', 'שאלות נפוצות', 'Ascend']);
  });

  it('summarises them for the client page: episode count and the newest episode’s time', () => {
    const { series, jobs, clock } = setup();
    const myth = series.create(newSeries());
    const faq = series.create(newSeries({ name: 'שאלות נפוצות' }));
    const five = jobs.upsertFromScan(makeScan(CLIENT, 'מיתוס או אמת 5')).job;
    clock.tick(60_000);
    const six = jobs.upsertFromScan(makeScan(CLIENT, 'מיתוס או אמת 6')).job;
    jobs.upsertFromScan(makeScan(CLIENT, 'Something else'));
    jobs.setSeries(five.id, { seriesId: myth.id, episode: 5, pinned: false });
    jobs.setSeries(six.id, { seriesId: myth.id, episode: 6, pinned: false });

    const summaries = series.summaries(CLIENT_ID);

    expect(summaries).toEqual([
      {
        id: myth.id,
        name: 'מיתוס או אמת',
        state: 'learning',
        error: null,
        formatJobId: 'job000000005',
        formatJob: 'מיתוס או אמת 5',
        version: 0,
        updatedAt: T0,
        episodeCount: 2,
        lastEpisodeAt: six.addedAt,
      },
      expect.objectContaining({ id: faq.id, episodeCount: 0, lastEpisodeAt: null }),
    ]);
    for (const summary of summaries) expect(seriesSummarySchema.parse(summary)).toEqual(summary);
    expect(series.summaries('c-none')).toEqual([]);
  });
});

describe('toSeries', () => {
  it('shows the pass while learning, and none otherwise', () => {
    const { series } = setup();
    const created = series.create(newSeries({ lastPass: START_PASS }));

    const learning = toSeries(created);
    expect(learning).not.toHaveProperty('lastPass');
    expect(learning.pass).toEqual({
      kind: 'series',
      mode: 'start',
      fileCount: 0,
      jobId: 'job000000005',
      job: 'מיתוס או אמת 5',
    });
    expect(seriesSchema.parse(learning)).toEqual(learning);

    const failed = series.update(created.id, { state: 'failed', error: 'Series stopped.' });
    expect(failed && toSeries(failed).pass).toBeNull();
  });

  it('shows nothing for a pass it cannot read, a series-read pass from before C26 too', () => {
    const { series } = setup();
    const created = series.create(
      newSeries({
        lastPass: {
          kind: 'series-read',
          seriesId: 's',
          series: 'מיתוס או אמת',
          files: [{ name: 'Review notes – מיתוס או אמת 6 – round 1.md', size: 120 }],
        },
      }),
    );
    expect(toSeries(created).pass).toBeNull();
    const odd = series.update(created.id, { lastPass: { kind: 'learn' } });
    expect(odd && toSeries(odd).pass).toBeNull();
  });
});

describe('the waiting notes of a series (C26)', () => {
  const ROUND_1 = 'Review notes – מיתוס או אמת 6 – round 1.md';
  const ROUND_2 = 'Review notes – מיתוס או אמת 6 – round 2.md';
  const OTHER = 'Review notes – מיתוס או אמת 7 – round 1.md';

  it('are none for a new series, and for one that is not there', () => {
    const { series } = setup();
    const created = series.create(newSeries());

    expect(series.waitingNotes(created.id)).toEqual([]);
    expect(series.waitingNotes('nope')).toEqual([]);
    expect(series.addWaitingNotes('nope', [{ jobId: 'j6', name: ROUND_1, size: 1 }])).toBeNull();
    expect(series.takeWaitingNotes('nope', 'j6')).toEqual([]);
  });

  it('are added in order, a file sent again taking its new size, and leave the series as it was', () => {
    const { series, clock } = setup();
    const created = series.create(newSeries());
    clock.tick(5_000);

    series.addWaitingNotes(created.id, [{ jobId: 'j6', name: ROUND_1, size: 10 }]);
    series.addWaitingNotes(created.id, [{ jobId: 'j7', name: OTHER, size: 30 }]);
    const all = series.addWaitingNotes(created.id, [
      { jobId: 'j6', name: ROUND_2, size: 20 },
      { jobId: 'j6', name: ROUND_1, size: 11 },
    ]);

    const expected = [
      { jobId: 'j6', name: ROUND_1, size: 11 },
      { jobId: 'j7', name: OTHER, size: 30 },
      { jobId: 'j6', name: ROUND_2, size: 20 },
    ];
    expect(all).toEqual(expected);
    expect(series.waitingNotes(created.id)).toEqual(expected);
    // Nothing a browser sees changed.
    expect(series.get(created.id)).toEqual(created);
  });

  it('of one episode are taken out together, and the others keep waiting', () => {
    const { series, db } = setup();
    const created = series.create(newSeries());
    series.addWaitingNotes(created.id, [
      { jobId: 'j6', name: ROUND_1, size: 10 },
      { jobId: 'j7', name: OTHER, size: 30 },
      { jobId: 'j6', name: ROUND_2, size: 20 },
    ]);

    expect(series.takeWaitingNotes(created.id, 'j6')).toEqual([
      { jobId: 'j6', name: ROUND_1, size: 10 },
      { jobId: 'j6', name: ROUND_2, size: 20 },
    ]);
    expect(series.takeWaitingNotes(created.id, 'j6')).toEqual([]);
    expect(series.waitingNotes(created.id)).toEqual([{ jobId: 'j7', name: OTHER, size: 30 }]);
    expect(series.takeWaitingNotes(created.id, 'j7')).toHaveLength(1);
    const row = db.sqlite
      .prepare('SELECT waiting_notes FROM series WHERE id = ?')
      .get(created.id) as { waiting_notes: string | null };
    expect(row.waiting_notes).toBeNull();
  });

  it('survive an update of the series, and go with it when it is removed', () => {
    const { series } = setup();
    const created = series.create(newSeries());
    series.addWaitingNotes(created.id, [{ jobId: 'j6', name: ROUND_1, size: 10 }]);

    series.update(created.id, { state: 'ready', version: 1, lastPass: START_PASS });

    expect(series.waitingNotes(created.id)).toEqual([{ jobId: 'j6', name: ROUND_1, size: 10 }]);
    series.remove(created.id);
    expect(series.waitingNotes(created.id)).toEqual([]);
  });

  it('read as none when what is stored is not a list of notes', () => {
    const { series, db } = setup();
    const created = series.create(newSeries());
    db.sqlite
      .prepare('UPDATE series SET waiting_notes = ? WHERE id = ?')
      .run('{"not":"a list"}', created.id);

    expect(series.waitingNotes(created.id)).toEqual([]);
  });
});

describe('JobRepository.setSeries', () => {
  it('puts a job in a series with its episode and pin, and takes it out again', () => {
    const { jobs, clock } = setup();
    const job = jobs.upsertFromScan(makeScan(CLIENT, 'מיתוס או אמת 6')).job;
    clock.tick(5_000);

    const joined = jobs.setSeries(job.id, { seriesId: 's1', episode: 6, pinned: false });
    expect(joined).toEqual({ ...job, seriesId: 's1', episode: 6 });
    expect(jobSchema.parse(joined)).toEqual(joined);
    expect(jobs.getMeta(job.id)?.seriesPinned).toBe(false);

    const out = jobs.setSeries(job.id, { seriesId: null, episode: null, pinned: true });
    expect(out).toMatchObject({ seriesId: null, episode: null, updatedAt: job.updatedAt });
    expect(jobs.getMeta(job.id)?.seriesPinned).toBe(true);
  });

  it('keeps the series through state changes', () => {
    const { jobs } = setup();
    const job = jobs.upsertFromScan(makeScan(CLIENT, 'מיתוס או אמת 6')).job;
    jobs.setSeries(job.id, { seriesId: 's1', episode: 6, pinned: true });

    jobs.applyTransition(job.id, { type: 'SETTLED' });
    const editing = jobs.applyTransition(job.id, { type: 'START' });

    expect(editing).toMatchObject({ state: 'editing', seriesId: 's1', episode: 6 });
    expect(jobs.getMeta(job.id)?.seriesPinned).toBe(true);
  });

  it('refuses an unknown job and an episode that is not a whole number', () => {
    const { jobs } = setup();
    const job = jobs.upsertFromScan(makeScan(CLIENT, 'מיתוס או אמת 6')).job;
    expect(() => jobs.setSeries('nope', { seriesId: 's1', episode: 1, pinned: false })).toThrow(
      JobNotFoundError,
    );
    expect(() => jobs.setSeries(job.id, { seriesId: 's1', episode: 1.5, pinned: false })).toThrow(
      RangeError,
    );
    expect(() => jobs.setSeries(job.id, { seriesId: 's1', episode: -1, pinned: false })).toThrow(
      RangeError,
    );
    expect(jobs.get(job.id)?.seriesId).toBeNull();
  });
});

describe('NoteRepository and addToSeries', () => {
  it('starts every note off, and PATCH turns it on and off', () => {
    const { jobs, notes, db } = setup();
    const job = jobs.upsertFromScan(makeScan(CLIENT, 'מיתוס או אמת 6')).job;
    const note = notes.create({ id: 'n1', jobId: job.id, kind: 'text', atSec: 1, text: 'Slower' });
    expect(note.addToSeries).toBe(false);

    expect(notes.update('n1', { addToSeries: true })).toMatchObject({
      addToSeries: true,
      addToStyle: false,
    });
    expect(rawRow(db, 'review_notes')[0]).toMatchObject({ add_to_series: 1 });
    expect(notes.update('n1', { addToSeries: false })?.addToSeries).toBe(false);
  });
});
