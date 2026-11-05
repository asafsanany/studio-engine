import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Job, type JobOutput, SETTLE_MS } from '@studio/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JobRepository } from '../db/index.js';
import { type FakeClock, fakeClock, makeScan, memoryDb, SAMPLE_PREVIEW } from '../db/test-utils.js';
import { clientIdFor } from '../inbox/scan.js';
import {
  backfillStyles,
  createLearnOnReady,
  createLearnWait,
  learnPassFor,
} from './style-learn.js';
import type { StylePass } from './style-pass.js';

// When a Learn pass is queued: after a job is ready, and on the first start. The style worker is
// a stand-in that records what it is asked; the jobs are the real repository, in memory.

const OUTPUT: JobOutput = {
  fileName: 'x.mp4',
  durationSec: 30,
  width: 1080,
  height: 1920,
  sizeBytes: 1,
};

let inboxPath: string;
let clock: FakeClock;
let jobs: JobRepository;

beforeEach(() => {
  inboxPath = mkdtempSync(join(tmpdir(), 'studio-style-learn-'));
  clock = fakeClock();
  jobs = new JobRepository(memoryDb(), { clock });
});

afterEach(() => {
  rmSync(inboxPath, { recursive: true, force: true });
});

function writeStyle(client: string): void {
  mkdirSync(join(inboxPath, client, '_Style'), { recursive: true });
  writeFileSync(join(inboxPath, client, '_Style', 'style.md'), `# Style: ${client}\n`);
}

/** A job taken through the queue to `end` (ready by default), one clock tick apart from the last. */
function job(
  client: string,
  name: string,
  end: 'ready' | 'failed' | 'queued' | 'review' = 'ready',
): Job {
  const { job: scanned } = jobs.upsertFromScan(makeScan(client, name));
  clock.tick(SETTLE_MS);
  jobs.applyTransition(scanned.id, { type: 'SETTLED' });
  if (end === 'queued') return jobs.get(scanned.id) as Job;
  jobs.applyTransition(scanned.id, { type: 'START' });
  clock.tick(60_000);
  if (end === 'review') {
    return jobs.applyTransition(scanned.id, { type: 'PREVIEW_READY', preview: SAMPLE_PREVIEW });
  }
  return end === 'ready'
    ? jobs.applyTransition(scanned.id, { type: 'SUCCEED', output: OUTPUT })
    : jobs.applyTransition(scanned.id, { type: 'FAIL', step: 3, error: 'boom' });
}

/** A style worker that records the passes it is asked to queue. */
function recordingWorker() {
  const queued: { client: string; pass: StylePass }[] = [];
  return {
    queued,
    enqueue: async (client: string, pass: StylePass) => {
      queued.push({ client, pass });
      return {} as never;
    },
  };
}

describe('learnPassFor', () => {
  it('is a Learn pass from the job, by its id and folder name', () => {
    expect(learnPassFor({ id: 'a1b2c3d4e5f6', name: 'Spring menu' }, 'replace')).toEqual({
      kind: 'learn',
      mode: 'replace',
      jobId: 'a1b2c3d4e5f6',
      job: 'Spring menu',
    });
  });
});

describe('after a job is ready', () => {
  it('queues a first Learn from the job when its client has no style.md, and does not wait for it', async () => {
    const worker = recordingWorker();
    const ready = job('Kova Coffee', 'Menu');

    await createLearnOnReady({ inboxPath, worker })(ready);

    expect(worker.queued).toEqual([{ client: 'Kova Coffee', pass: learnPassFor(ready, 'create') }]);
  });

  it('queues a merge Learn for every later finished job: its look goes into the style there is', async () => {
    const worker = recordingWorker();
    const onReady = createLearnOnReady({ inboxPath, worker });
    const first = job('Kova Coffee', 'Autumn');
    await onReady(first);
    // The first job's Learn wrote the style.
    writeStyle('Kova Coffee');
    const second = job('Kova Coffee', 'Winter');
    const third = job('Kova Coffee', 'Spring');

    await onReady(second);
    await onReady(third);

    expect(worker.queued).toEqual([
      { client: 'Kova Coffee', pass: learnPassFor(first, 'create') },
      { client: 'Kova Coffee', pass: learnPassFor(second, 'merge') },
      { client: 'Kova Coffee', pass: learnPassFor(third, 'merge') },
    ]);
  });

  it('never queues one for an episode of a series: its look is the series’, not the style’s', async () => {
    const worker = recordingWorker();
    const ready = job('Kova Coffee', 'Weekly 6');
    const episode = jobs.setSeries(ready.id, { seriesId: 'series-1', episode: 6, pinned: false });

    await createLearnOnReady({ inboxPath, worker })(episode);

    expect(worker.queued).toEqual([]);
  });

  it('never queues one for a job in Review: a preview is not an approved video', async () => {
    const worker = recordingWorker();
    const inReview = job('Kova Coffee', 'Menu', 'review');
    expect(inReview.state).toBe('review');

    await createLearnOnReady({ inboxPath, worker })(inReview);

    expect(worker.queued).toEqual([]);
  });

  it('hands a ready episode to its series instead, and waits for it (C26)', async () => {
    const worker = recordingWorker();
    const approved: Job[] = [];
    const series = {
      approved: async (given: Job) => {
        approved.push(given);
        return true;
      },
    };
    const ready = job('Kova Coffee', 'Weekly 6');
    const episode = jobs.setSeries(ready.id, { seriesId: 'series-1', episode: 6, pinned: false });

    await createLearnOnReady({ inboxPath, worker, series })(episode);
    await createLearnOnReady({ inboxPath, worker, series })(job('Kova Coffee', 'Menu'));
    await createLearnOnReady({ inboxPath, worker, series })(job('Kova Coffee', 'Draft', 'review'));

    expect(approved).toEqual([episode]);
    expect(worker.queued).toEqual([
      { client: 'Kova Coffee', pass: expect.objectContaining({ kind: 'learn', job: 'Menu' }) },
    ]);
  });
});

describe('before the edit worker starts a job', () => {
  /** A style worker that is learning the styles of `clients`, and lets the test end each wait. */
  function learningWorker(...clients: string[]) {
    const waits: { clientId: string; release: () => void }[] = [];
    return {
      waits,
      isLearning: (clientId: string) => clients.map(clientIdFor).includes(clientId),
      learned: (clientId: string) =>
        new Promise<void>((release) => {
          waits.push({ clientId, release });
        }),
    };
  }

  it('waits for the Learn pass of the job’s own client, until it is over', async () => {
    const worker = learningWorker('Kova Coffee');
    const next = job('Kova Coffee', 'Winter', 'queued');

    const wait = createLearnWait({ worker })(next);

    expect(wait).not.toBeNull();
    expect(worker.waits.map((entry) => entry.clientId)).toEqual([clientIdFor('Kova Coffee')]);
    let over = false;
    const waiting = wait?.then(() => {
      over = true;
    });
    await Promise.resolve();
    expect(over).toBe(false);
    worker.waits[0]?.release();
    await waiting;
    expect(over).toBe(true);
  });

  it('starts a job of another client at once, beside the Learn', () => {
    const worker = learningWorker('Kova Coffee');

    expect(createLearnWait({ worker })(job('Arc Fitness', 'Gym tour', 'queued'))).toBeNull();
    expect(worker.waits).toEqual([]);
  });

  it('starts a revise or render run at once: it has no Brief step to copy the style', () => {
    const worker = learningWorker('Kova Coffee');
    const queued = job('Kova Coffee', 'Winter', 'queued');

    for (const runKind of ['revise', 'render'] as const) {
      expect(createLearnWait({ worker })({ ...queued, runKind })).toBeNull();
    }
    expect(worker.waits).toEqual([]);
  });
});

describe('backfillStyles', () => {
  it('learns from the newest ready job of every client without a style.md', async () => {
    const worker = recordingWorker();
    const older = job('Kova Coffee', 'Autumn');
    const newest = job('Kova Coffee', 'Winter');
    job('Kova Coffee', 'Spring', 'failed');
    job('Arc Fitness', 'Gym tour');
    writeStyle('Arc Fitness');
    job('Lumen', 'Teaser', 'queued');
    const hebrew = job('מאפיית הצפון', 'סרטון גיוס');

    const count = await backfillStyles({ jobs, inboxPath, worker });

    expect(count).toBe(2);
    expect(worker.queued).toEqual(
      expect.arrayContaining([
        { client: 'Kova Coffee', pass: learnPassFor(newest, 'create') },
        { client: 'מאפיית הצפון', pass: learnPassFor(hebrew, 'create') },
      ]),
    );
    expect(worker.queued).toHaveLength(2);
    expect(
      worker.queued.some((entry) => entry.pass.kind === 'learn' && entry.pass.jobId === older.id),
    ).toBe(false);
  });

  it('leaves episodes of a series out: the newest job that is not one is learned', async () => {
    const worker = recordingWorker();
    const plain = job('Kova Coffee', 'Menu');
    const newest = job('Kova Coffee', 'Weekly 6');
    jobs.setSeries(newest.id, { seriesId: 'series-1', episode: 6, pinned: false });
    const onlyEpisode = job('Arc Fitness', 'Gym tour 2');
    jobs.setSeries(onlyEpisode.id, { seriesId: 'series-2', episode: 2, pinned: false });

    expect(await backfillStyles({ jobs, inboxPath, worker })).toBe(1);
    expect(worker.queued).toEqual([{ client: 'Kova Coffee', pass: learnPassFor(plain, 'create') }]);
  });

  it('goes on with the other clients when one cannot be queued', async () => {
    job('Kova Coffee', 'Menu');
    job('Arc Fitness', 'Gym tour');
    const queued: string[] = [];
    const worker = {
      enqueue: async (client: string) => {
        if (client === 'Arc Fitness') throw new Error('disk full');
        queued.push(client);
        return {} as never;
      },
    };

    expect(await backfillStyles({ jobs, inboxPath, worker })).toBe(1);
    expect(queued).toEqual(['Kova Coffee']);
  });

  it('queues nothing when there is no finished job', async () => {
    const worker = recordingWorker();
    job('Kova Coffee', 'Menu', 'failed');

    expect(await backfillStyles({ jobs, inboxPath, worker })).toBe(0);
    expect(worker.queued).toEqual([]);
  });
});
