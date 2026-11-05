import type { Job, JobState, SeriesState } from '@studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StudioDb } from '../db/database.js';
import { JobRepository } from '../db/job-repository.js';
import { SeriesRepository } from '../db/series-repository.js';
import { fakeClock, makeScan, memoryDb } from '../db/test-utils.js';
import { clientIdFor, seriesIdFor } from '../inbox/scan.js';
import { assignSeries, assignWaitingJobs, type SeriesAssignDeps } from './series-assign.js';

// CVP-177 (K1): the name rule — a folder named after a series plus a number joins it.

const opened: StudioDb[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
});

const CLIENT = 'עו״ד דוד לוי';
const CLIENT_ID = clientIdFor(CLIENT);
const MYTH = 'מיתוס או אמת';
const MYTH_ID = seriesIdFor(CLIENT_ID, MYTH);
const FAQ = 'שאלות נפוצות';
const FAQ_ID = seriesIdFor(CLIENT_ID, FAQ);

function setup(options: { enabled?: boolean } = {}) {
  const clock = fakeClock();
  const db = memoryDb();
  opened.push(db);
  const jobs = new JobRepository(db, { clock });
  const seriesRepo = new SeriesRepository(db, { clock });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const deps: SeriesAssignDeps = {
    enabled: options.enabled ?? true,
    jobs,
    series: seriesRepo,
    logger,
  };

  /** A series of `CLIENT` (default: "מיתוס או אמת", ready), as Start a series would have made it. */
  const addSeries = (name = MYTH, state: SeriesState = 'ready', client = CLIENT) =>
    seriesRepo.create({
      clientId: clientIdFor(client),
      client,
      name,
      formatJobId: 'job000000005',
      formatJob: `${name} 5`,
      state,
    });
  /** A job folder the scanner found for the first time: `arriving`, in no series. */
  const scan = (name: string, client = CLIENT) => jobs.upsertFromScan(makeScan(client, name)).job;
  const queued = (name: string, client = CLIENT) => {
    const job = scan(name, client);
    return jobs.applyTransition(job.id, { type: 'SETTLED' });
  };
  return { clock, jobs, seriesRepo, deps, logger, addSeries, scan, queued };
}

describe('assignSeries', () => {
  it('puts a new folder named after a series plus a number in it, with that episode', () => {
    const { deps, jobs, addSeries, scan } = setup();
    addSeries();
    const job = scan(`${MYTH} 6`);

    const joined = assignSeries(deps, job);

    expect(joined).toEqual({ ...job, seriesId: MYTH_ID, episode: 6 });
    expect(jobs.get(job.id)).toEqual(joined);
    expect(jobs.getMeta(job.id)?.seriesPinned).toBe(false);
  });

  it('reads "#6", extra spaces, other letter case and a decomposed spelling the same way', () => {
    const { deps, addSeries, scan } = setup();
    addSeries();
    addSeries('Weekly Show');
    addSeries('Caf\u00e9 Weekly');

    expect(assignSeries(deps, scan(`${MYTH} #7`))).toMatchObject({ seriesId: MYTH_ID, episode: 7 });
    expect(assignSeries(deps, scan(`${MYTH}   8  `))).toMatchObject({ episode: 8 });
    expect(assignSeries(deps, scan('weekly SHOW 3'))).toMatchObject({
      seriesId: seriesIdFor(CLIENT_ID, 'Weekly Show'),
      episode: 3,
    });
    expect(assignSeries(deps, scan('Cafe\u0301 Weekly 2'))).toMatchObject({
      seriesId: seriesIdFor(CLIENT_ID, 'Caf\u00e9 Weekly'),
      episode: 2,
    });
  });

  it('does not move the job in the Jobs list', () => {
    const { deps, clock, addSeries, scan } = setup();
    addSeries();
    const job = scan(`${MYTH} 6`);
    clock.tick(60_000);

    expect(assignSeries(deps, job).updatedAt).toBe(job.updatedAt);
  });

  it('gives nothing to a name without a number, or with another name before it', () => {
    const { deps, jobs, addSeries, scan } = setup();
    addSeries();

    for (const name of [`${MYTH} – ירושה`, MYTH, `${MYTH} – ירושה 3`, `${FAQ} 3`, 'מיתוס 6']) {
      const job = scan(name);
      expect(assignSeries(deps, job)).toBe(job);
      expect(jobs.get(job.id)).toMatchObject({ seriesId: null, episode: null });
    }
  });

  it('joins a series that is still learning, but not one that failed', () => {
    const { deps, addSeries, scan } = setup();
    addSeries(MYTH, 'learning');
    addSeries(FAQ, 'failed');

    expect(assignSeries(deps, scan(`${MYTH} 6`))).toMatchObject({ seriesId: MYTH_ID });
    const faq = scan(`${FAQ} 2`);
    expect(assignSeries(deps, faq)).toBe(faq);
  });

  it("does not join another client's series", () => {
    const { deps, jobs, addSeries, scan } = setup();
    addSeries(MYTH, 'ready', 'Acme');
    const job = scan(`${MYTH} 6`);

    expect(assignSeries(deps, job)).toBe(job);
    expect(jobs.get(job.id)?.seriesId).toBeNull();
  });

  it.each<JobState>(['arriving', 'queued', 'held'])('joins a job that is %s', (state) => {
    const { deps, jobs, addSeries, scan } = setup();
    addSeries();
    const job = scan(`${MYTH} 6`);
    if (state !== 'arriving') {
      jobs.applyTransition(job.id, { type: 'SETTLED' });
      if (state === 'held') jobs.applyTransition(job.id, { type: 'HOLD' });
    }
    const waiting = jobs.get(job.id) as Job;
    expect(waiting.state).toBe(state);

    expect(assignSeries(deps, waiting)).toMatchObject({ seriesId: MYTH_ID, episode: 6 });
  });

  it('leaves a job that is editing alone, even when its name points to a series', () => {
    const { deps, jobs, addSeries, queued } = setup();
    addSeries();
    const job = queued(`${MYTH} 6`);
    const editing = jobs.applyTransition(job.id, { type: 'START' });
    expect(editing.state).toBe('editing');

    expect(assignSeries(deps, editing)).toBe(editing);
    expect(jobs.get(job.id)).toMatchObject({ seriesId: null, episode: null });
  });

  it.each<JobState>(['editing', 'review', 'ready', 'failed', 'cancelled'])(
    'leaves a job that is %s alone, in a series or out of one',
    (state) => {
      const { deps, jobs, addSeries, scan } = setup();
      addSeries();
      const out = { ...scan(`${MYTH} 6`), state };
      const inside = { ...scan(`${MYTH} 7`), state, seriesId: FAQ_ID, episode: 1 };
      const setSeries = vi.spyOn(jobs, 'setSeries');

      expect(assignSeries(deps, out)).toBe(out);
      expect(assignSeries(deps, inside)).toBe(inside);
      expect(setSeries).not.toHaveBeenCalled();
    },
  );

  it('leaves a pinned job alone, in a series or out of one', () => {
    const { deps, jobs, addSeries, scan } = setup();
    addSeries();
    addSeries(FAQ);
    const picked = scan(`${MYTH} 6`);
    jobs.setSeries(picked.id, { seriesId: FAQ_ID, episode: null, pinned: true });
    const taken = scan(`${MYTH} 7`);
    jobs.setSeries(taken.id, { seriesId: null, episode: null, pinned: true });

    const pickedNow = jobs.get(picked.id) as Job;
    const takenNow = jobs.get(taken.id) as Job;
    expect(assignSeries(deps, pickedNow)).toBe(pickedNow);
    expect(assignSeries(deps, takenNow)).toBe(takenNow);
    expect(jobs.get(picked.id)).toMatchObject({ seriesId: FAQ_ID, episode: null });
    expect(jobs.get(taken.id)).toMatchObject({ seriesId: null, episode: null });
    expect(jobs.getMeta(picked.id)?.seriesPinned).toBe(true);
  });

  it('takes the job out of its series when its name no longer points to it', () => {
    const { deps, jobs, addSeries, scan } = setup();
    addSeries();
    const job = scan(`${MYTH} 6`);
    assignSeries(deps, job);
    const renamed = { ...(jobs.get(job.id) as Job), name: `${MYTH} – ירושה` };

    const out = assignSeries(deps, renamed);

    expect(out).toMatchObject({ seriesId: null, episode: null });
    expect(jobs.get(job.id)).toMatchObject({ seriesId: null, episode: null });
    expect(jobs.getMeta(job.id)?.seriesPinned).toBe(false);
  });

  it('changes the episode when the number in the name changed', () => {
    const { deps, jobs, addSeries, scan } = setup();
    addSeries();
    const job = scan(`${MYTH} 6`);
    assignSeries(deps, job);
    const renamed = { ...(jobs.get(job.id) as Job), name: `${MYTH} 7` };

    expect(assignSeries(deps, renamed)).toMatchObject({ seriesId: MYTH_ID, episode: 7 });
  });

  it('moves the job to the series its new name points to', () => {
    const { deps, jobs, addSeries, scan } = setup();
    addSeries();
    addSeries(FAQ);
    const job = scan(`${MYTH} 6`);
    assignSeries(deps, job);
    const renamed = { ...(jobs.get(job.id) as Job), name: `${FAQ} 2` };

    expect(assignSeries(deps, renamed)).toMatchObject({ seriesId: FAQ_ID, episode: 2 });
  });

  it('keeps a job in a failed series that its name still points to', () => {
    const { deps, jobs, addSeries, scan } = setup();
    addSeries(MYTH, 'failed');
    const job = scan(`${MYTH} 6`);
    jobs.setSeries(job.id, { seriesId: MYTH_ID, episode: 6, pinned: false });
    const inSeries = jobs.get(job.id) as Job;
    const setSeries = vi.spyOn(jobs, 'setSeries');

    expect(assignSeries(deps, inSeries)).toBe(inSeries);
    expect(setSeries).not.toHaveBeenCalled();
  });

  it('takes a job out of a series that is gone', () => {
    const { deps, jobs, seriesRepo, addSeries, scan } = setup();
    addSeries();
    const job = scan(`${MYTH} 6`);
    assignSeries(deps, job);
    seriesRepo.remove(MYTH_ID);

    expect(assignSeries(deps, jobs.get(job.id) as Job)).toMatchObject({
      seriesId: null,
      episode: null,
    });
  });

  it('answers the same job without a write when it is already where its name says', () => {
    const { deps, jobs, addSeries, scan } = setup();
    addSeries();
    const first = assignSeries(deps, scan(`${MYTH} 6`));
    const setSeries = vi.spyOn(jobs, 'setSeries');

    expect(assignSeries(deps, first)).toBe(first);
    expect(setSeries).not.toHaveBeenCalled();
  });

  it('does nothing while series are off', () => {
    const { deps, jobs, addSeries, scan } = setup({ enabled: false });
    addSeries();
    const job = scan(`${MYTH} 6`);
    const inSeries = { ...job, seriesId: FAQ_ID, episode: 2 };
    const getMeta = vi.spyOn(jobs, 'getMeta');
    const setSeries = vi.spyOn(jobs, 'setSeries');
    const listByClient = vi.spyOn(deps.series, 'listByClient');

    expect(assignSeries(deps, job)).toBe(job);
    expect(assignSeries(deps, inSeries)).toBe(inSeries);
    expect(jobs.get(job.id)).toMatchObject({ seriesId: null, episode: null });
    expect(getMeta).not.toHaveBeenCalled();
    expect(setSeries).not.toHaveBeenCalled();
    expect(listByClient).not.toHaveBeenCalled();
  });

  it('logs and answers the job as it was when reading the series fails', () => {
    const { deps, logger, scan } = setup();
    const job = scan(`${MYTH} 6`);
    const err = new Error('database is locked');
    deps.series = {
      listByClient: () => {
        throw err;
      },
    };

    expect(assignSeries(deps, job)).toBe(job);
    expect(logger.error).toHaveBeenCalledWith(
      { jobId: job.id, err },
      'could not join the job to a series by its name',
    );
  });

  it('logs and answers the job as it was when writing the series fails', () => {
    const { deps, jobs, logger, addSeries, scan } = setup();
    addSeries();
    const job = scan(`${MYTH} 6`);
    const err = new Error('disk I/O error');
    vi.spyOn(jobs, 'setSeries').mockImplementation(() => {
      throw err;
    });

    expect(assignSeries(deps, job)).toBe(job);
    expect(logger.error).toHaveBeenCalledWith(
      { jobId: job.id, err },
      'could not join the job to a series by its name',
    );
  });

  it('answers a job that is no longer in the database as it was, and does not throw without a logger', () => {
    const { deps, jobs, addSeries, scan } = setup();
    addSeries();
    const job = scan(`${MYTH} 6`);
    jobs.remove(job.id);

    expect(assignSeries({ ...deps, logger: undefined }, job)).toBe(job);
  });
});

describe('assignWaitingJobs', () => {
  it("picks up the client's queued, held and arriving jobs that match, and answers them", () => {
    const { deps, jobs, addSeries, scan, queued } = setup();
    addSeries();
    const arriving = scan(`${MYTH} 4`);
    const waiting = queued(`${MYTH} 5`);
    const held = queued(`${MYTH} 6`);
    jobs.applyTransition(held.id, { type: 'HOLD' });

    const changed = assignWaitingJobs(deps, CLIENT_ID);

    expect(changed.map((job) => [job.id, job.seriesId, job.episode]).sort()).toEqual(
      [
        [arriving.id, MYTH_ID, 4],
        [waiting.id, MYTH_ID, 5],
        [held.id, MYTH_ID, 6],
      ].sort(),
    );
    expect(changed.map((job) => job.state).sort()).toEqual(['arriving', 'held', 'queued']);
    for (const job of changed) expect(jobs.get(job.id)).toEqual(job);
  });

  it('leaves the ones that do not match, are pinned, have started or belong to another client', () => {
    const { deps, jobs, addSeries, scan, queued } = setup();
    addSeries();
    const matching = queued(`${MYTH} 6`);
    const unnamed = queued(`${MYTH} – ירושה`);
    const pinned = queued(`${MYTH} 7`);
    jobs.setSeries(pinned.id, { seriesId: null, episode: null, pinned: true });
    const editing = jobs.applyTransition(queued(`${MYTH} 8`).id, { type: 'START' });
    const other = scan(`${MYTH} 9`, 'Acme');

    const changed = assignWaitingJobs(deps, CLIENT_ID);

    expect(changed.map((job) => job.id)).toEqual([matching.id]);
    for (const job of [unnamed, pinned, editing, other]) {
      expect(jobs.get(job.id)).toMatchObject({ seriesId: null, episode: null });
    }
  });

  it('answers only the jobs that changed, so a second run answers none', () => {
    const { deps, addSeries, queued } = setup();
    addSeries();
    queued(`${MYTH} 5`);

    expect(assignWaitingJobs(deps, CLIENT_ID)).toHaveLength(1);
    expect(assignWaitingJobs(deps, CLIENT_ID)).toEqual([]);
  });

  it('lets jobs join a series that was installed after they queued', () => {
    const { deps, seriesRepo, addSeries, queued } = setup();
    const job = queued(`${MYTH} 5`);
    expect(assignWaitingJobs(deps, CLIENT_ID)).toEqual([]);
    addSeries(MYTH, 'learning');
    seriesRepo.update(MYTH_ID, { state: 'ready', version: 1 });

    expect(assignWaitingJobs(deps, CLIENT_ID)).toMatchObject([
      { id: job.id, seriesId: MYTH_ID, episode: 5 },
    ]);
  });

  it('moves a job out of a series its name no longer points to, into the one it does', () => {
    const { deps, jobs, addSeries, queued } = setup();
    addSeries();
    const job = queued(`${MYTH} 5`);
    jobs.setSeries(job.id, { seriesId: FAQ_ID, episode: 5, pinned: false });

    expect(assignWaitingJobs(deps, CLIENT_ID)).toMatchObject([
      { id: job.id, seriesId: MYTH_ID, episode: 5 },
    ]);
  });

  it('does nothing while series are off', () => {
    const { deps, jobs, addSeries, queued } = setup({ enabled: false });
    addSeries();
    const job = queued(`${MYTH} 5`);
    const getAll = vi.spyOn(jobs, 'getAll');

    expect(assignWaitingJobs(deps, CLIENT_ID)).toEqual([]);
    expect(getAll).not.toHaveBeenCalled();
    expect(jobs.get(job.id)).toMatchObject({ seriesId: null, episode: null });
  });

  it('does not read the series when no job waits', () => {
    const { deps, addSeries } = setup();
    addSeries();
    const listByClient = vi.spyOn(deps.series, 'listByClient');

    expect(assignWaitingJobs(deps, CLIENT_ID)).toEqual([]);
    expect(listByClient).not.toHaveBeenCalled();
  });

  it('logs and carries on with the other jobs when one cannot be written', () => {
    const { deps, jobs, logger, addSeries, queued } = setup();
    addSeries();
    const first = queued(`${MYTH} 5`);
    const second = queued(`${MYTH} 6`);
    const err = new Error('disk I/O error');
    const write = jobs.setSeries.bind(jobs);
    vi.spyOn(jobs, 'setSeries').mockImplementation((id, change) => {
      if (id === first.id) throw err;
      return write(id, change);
    });

    const changed = assignWaitingJobs(deps, CLIENT_ID);

    expect(changed.map((job) => job.id)).toEqual([second.id]);
    expect(logger.error).toHaveBeenCalledWith(
      { jobId: first.id, err },
      'could not join the job to a series by its name',
    );
    expect(jobs.get(first.id)?.seriesId).toBeNull();
  });

  it('logs and answers none when the jobs or the series cannot be read', () => {
    const { deps, jobs, logger, queued } = setup();
    queued(`${MYTH} 5`);
    const err = new Error('database is locked');
    deps.series = {
      listByClient: () => {
        throw err;
      },
    };

    expect(assignWaitingJobs(deps, CLIENT_ID)).toEqual([]);
    vi.spyOn(jobs, 'getAll').mockImplementation(() => {
      throw err;
    });
    expect(assignWaitingJobs({ ...deps, logger: undefined }, CLIENT_ID)).toEqual([]);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      { clientId: CLIENT_ID, err },
      'could not let the waiting jobs join a series',
    );
  });
});
