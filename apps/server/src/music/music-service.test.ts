import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Job,
  type JobMusicEvent,
  jobFormatsOf,
  MUSIC_FILES,
  MUSIC_MESSAGES,
  type MusicRecord,
  type MusicVersion,
  musicStillBeingMade,
  type Song,
} from '@studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEventBus } from '../events/bus.js';
import { makeJob } from '../events/test-utils.js';
import { resolveFfmpeg } from '../pipeline/fake-media.js';
import {
  createMusicScriptRunner,
  type MusicScriptCall,
  type MusicScriptOutcome,
  type MusicScriptRunner,
} from './music-script.js';
import {
  createMusicService,
  hasPick,
  type MusicService,
  type MusicServiceOptions,
  whyNotMake,
} from './music-service.js';
import {
  deferred,
  fixtureRecord,
  type MusicJobFolder,
  musicJobFolder,
  ranFailed,
  ranOk,
  readRecordFile,
  smallPlan,
  writePreviewMusic,
  writeRecord,
} from './test-utils.js';

// MusicService: what it answers (the view and its reasons), Make another and Pick (guards, the
// script's arguments, concurrency, failures, events), Approve's wait, the run-end hook and the bus
// listener. Mostly with a stand-in for the script (the music-script runner has its own tests); the
// last block runs the real script on its fake path (an ffmpeg tone) in a temp job folder.

const folders: MusicJobFolder[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) folder.remove();
});

const NOW = new Date('2026-10-23T10:30:00.000Z');

interface Harness {
  folder: MusicJobFolder;
  job: Job;
  editDir: string;
  /** The jobs as `jobs.get` finds them; replace one to change its state. */
  jobs: Map<string, Job>;
  events: JobMusicEvent[];
  run: ReturnType<typeof vi.fn<MusicScriptRunner>>;
  usage: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  service: MusicService;
}

/** Waits until `check` holds (the service works in the background). */
const until = (check: () => void) => vi.waitFor(check, { timeout: 5_000, interval: 5 });

function harness(
  options: {
    record?: MusicRecord | null;
    job?: Partial<Job>;
    name?: string;
    run?: MusicScriptRunner;
    service?: Partial<MusicServiceOptions>;
    folder?: MusicJobFolder;
  } = {},
): Harness {
  const folder = options.folder ?? musicJobFolder(options.job, options.name);
  if (options.folder === undefined) folders.push(folder);
  if (options.record !== null) writeRecord(folder.editDir, options.record ?? fixtureRecord());
  const jobs = new Map<string, Job>([[folder.job.id, folder.job]]);
  const events: JobMusicEvent[] = [];
  const run = vi.fn<MusicScriptRunner>(options.run ?? (async () => ranOk('v3')));
  const usage = vi.fn(async () => {});
  const warn = vi.fn();
  const service = createMusicService({
    inboxPath: folder.inboxPath,
    logger: { warn, info: vi.fn(), error: vi.fn() },
    jobs: { get: (id) => jobs.get(id) ?? null },
    publish: (event) => events.push(event),
    run,
    usage,
    clock: () => NOW,
    ...options.service,
  });
  return {
    folder,
    job: folder.job,
    editDir: folder.editDir,
    jobs,
    events,
    run,
    usage,
    warn,
    service,
  };
}

/** The song Yael asked for, as a `song` call records it (Songs): 0:42 to 1:21 of a 3:12 track. */
function aSong(overrides: Partial<Song> = {}): Song {
  return {
    title: 'נתתי לך בית',
    artist: 'Ofek Adanek',
    version: null,
    asked: { from: 'screenshot', file: 'IMG_4412.PNG', url: null, by: 'brief' },
    source: {
      site: 'youtube-music',
      via: 'yt-dlp',
      url: 'https://music.youtube.com/watch?v=Zq3Rk1pXo9A',
      id: 'Zq3Rk1pXo9A',
    },
    fullMs: 192_000,
    part: { startMs: 42_000, endMs: 81_000, how: 'measured' },
    trending: null,
    file: 'song.mp3',
    instagramLine:
      'In Instagram tap Add audio, pick נתתי לך בית by Ofek Adanek and slide it to start at 0:42.',
    gotAt: '2026-10-25T21:03:00.000Z',
    ...overrides,
  };
}

/** What the script leaves in music.json after it made `id` (it also copies the file; not needed here). */
function recordWithVersion(
  id: string,
  extra: Partial<MusicVersion> = {},
  record: MusicRecord = fixtureRecord(),
): MusicRecord {
  const n = Number(id.slice(1));
  return {
    ...record,
    picked: id as 'v3',
    versions: [
      ...record.versions,
      {
        id: id as 'v3',
        file: `${id}.mp3`,
        describe: record.plan?.describe ?? 'A tone.',
        ask: null,
        seed: 100 + n,
        model: 'music_v2_5',
        lengthMs: 39_000,
        by: 'you',
        madeAt: '2026-10-23T10:31:00.000Z',
        ...extra,
      },
    ],
    picks: [...record.picks, { id: id as 'v3', at: '2026-10-23T10:31:00.000Z' }],
  };
}

/** A script that makes `id`: writes the record as the real one would, then answers. */
function makingScript(
  editDir: string,
  id = 'v3',
  gate?: { promise: Promise<void> },
): MusicScriptRunner {
  return async (call) => {
    await gate?.promise;
    if (call.signal?.aborted) return { kind: 'stopped', reason: 'cancel' };
    writeRecord(editDir, recordWithVersion(id));
    return ranOk(id);
  };
}

const lastEvent = (events: JobMusicEvent[]) => events.at(-1);

/** The script call the stand-in `run` got as call number `n` (the first by default). */
function callOf(run: Harness['run'], n = 0): MusicScriptCall {
  const call = run.mock.calls[n]?.[0];
  if (call === undefined) throw new Error(`the script was not called ${n + 1} times`);
  return call;
}

describe('whyNotMake', () => {
  const review = { state: 'review', seriesId: null } as const;
  const plan = { plan: smallPlan() };

  it('says why, in the order of the rules: episode, not in review, being made, being changed, no plan', () => {
    expect(whyNotMake(review, plan, null)).toBeNull();
    expect(whyNotMake({ state: 'review', seriesId: 's1' }, plan, null)).toBe(
      'Episodes play the series’ music.',
    );
    expect(whyNotMake({ state: 'editing', seriesId: 's1' }, plan, null)).toBe(
      MUSIC_MESSAGES.episode,
    );
    expect(whyNotMake({ state: 'editing', seriesId: null }, plan, null)).toBe(
      'Music can be changed while the video waits for your review.',
    );
    expect(whyNotMake(review, plan, { kind: 'make', id: 'v4' })).toBe(
      'Music v4 is still being made.',
    );
    expect(whyNotMake(review, plan, { kind: 'pick', id: 'v1' })).toBe(MUSIC_MESSAGES.busy);
    expect(whyNotMake(review, { plan: null }, null)).toBe('There’s no music plan for this video.');
    expect(whyNotMake(review, null, null)).toBe(MUSIC_MESSAGES.noPlan);
  });

  it('allows a plan that has made nothing: that is how music gets made once ElevenLabs works again', () => {
    expect(whyNotMake(review, plan, null)).toBeNull();
  });

  it('does not ask for a plan when only picking', () => {
    expect(whyNotMake(review, { plan: null }, null, { needsPlan: false })).toBeNull();
  });
});

describe('read and view', () => {
  it('answer null for a job without music.json, and for one the service cannot use (and say so)', async () => {
    const none = harness({ record: null });
    expect(await none.service.read(none.job)).toBeNull();
    expect(await none.service.view(none.job)).toBeNull();
    expect(none.warn).not.toHaveBeenCalled();

    const broken = harness({ record: null });
    writeRecord(broken.editDir, fixtureRecord());
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(broken.editDir, MUSIC_FILES.record), '{not json');
    expect(await broken.service.view(broken.job)).toBeNull();
    writeFileSync(join(broken.editDir, MUSIC_FILES.record), JSON.stringify({ v: 2 }));
    expect(await broken.service.view(broken.job)).toBeNull();
    expect(broken.warn).toHaveBeenCalledTimes(2);
  });

  it('is the record plus canMake, whyNot and rev while the video waits for review', async () => {
    const h = harness();
    writePreviewMusic(h.editDir);
    const view = await h.service.view(h.job);
    expect(view).toEqual({
      ...fixtureRecord(),
      canMake: true,
      whyNot: null,
      rev: Math.floor(statSync(join(h.editDir, MUSIC_FILES.preview)).mtimeMs),
    });
    expect((await harness().service.view(h.job))?.rev).toBe(0);
  });

  it.each(['arriving', 'queued', 'editing', 'held', 'failed', 'cancelled', 'ready'] as const)(
    'is not allowed while the job is %s',
    async (state) => {
      const h = harness({ job: { state } });
      const view = await h.service.view(h.job);
      expect(view).toMatchObject({
        canMake: false,
        whyNot: 'Music can be changed while the video waits for your review.',
      });
    },
  );

  it('is not allowed for an episode of a series', async () => {
    const h = harness({ job: { seriesId: 'series-1', episode: 3 } });
    expect(await h.service.view(h.job)).toMatchObject({
      canMake: false,
      whyNot: 'Episodes play the series’ music.',
    });
  });

  it('is not allowed without a plan to make from (supplied music, no music)', async () => {
    const h = harness({
      record: fixtureRecord({
        source: 'supplied',
        file: 'Summer Vibes.mp3',
        plan: null,
        picked: 'file',
        versions: [],
        picks: [],
      }),
    });
    expect(await h.service.view(h.job)).toMatchObject({
      canMake: false,
      whyNot: MUSIC_MESSAGES.noPlan,
    });
  });

  /** A first make that failed: a plan, no versions, a failure, nothing picked, silence in the preview. */
  const failedFirstMake = (): MusicRecord =>
    fixtureRecord({
      picked: null,
      versions: [],
      picks: [],
      failure: {
        id: 'v1',
        code: 'no_credits',
        message: 'ElevenLabs says this month’s credits are used up.',
        at: '2026-10-23T09:05:00.000Z',
      },
    });

  it('allows Make another after a first make that failed, and shows the failure', async () => {
    const h = harness({ record: failedFirstMake() });
    writePreviewMusic(h.editDir, 'silence');
    expect(await h.service.view(h.job)).toMatchObject({
      canMake: true,
      whyNot: null,
      picked: null,
      versions: [],
      failure: { id: 'v1', code: 'no_credits' },
    });

    h.run.mockImplementation(async () => {
      writeRecord(
        h.editDir,
        recordWithVersion('v1', {}, { ...fixtureRecord(), versions: [], picks: [] }),
      );
      return ranOk('v1');
    });
    const result = await h.service.makeAnother(h.job);
    expect(result.ok && result.view).toMatchObject({
      making: { id: 'v1' },
      failure: null,
      whyNot: 'Music v1 is still being made.',
    });
    await until(() => expect(h.events).toHaveLength(2));
    expect(callOf(h.run).argv).toEqual(['make', h.editDir, '--again', '--by', 'you']);
    expect(h.events[1]?.music).toMatchObject({ picked: 'v1', failure: null, making: null });
  });

  it('allows No music after a first make that failed, and has no version to pick', async () => {
    const h = harness({ record: failedFirstMake() });
    expect(await h.service.pick(h.job, 'v1')).toEqual({
      ok: false,
      status: 404,
      error: MUSIC_MESSAGES.noSuchVersion,
    });
    h.run.mockResolvedValue(ranOk('off'));
    await h.service.pick(h.job, 'off');
    expect(callOf(h.run).argv).toEqual(['pick', h.editDir, 'off']);
  });

  it('shows the record’s making only while a run edits the job, and its failure only when nothing is being made', async () => {
    const making = {
      id: 'v3',
      ask: null,
      startedAt: '2026-10-23T10:00:00.000Z',
    } as const;
    const failure = {
      id: 'v3',
      code: 'down',
      message: 'ElevenLabs could not be reached.',
      at: '2026-10-23T10:00:00.000Z',
    } as const;

    // A script that was killed left `making` behind: nothing is being made.
    const stale = harness({ record: fixtureRecord({ making }) });
    expect((await stale.service.view(stale.job))?.making).toBeNull();
    // An edit run is calling the script itself: it is being made.
    const editing = harness({ record: fixtureRecord({ making }), job: { state: 'editing' } });
    expect((await editing.service.view(editing.job))?.making).toEqual(making);

    const failed = harness({ record: fixtureRecord({ failure }) });
    expect((await failed.service.view(failed.job))?.failure).toEqual(failure);
    const failedWhileMaking = harness({
      record: fixtureRecord({ failure, making }),
      job: { state: 'editing' },
    });
    expect((await failedWhileMaking.service.view(failedWhileMaking.job))?.failure).toBeNull();
  });
});

describe('Make another', () => {
  it('is refused with 409 and the reason, and starts nothing', async () => {
    const cases: Array<[Parameters<typeof harness>[0], string]> = [
      [{ job: { state: 'editing' } }, MUSIC_MESSAGES.notInReview],
      [{ job: { state: 'ready' } }, MUSIC_MESSAGES.notInReview],
      [{ job: { seriesId: 's1', episode: 2 } }, MUSIC_MESSAGES.episode],
      [{ record: fixtureRecord({ plan: null }) }, MUSIC_MESSAGES.noPlan],
      [{ record: null }, MUSIC_MESSAGES.noPlan],
    ];
    for (const [options, reason] of cases) {
      const h = harness(options);
      expect(await h.service.makeAnother(h.job)).toEqual({ ok: false, status: 409, error: reason });
      expect(h.run).not.toHaveBeenCalled();
      expect(h.events).toEqual([]);
    }
  });

  it('answers at once with the view, now making the next version, and runs `make --again --by you`', async () => {
    const gate = deferred<void>();
    const h = harness();
    h.run.mockImplementation(makingScript(h.editDir, 'v3', gate));

    const result = await h.service.makeAnother(h.job);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.view).toMatchObject({
      making: { id: 'v3', ask: null, startedAt: NOW.toISOString() },
      failure: null,
      canMake: false,
      whyNot: musicStillBeingMade('v3'),
      picked: 'v2',
    });
    expect(h.service.makingVersion(h.job.id)).toBe('v3');
    expect(h.service.reviewBlock(h.job.id)).toBe('Music v3 is still being made.');
    expect(lastEvent(h.events)).toEqual({ type: 'job.music', jobId: h.job.id, music: result.view });

    await until(() => expect(h.run).toHaveBeenCalledTimes(1));
    const call = h.run.mock.calls[0]?.[0] as MusicScriptCall;
    expect(call.argv).toEqual(['make', h.editDir, '--again', '--by', 'you']);
    expect(call.timeoutMs).toBe(5 * 60_000);
    expect(call.signal?.aborted).toBe(false);

    gate.resolve();
    await until(() => expect(h.service.makingVersion(h.job.id)).toBeNull());
  });

  it('passes the words, trimmed, and --fake when the engine makes fake music', async () => {
    const h = harness({ service: { fake: true } });
    h.run.mockImplementation(makingScript(h.editDir));
    await h.service.makeAnother(h.job, '  darker, more drums \0');
    await until(() => expect(h.run).toHaveBeenCalled());
    expect(callOf(h.run).argv).toEqual([
      'make',
      h.editDir,
      '--again',
      '--ask',
      'darker, more drums',
      '--by',
      'you',
      '--fake',
    ]);
    await until(() => expect(h.service.makingVersion(h.job.id)).toBeNull());

    const blank = harness();
    blank.run.mockImplementation(makingScript(blank.editDir));
    const result = await blank.service.makeAnother(blank.job, '   ');
    expect(result.ok && result.view.making?.ask).toBeNull();
    await until(() => expect(blank.run).toHaveBeenCalled());
    expect(callOf(blank.run).argv).not.toContain('--ask');
  });

  it('tells the page “making”, then “made”, in that order, and logs the usage once it is done', async () => {
    const h = harness();
    h.run.mockImplementation(makingScript(h.editDir));

    await h.service.makeAnother(h.job, 'calmer');
    await until(() => expect(h.events.length).toBeGreaterThanOrEqual(2));

    expect(h.events).toHaveLength(2);
    expect(h.events[0]?.music?.making).toMatchObject({ id: 'v3', ask: 'calmer' });
    const done = h.events[1]?.music;
    expect(done).toMatchObject({
      making: null,
      failure: null,
      picked: 'v3',
      canMake: true,
      whyNot: null,
    });
    expect(done?.versions.map((version) => version.id)).toEqual(['v1', 'v2', 'v3']);
    expect(h.usage).toHaveBeenCalledTimes(1);
    expect(h.usage).toHaveBeenCalledWith(h.job, expect.objectContaining({ picked: 'v3' }));
    expect(h.service.makingVersion(h.job.id)).toBeNull();
    expect(h.service.reviewBlock(h.job.id)).toBeNull();
  });

  it('is one at a time for a job: the second Make, and any Pick, are 409 until it is done', async () => {
    const gate = deferred<void>();
    const h = harness();
    h.run.mockImplementation(makingScript(h.editDir, 'v3', gate));
    await h.service.makeAnother(h.job);

    expect(await h.service.makeAnother(h.job)).toEqual({
      ok: false,
      status: 409,
      error: 'Music v3 is still being made.',
    });
    expect(await h.service.pick(h.job, 'v1')).toEqual({
      ok: false,
      status: 409,
      error: 'Music v3 is still being made.',
    });
    await until(() => expect(h.run).toHaveBeenCalledTimes(1));

    gate.resolve();
    await until(() => expect(h.service.makingVersion(h.job.id)).toBeNull());
    expect(h.run).toHaveBeenCalledTimes(1);
  });

  /** Jobs in one inbox, each with the fixture's music.json, and one service for all of them. */
  function severalJobs(names: string[], run: MusicScriptRunner) {
    const folder = musicJobFolder({}, names[0]);
    folders.push(folder);
    writeRecord(folder.editDir, fixtureRecord());
    const all: Job[] = [folder.job];
    for (const name of names.slice(1)) {
      const job = makeJob({
        ...folder.job,
        id: `job-${name}`.padEnd(12, '0'),
        name,
        relPath: `Horizon FPV/${name}`,
      });
      writeRecord(join(folder.inboxPath, job.relPath, 'edit'), fixtureRecord());
      all.push(job);
    }
    const service = createMusicService({
      inboxPath: folder.inboxPath,
      logger: { warn: vi.fn() },
      jobs: { get: (id) => all.find((job) => job.id === id) ?? null },
      run,
    });
    return { folder, jobs: all, service };
  }

  it('runs two makes at once overall, and the third waits for one of them', async () => {
    const started: string[] = [];
    const release: Array<() => void> = [];
    const { folder, jobs, service } = severalJobs(['One', 'Two', 'Three'], async (call) => {
      started.push(call.argv[1] as string);
      await new Promise<void>((resolve) => release.push(resolve));
      return ranOk('v3');
    });

    for (const job of jobs) expect((await service.makeAnother(job)).ok, job.name).toBe(true);
    // All three are “being made” for the page; only two run.
    expect(jobs.map((job) => service.makingVersion(job.id))).toEqual(['v3', 'v3', 'v3']);
    await until(() => expect(started).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(started).toHaveLength(2);
    expect(started).not.toContain(join(folder.inboxPath, 'Horizon FPV/Three', 'edit'));

    release[0]?.();
    await until(() => expect(started).toHaveLength(3));
    expect(started[2]).toBe(join(folder.inboxPath, 'Horizon FPV/Three', 'edit'));
    await until(() => expect(release).toHaveLength(3));
    for (const done of release) done();
    await until(() =>
      expect(jobs.map((job) => service.makingVersion(job.id))).toEqual([null, null, null]),
    );
  });

  it('drops a make that waits its turn when its job is stopped, without ever running it', async () => {
    const started: string[] = [];
    const release: Array<() => void> = [];
    const { jobs, service } = severalJobs(['One', 'Two', 'Three'], async (call) => {
      started.push(call.argv[1] as string);
      await new Promise<void>((resolve) => release.push(resolve));
      return ranOk('v3');
    });
    for (const job of jobs) await service.makeAnother(job);
    await until(() => expect(started).toHaveLength(2));

    await service.stopJob((jobs[2] as Job).id);

    expect(service.makingVersion((jobs[2] as Job).id)).toBeNull();
    for (const done of release) done();
    await until(() => expect(service.makingVersion((jobs[0] as Job).id)).toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(started).toHaveLength(2);
  });

  it('shows the script’s own failure (it is in music.json), allows another try, and logs it', async () => {
    const h = harness();
    h.run.mockImplementation(async () => {
      writeRecord(
        h.editDir,
        fixtureRecord({
          failure: {
            id: 'v3',
            code: 'no_credits',
            message: 'ElevenLabs says this month’s credits are used up.',
            at: '2026-10-23T10:31:00.000Z',
          },
        }),
      );
      return ranFailed('no_credits', 'ElevenLabs says this month’s credits are used up.');
    });

    await h.service.makeAnother(h.job);
    await until(() => expect(h.events).toHaveLength(2));

    expect(h.events[1]?.music).toMatchObject({
      making: null,
      picked: 'v2',
      failure: { id: 'v3', code: 'no_credits' },
      canMake: true,
    });
    expect(h.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'no_credits', jobId: h.job.id }),
      'ElevenLabs says this month’s credits are used up.',
    );
  });

  it.each([
    [
      'took too long',
      { kind: 'timed_out' },
      { code: 'down', message: 'Making the music took too long. Try again.' },
    ],
    [
      'could not start',
      { kind: 'not_started', message: 'spawn node ENOENT' },
      { code: 'failed', message: 'The music script could not be started: spawn node ENOENT' },
    ],
    [
      'stopped without an answer',
      { kind: 'ran', exitCode: 1, signal: null, line: null, stderr: 'boom\nnode: bad thing' },
      {
        code: 'failed',
        message: 'The music script stopped without an answer (node: bad thing).',
      },
    ],
  ] as Array<[string, MusicScriptOutcome, { code: string; message: string }]>)(
    'shows a make that %s as a failure of its own, until the next make starts',
    async (_name, outcome, expected) => {
      const h = harness();
      h.run.mockImplementation(async () => outcome);

      await h.service.makeAnother(h.job);
      await until(() => expect(h.events).toHaveLength(2));

      expect(h.events[1]?.music).toMatchObject({
        making: null,
        failure: { id: 'v3', ...expected },
        canMake: true,
      });
      expect((await h.service.view(h.job))?.failure?.message).toBe(expected.message);

      // The next make: no failure shown while it runs.
      const gate = deferred<void>();
      h.run.mockImplementation(makingScript(h.editDir, 'v3', gate));
      const again = await h.service.makeAnother(h.job);
      expect(again.ok && again.view.failure).toBeNull();
      gate.resolve();
      await until(() => expect(h.service.makingVersion(h.job.id)).toBeNull());
      expect((await h.service.view(h.job))?.failure).toBeNull();
    },
  );

  it('survives a script runner that throws, and a usage hook that throws', async () => {
    const h = harness();
    h.run.mockRejectedValue(new Error('spawn exploded sk_abcdef123456'));
    h.usage.mockRejectedValue(new Error('disk full'));

    await h.service.makeAnother(h.job);
    await until(() => expect(h.events).toHaveLength(2));

    expect(h.events[1]?.music?.failure?.message).toBe(
      'The music script could not be started: spawn exploded sk_…',
    );
    expect(h.warn).toHaveBeenCalledWith(expect.anything(), 'could not log the usage of the music');
    expect(h.service.makingVersion(h.job.id)).toBeNull();
  });

  it('stops the script when the job is stopped (cancelled, deleted), and tells the page nothing is being made', async () => {
    const h = harness();
    h.run.mockImplementation(
      (call) =>
        new Promise<MusicScriptOutcome>((resolve) => {
          call.signal?.addEventListener('abort', () =>
            resolve({ kind: 'stopped', reason: 'cancel' }),
          );
        }),
    );
    await h.service.makeAnother(h.job);
    await until(() => expect(h.run).toHaveBeenCalled());

    await h.service.stopJob(h.job.id);

    expect(callOf(h.run).signal?.aborted).toBe(true);
    expect(h.service.makingVersion(h.job.id)).toBeNull();
    expect(lastEvent(h.events)?.music).toMatchObject({ making: null, failure: null });
    // Nothing to stop: fine.
    await h.service.stopJob(h.job.id);
    await h.service.stopJob('nobody');
  });

  it('stops everything on shutdown, tells nobody, and refuses new calls', async () => {
    const h = harness();
    h.run.mockImplementation(
      (call) =>
        new Promise<MusicScriptOutcome>((resolve) => {
          call.signal?.addEventListener('abort', () =>
            resolve({
              kind: 'stopped',
              reason: call.signal?.reason === 'shutdown' ? 'shutdown' : 'cancel',
            }),
          );
        }),
    );
    await h.service.makeAnother(h.job);
    await until(() => expect(h.run).toHaveBeenCalled());
    const before = h.events.length;

    await h.service.stop();

    expect(callOf(h.run).signal?.reason).toBe('shutdown');
    expect(h.events).toHaveLength(before);
    expect(await h.service.makeAnother(h.job)).toEqual({
      ok: false,
      status: 409,
      error: MUSIC_MESSAGES.stopping,
    });
    expect(await h.service.pick(h.job, 'v1')).toMatchObject({ ok: false, status: 409 });
  });
});

describe('Pick', () => {
  /** A script that picks: the record's `picked` changes, as the real one does. */
  function pickingScript(editDir: string): MusicScriptRunner {
    return async (call) => {
      const id = call.argv[2] as 'v1' | 'off';
      const record = readRecordFile(editDir);
      writeRecord(editDir, {
        ...record,
        picked: id,
        picks: [...record.picks, { id, at: '2026-10-23T10:40:00.000Z' }],
      });
      return ranOk(id);
    };
  }

  it('is refused with 409 and the reason when it is not allowed', async () => {
    for (const [options, reason] of [
      [{ job: { state: 'editing' } }, MUSIC_MESSAGES.notInReview],
      [{ job: { seriesId: 's1', episode: 1 } }, MUSIC_MESSAGES.episode],
    ] as const) {
      const h = harness(options);
      expect(await h.service.pick(h.job, 'v1')).toEqual({ ok: false, status: 409, error: reason });
      expect(h.run).not.toHaveBeenCalled();
    }
  });

  it('answers 404 for a version the job does not have, and for a job without a record', async () => {
    const h = harness();
    expect(await h.service.pick(h.job, 'v9')).toEqual({
      ok: false,
      status: 404,
      error: MUSIC_MESSAGES.noSuchVersion,
    });
    const none = harness({ record: null });
    expect(await none.service.pick(none.job, 'off')).toMatchObject({ ok: false, status: 404 });
    expect(h.run).not.toHaveBeenCalled();
  });

  it('runs `pick`, answers the new view and tells the page', async () => {
    const h = harness();
    h.run.mockImplementation(pickingScript(h.editDir));

    const result = await h.service.pick(h.job, 'v1');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.view).toMatchObject({ picked: 'v1', making: null, canMake: true });
    expect(result.view.picks.at(-1)?.id).toBe('v1');
    const call = h.run.mock.calls[0]?.[0] as MusicScriptCall;
    expect(call.argv).toEqual(['pick', h.editDir, 'v1']);
    expect(call.timeoutMs).toBe(60_000);
    expect(h.events).toEqual([{ type: 'job.music', jobId: h.job.id, music: result.view }]);
    expect(h.service.reviewBlock(h.job.id)).toBeNull();
  });

  it('picks off, and passes --fake on the fake path', async () => {
    const h = harness({ service: { fake: true } });
    h.run.mockImplementation(pickingScript(h.editDir));
    const result = await h.service.pick(h.job, 'off');
    expect(result.ok && result.view.picked).toBe('off');
    expect(callOf(h.run).argv).toEqual(['pick', h.editDir, 'off', '--fake']);
  });

  describe('the song (Songs)', () => {
    /** The edit run's v1 is picked, and a `song` call recorded a song next to it. */
    const withSong = () => fixtureRecord({ song: aSong() });

    it('has the song to pick only when the record has one', () => {
      expect(hasPick(withSong(), 'song')).toBe(true);
      expect(hasPick(fixtureRecord(), 'song')).toBe(false);
      // The song stays pickable while a version (or No music) is picked instead.
      expect(hasPick({ ...withSong(), source: 'made' }, 'song')).toBe(true);
      // The other picks are as they were.
      expect(hasPick(withSong(), 'off')).toBe(true);
      expect(hasPick(withSong(), 'v1')).toBe(true);
      expect(hasPick(withSong(), 'file')).toBe(false);
      expect(hasPick(withSong(), 'series')).toBe(false);
    });

    it('runs `pick song` for a record with a song, answers the view and tells the page', async () => {
      const h = harness({ record: withSong() });
      h.run.mockImplementation(async () => {
        const record = readRecordFile(h.editDir);
        writeRecord(h.editDir, {
          ...record,
          picked: 'song',
          picks: [...record.picks, { id: 'song', at: '2026-10-25T21:05:00.000Z' }],
        });
        return ranOk('song', 39_000);
      });

      const result = await h.service.pick(h.job, 'song');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.view).toMatchObject({ picked: 'song', canMake: true });
      expect(result.view.song?.title).toBe('נתתי לך בית');
      expect(callOf(h.run).argv).toEqual(['pick', h.editDir, 'song']);
      expect(h.events).toEqual([{ type: 'job.music', jobId: h.job.id, music: result.view }]);
    });

    it('answers 404 for the song when the record has none, and starts nothing', async () => {
      const h = harness();
      expect(await h.service.pick(h.job, 'song')).toEqual({
        ok: false,
        status: 404,
        error: MUSIC_MESSAGES.noSuchVersion,
      });
      expect(h.run).not.toHaveBeenCalled();
    });

    it('does nothing for the song when it is already the pick', async () => {
      const h = harness({ record: { ...withSong(), source: 'song', picked: 'song' } });
      const result = await h.service.pick(h.job, 'song');
      expect(result.ok && result.view.picked).toBe('song');
      expect(h.run).not.toHaveBeenCalled();
      expect(h.events).toEqual([]);
    });

    it('is refused like any pick when the video is not waiting for review', async () => {
      const h = harness({ record: withSong(), job: { state: 'editing' } });
      expect(await h.service.pick(h.job, 'song')).toEqual({
        ok: false,
        status: 409,
        error: MUSIC_MESSAGES.notInReview,
      });
      expect(h.run).not.toHaveBeenCalled();
    });
  });

  it('does nothing for the pick that is already in place', async () => {
    const h = harness();
    const result = await h.service.pick(h.job, 'v2');
    expect(result.ok && result.view.picked).toBe('v2');
    expect(h.run).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
  });

  it('is one at a time: a second Pick or a Make during a Pick is 409, and Approve waits', async () => {
    const gate = deferred<void>();
    const h = harness();
    h.run.mockImplementation(async (call) => {
      await gate.promise;
      return pickingScript(h.editDir)(call);
    });

    const picking = h.service.pick(h.job, 'v1');
    await until(() => expect(h.run).toHaveBeenCalled());
    expect(await h.service.pick(h.job, 'off')).toEqual({
      ok: false,
      status: 409,
      error: MUSIC_MESSAGES.busy,
    });
    expect(await h.service.makeAnother(h.job)).toMatchObject({ ok: false, status: 409 });
    expect(h.service.reviewBlock(h.job.id)).toBe(MUSIC_MESSAGES.busy);
    expect(h.service.makingVersion(h.job.id)).toBeNull();

    gate.resolve();
    expect((await picking).ok).toBe(true);
    expect(h.service.reviewBlock(h.job.id)).toBeNull();
  });

  it('answers the script’s own words when it says no (409), and 500 when it gives no answer', async () => {
    const no = harness();
    no.run.mockResolvedValue(ranFailed('failed', 'There is no music to turn off yet.', 1));
    expect(await no.service.pick(no.job, 'off')).toEqual({
      ok: false,
      status: 409,
      error: 'There is no music to turn off yet.',
    });
    expect(no.events).toEqual([]);

    for (const outcome of [
      { kind: 'timed_out' },
      { kind: 'not_started', message: 'ENOENT' },
      { kind: 'ran', exitCode: 1, signal: null, line: null, stderr: '' },
    ] as MusicScriptOutcome[]) {
      const h = harness();
      h.run.mockResolvedValue(outcome);
      const result = await h.service.pick(h.job, 'v1');
      expect(result).toMatchObject({ ok: false, status: 500 });
      expect(h.service.reviewBlock(h.job.id)).toBeNull();
    }
  });

  it('says the music was not changed when the job is stopped meanwhile', async () => {
    const h = harness();
    h.run.mockImplementation(
      (call) =>
        new Promise<MusicScriptOutcome>((resolve) => {
          call.signal?.addEventListener('abort', () =>
            resolve({ kind: 'stopped', reason: 'cancel' }),
          );
        }),
    );
    const picking = h.service.pick(h.job, 'v1');
    await until(() => expect(h.run).toHaveBeenCalled());
    await h.service.stopJob(h.job.id);
    expect(await picking).toEqual({
      ok: false,
      status: 409,
      error: 'The music was not changed.',
    });
  });
});

describe('afterRun (an edit or revise run has ended)', () => {
  it('logs the record’s versions and tells the page the job’s music as it is then', async () => {
    const h = harness({ job: { state: 'editing' } });
    await h.service.afterRun(h.job);

    expect(h.usage).toHaveBeenCalledWith(h.job, fixtureRecord());
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({
      type: 'job.music',
      jobId: h.job.id,
      music: { picked: 'v2', canMake: false, whyNot: MUSIC_MESSAGES.notInReview },
    });
  });

  it('tells the page “no music” for a job without a record, logs nothing, and forgets an old lost make', async () => {
    const h = harness({ record: null });
    await h.service.afterRun(h.job);
    expect(h.events).toEqual([{ type: 'job.music', jobId: h.job.id, music: null }]);
    expect(h.usage).not.toHaveBeenCalled();
  });

  it('does nothing for a job that is gone, and never rejects', async () => {
    const h = harness();
    h.jobs.delete(h.job.id);
    await h.service.afterRun(h.job);
    expect(h.events).toEqual([]);

    const broken = harness();
    broken.usage.mockRejectedValue(new Error('no'));
    await expect(broken.service.afterRun(broken.job)).resolves.toBeUndefined();
    expect(broken.warn).toHaveBeenCalled();
  });
});

describe('listen (the bus)', () => {
  function listening() {
    const h = harness();
    const bus = createEventBus();
    const stop = h.service.listen(bus);
    return { ...h, bus, stop };
  }
  const upsert = (job: Job) => ({ type: 'job.upsert', job }) as const;

  it('stops what runs for a job that is deleted, and for one that is cancelled', async () => {
    for (const end of [
      (h: ReturnType<typeof listening>) => h.bus.publish({ type: 'job.remove', id: h.job.id }),
      (h: ReturnType<typeof listening>) => h.bus.publish(upsert({ ...h.job, state: 'cancelled' })),
    ]) {
      const h = listening();
      h.run.mockImplementation(
        (call) =>
          new Promise<MusicScriptOutcome>((resolve) => {
            call.signal?.addEventListener('abort', () =>
              resolve({ kind: 'stopped', reason: 'cancel' }),
            );
          }),
      );
      await h.service.makeAnother(h.job);
      await until(() => expect(h.run).toHaveBeenCalled());

      end(h);

      await until(() => expect(h.service.makingVersion(h.job.id)).toBeNull());
      expect(callOf(h.run).signal?.aborted).toBe(true);
      h.stop();
    }
  });

  it('tells the page the job’s music when a change of state changes what it may do (not on the first sight, not on a progress tick)', async () => {
    const h = listening();
    const editing = { ...h.job, state: 'editing' as const };

    h.bus.publish(upsert(editing));
    expect(h.events).toEqual([]);
    h.bus.publish(upsert({ ...editing, step: 6, subProgress: 'making the music' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.events).toEqual([]);

    h.bus.publish(upsert({ ...h.job, state: 'review' }));
    await until(() => expect(h.events).toHaveLength(1));
    expect(h.events[0]?.music).toMatchObject({ canMake: true, whyNot: null });

    h.bus.publish(upsert({ ...h.job, state: 'queued' }));
    await until(() => expect(h.events).toHaveLength(2));
    expect(h.events[1]?.music).toMatchObject({
      canMake: false,
      whyNot: MUSIC_MESSAGES.notInReview,
    });
  });

  it('says nothing for a job with no music, and stops listening when told', async () => {
    const none = harness({ record: null });
    const bus = createEventBus();
    const stop = none.service.listen(bus);
    bus.publish(upsert(none.job));
    bus.publish(upsert({ ...none.job, state: 'editing' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(none.events).toEqual([]);
    stop();

    const h = listening();
    h.stop();
    h.bus.publish(upsert({ ...h.job, state: 'editing' }));
    h.bus.publish(upsert(h.job));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.events).toEqual([]);
  });
});

describe('while a quick fix is changing the preview (QF3)', () => {
  const FIXING = 'A quick fix is running. Wait for it to finish.';

  /** A service that is told by the test whether a fix is on. */
  function fixing() {
    const block: { value: string | null } = { value: FIXING };
    const h = harness({ service: { fixBlock: () => block.value } });
    return { ...h, block };
  }

  it('refuses Make another and Pick with the fix’s words, and starts nothing', async () => {
    const h = fixing();

    expect(await h.service.makeAnother(h.job)).toEqual({ ok: false, status: 409, error: FIXING });
    expect(await h.service.pick(h.job, 'v1')).toEqual({ ok: false, status: 409, error: FIXING });
    expect(h.run).not.toHaveBeenCalled();
    expect(h.service.makingVersion(h.job.id)).toBeNull();
    expect(h.events).toEqual([]);
  });

  it('says so in the view (canMake, whyNot), and allows both again when the fix is done', async () => {
    const h = fixing();

    expect(await h.service.view(h.job)).toMatchObject({ canMake: false, whyNot: FIXING });
    h.block.value = null;
    expect(await h.service.view(h.job)).toMatchObject({ canMake: true, whyNot: null });
    expect(await h.service.makeAnother(h.job)).toMatchObject({ ok: true });
  });

  it('keeps its own reasons first: not in review is still not in review', async () => {
    const h = fixing();
    h.jobs.set(h.job.id, { ...h.job, state: 'queued' });
    const queued = h.jobs.get(h.job.id) as Job;

    expect(await h.service.makeAnother(queued)).toMatchObject({
      status: 409,
      error: MUSIC_MESSAGES.notInReview,
    });
  });

  it('tells the page when a fix starts or ends, once for each change', async () => {
    const h = fixing();
    const bus = createEventBus();
    h.service.listen(bus);
    const fixEvent = (id: string) =>
      ({
        type: 'job.fix',
        jobId: id,
        fix: { id: 'fix1', jobId: id, status: 'running' },
      }) as never;

    // Blocked from the first event on: the page hears that Make another and Pick are off.
    bus.publish(fixEvent(h.job.id));
    await until(() => expect(h.events).toHaveLength(1));
    expect(h.events[0]?.music).toMatchObject({ canMake: false, whyNot: FIXING });
    // A step of the same fix is not news.
    bus.publish(fixEvent(h.job.id));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.events).toHaveLength(1);

    h.block.value = null;
    bus.publish(fixEvent(h.job.id));
    await until(() => expect(h.events).toHaveLength(2));
    expect(h.events[1]?.music).toMatchObject({ canMake: true, whyNot: null });
  });

  it('is as it was without a fix block', async () => {
    const h = harness();
    expect(await h.service.view(h.job)).toMatchObject({ canMake: true, whyNot: null });
    const bus = createEventBus();
    h.service.listen(bus);
    bus.publish({ type: 'job.fix', jobId: h.job.id } as never);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.events).toEqual([]);
  });
});

describe('a job with two or more formats (C64)', () => {
  const TWO = jobFormatsOf(['1080x1920', '1080x1080']);
  const THREE = jobFormatsOf(['1080x1920', '1080x1080', '1080x1350']);

  /** edit/preview-<id>/ for each id, each with the old track, as the edit run left them. */
  function extraFolders(editDir: string, ids: string[], bytes = 'old'): void {
    for (const id of ids) {
      mkdirSync(join(editDir, `preview-${id}`), { recursive: true });
      writeFileSync(join(editDir, `preview-${id}`, 'music.mp3'), bytes);
    }
  }
  const textOf = (path: string) => readFileSync(path, 'utf8');

  /** A script that picks `id` and puts `bytes` at edit/preview/music.mp3, as the real one does. */
  function pickingScript(editDir: string, bytes: string): MusicScriptRunner {
    return async (call) => {
      const id = call.argv[2] as 'v1' | 'off';
      const record = readRecordFile(editDir);
      writeRecord(editDir, {
        ...record,
        picked: id,
        picks: [...record.picks, { id, at: NOW.toISOString() }],
      });
      writePreviewMusic(editDir, bytes);
      return ranOk(id);
    };
  }

  /** A script that makes v3 and puts `bytes` at edit/preview/music.mp3. */
  function makingFilesScript(editDir: string, bytes: string): MusicScriptRunner {
    const making = makingScript(editDir);
    return async (call) => {
      const outcome = await making(call);
      writePreviewMusic(editDir, bytes);
      return outcome;
    };
  }

  it('a Pick puts the picked music into every other format’s folder', async () => {
    const h = harness({ job: { formats: THREE } });
    writePreviewMusic(h.editDir, 'old');
    extraFolders(h.editDir, ['1x1', '4x5']);
    h.run.mockImplementation(pickingScript(h.editDir, 'v1 track'));

    const result = await h.service.pick(h.job, 'v1');

    expect(result.ok).toBe(true);
    expect(textOf(join(h.editDir, 'preview', 'music.mp3'))).toBe('v1 track');
    expect(textOf(join(h.editDir, 'preview-1x1', 'music.mp3'))).toBe('v1 track');
    expect(textOf(join(h.editDir, 'preview-4x5', 'music.mp3'))).toBe('v1 track');
    expect(h.warn).not.toHaveBeenCalled();
    // The page is told after the copy, so it never sees the new music with a format on the old one.
    expect(h.events).toHaveLength(1);
  });

  it('No music puts the silence into the other formats too', async () => {
    const h = harness({ job: { formats: TWO } });
    writePreviewMusic(h.editDir, 'a track');
    extraFolders(h.editDir, ['1x1'], 'a track');
    h.run.mockImplementation(pickingScript(h.editDir, 'silence'));

    const result = await h.service.pick(h.job, 'off');

    expect(result.ok && result.view.picked).toBe('off');
    expect(textOf(join(h.editDir, 'preview-1x1', 'music.mp3'))).toBe('silence');
  });

  it('Make another puts the new version into every other format’s folder before the page hears it is made', async () => {
    const h = harness({ job: { formats: TWO } });
    writePreviewMusic(h.editDir, 'old');
    extraFolders(h.editDir, ['1x1']);
    h.run.mockImplementation(makingFilesScript(h.editDir, 'v3 track'));
    // What the folder holds at the moment the page is told the music is made.
    let heardWith: string | null = null;
    const publish = h.events.push.bind(h.events);
    h.events.push = (...events) => {
      if (events.at(-1)?.music?.making === null) {
        heardWith = textOf(join(h.editDir, 'preview-1x1', 'music.mp3'));
      }
      return publish(...events);
    };

    await h.service.makeAnother(h.job, 'darker');
    await until(() => expect(lastEvent(h.events)?.music?.making).toBeNull());

    expect(textOf(join(h.editDir, 'preview', 'music.mp3'))).toBe('v3 track');
    expect(textOf(join(h.editDir, 'preview-1x1', 'music.mp3'))).toBe('v3 track');
    expect(heardWith).toBe('v3 track');
    expect(h.warn).not.toHaveBeenCalled();
  });

  it('a format whose folder is not there is skipped without an error, the others are updated', async () => {
    const h = harness({ job: { formats: THREE } });
    writePreviewMusic(h.editDir, 'old');
    extraFolders(h.editDir, ['4x5']); // preview-1x1 was never built
    h.run.mockImplementation(pickingScript(h.editDir, 'v1 track'));

    const result = await h.service.pick(h.job, 'v1');

    expect(result.ok).toBe(true);
    expect(existsSync(join(h.editDir, 'preview-1x1'))).toBe(false);
    expect(textOf(join(h.editDir, 'preview-4x5', 'music.mp3'))).toBe('v1 track');
    expect(h.warn).not.toHaveBeenCalled();
  });

  it('a copy that fails is logged, leaves the other formats updated and does not fail the Pick', async () => {
    const h = harness({ job: { formats: THREE } });
    writePreviewMusic(h.editDir, 'old');
    extraFolders(h.editDir, ['4x5']);
    // preview-1x1/music.mp3 is a folder, so nothing can be moved onto it.
    mkdirSync(join(h.editDir, 'preview-1x1', 'music.mp3'), { recursive: true });
    h.run.mockImplementation(pickingScript(h.editDir, 'v1 track'));

    const result = await h.service.pick(h.job, 'v1');

    expect(result.ok && result.view.picked).toBe('v1');
    expect(textOf(join(h.editDir, 'preview-4x5', 'music.mp3'))).toBe('v1 track');
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(h.warn.mock.calls[0]?.[1]).toContain('1:1');
    // No temporary file is left behind.
    expect(readdirSync(join(h.editDir, 'preview-1x1'))).toEqual(['music.mp3']);
  });

  it('copies nothing when the script says no or never answers', async () => {
    const h = harness({ job: { formats: TWO } });
    writePreviewMusic(h.editDir, 'main');
    extraFolders(h.editDir, ['1x1'], 'stale');

    h.run.mockImplementation(async () => ranFailed('failed', 'could not pick'));
    expect((await h.service.pick(h.job, 'v1')).ok).toBe(false);
    h.run.mockImplementation(async () => ({ kind: 'timed_out' }) as MusicScriptOutcome);
    expect((await h.service.pick(h.job, 'v1')).ok).toBe(false);

    expect(textOf(join(h.editDir, 'preview-1x1', 'music.mp3'))).toBe('stale');
  });

  it('is as it was for a job with one format: no other folder is looked at', async () => {
    // No `formats` on the job, and a folder of an old two-format run is left where it is.
    const h = harness();
    writePreviewMusic(h.editDir, 'old');
    extraFolders(h.editDir, ['1x1'], 'untouched');
    const before = readdirSync(h.editDir).sort();
    h.run.mockImplementation(pickingScript(h.editDir, 'v1 track'));

    const result = await h.service.pick(h.job, 'v1');

    expect(result.ok).toBe(true);
    expect(textOf(join(h.editDir, 'preview', 'music.mp3'))).toBe('v1 track');
    expect(textOf(join(h.editDir, 'preview-1x1', 'music.mp3'))).toBe('untouched');
    expect(readdirSync(h.editDir).sort()).toEqual(before);
    expect(h.warn).not.toHaveBeenCalled();
  });
});

// --- with the real script ---------------------------------------------------------------------------

const ffmpeg = await resolveFfmpeg('ffmpeg');
const ffprobe = await resolveFfmpeg('ffprobe');
const haveTools = ffmpeg !== null && ffprobe !== null;
if (!haveTools) {
  console.warn(
    'music-service.test.ts: ffmpeg/ffprobe not found; skipping the runs of the real script (brew install ffmpeg)',
  );
}

describe.runIf(haveTools)('with the real music script on its fake path (an ffmpeg tone)', () => {
  /** A job in review whose edit run made v1, through the script itself. */
  async function jobWithV1() {
    const folder = musicJobFolder();
    folders.push(folder);
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(join(folder.editDir, 'music'), { recursive: true });
    writeFileSync(join(folder.editDir, MUSIC_FILES.plan), JSON.stringify(smallPlan()));
    const run = createMusicScriptRunner({ cwd: folder.inboxPath });
    const made = await run({
      argv: ['make', folder.editDir, '--by', 'edit', '--fake'],
      timeoutMs: 60_000,
    });
    expect(made).toMatchObject({ kind: 'ran', line: { ok: true, id: 'v1' } });
    return { folder, run };
  }

  const bytes = async (path: string) => (await import('node:fs')).readFileSync(path);

  it('Make another, Pick and No music, end to end', async () => {
    const { folder, run } = await jobWithV1();
    const events: JobMusicEvent[] = [];
    const usage = vi.fn(async () => {});
    const service = createMusicService({
      inboxPath: folder.inboxPath,
      logger: { warn: vi.fn() },
      jobs: { get: () => folder.job },
      publish: (event) => events.push(event),
      run,
      fake: true,
      usage,
    });
    const preview = join(folder.editDir, MUSIC_FILES.preview);
    const before = await service.view(folder.job);
    expect(before).toMatchObject({ picked: 'v1', canMake: true, making: null });
    expect(before?.rev).toBeGreaterThan(0);

    // Make another, with words.
    const started = await service.makeAnother(folder.job, 'darker, more drums');
    expect(started.ok && started.view.making).toMatchObject({
      id: 'v2',
      ask: 'darker, more drums',
    });
    await until(() => expect(lastEvent(events)?.music?.making).toBeNull());
    const made = readRecordFile(folder.editDir);
    expect(made.picked).toBe('v2');
    expect(made.versions.map((version) => version.id)).toEqual(['v1', 'v2']);
    expect(made.versions[1]).toMatchObject({ by: 'you', ask: 'darker, more drums', model: 'fake' });
    expect(made.versions[1]?.describe).toContain('You asked: darker, more drums.');
    expect(made.making).toBeNull();
    expect((await bytes(preview)).equals(await bytes(join(folder.editDir, 'music/v2.mp3')))).toBe(
      true,
    );
    const afterMake = await service.view(folder.job);
    expect(afterMake?.rev).toBeGreaterThanOrEqual(before?.rev ?? 0);
    expect(usage).toHaveBeenCalledTimes(1);

    // Pick v1: the preview plays v1 again, and the page's rev moves.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const picked = await service.pick(folder.job, 'v1');
    expect(picked.ok && picked.view.picked).toBe('v1');
    expect((await bytes(preview)).equals(await bytes(join(folder.editDir, 'music/v1.mp3')))).toBe(
      true,
    );
    expect(picked.ok && picked.view.rev).toBeGreaterThan(afterMake?.rev ?? 0);

    // No music: silence of the same length, still the file the composition plays.
    const off = await service.pick(folder.job, 'off');
    expect(off.ok && off.view.picked).toBe('off');
    expect(statSync(preview).size).toBeGreaterThan(0);
    expect(readRecordFile(folder.editDir).picks.map((pick) => pick.id)).toEqual([
      'v1',
      'v2',
      'v1',
      'off',
    ]);
  });

  it('keeps the other formats on the same music as the main preview, end to end (C64)', async () => {
    const { folder, run } = await jobWithV1();
    const job = { ...folder.job, formats: jobFormatsOf(['1080x1920', '1080x1080']) };
    const other = join(folder.editDir, 'preview-1x1', 'music.mp3');
    mkdirSync(join(folder.editDir, 'preview-1x1'), { recursive: true });
    writeFileSync(other, 'old track');
    const events: JobMusicEvent[] = [];
    const service = createMusicService({
      inboxPath: folder.inboxPath,
      logger: { warn: vi.fn() },
      jobs: { get: () => job },
      publish: (event) => events.push(event),
      run,
      fake: true,
    });
    const preview = join(folder.editDir, MUSIC_FILES.preview);
    const same = async () => (await bytes(other)).equals(await bytes(preview));

    await service.makeAnother(job);
    await until(() => expect(lastEvent(events)?.music?.making).toBeNull());
    expect(readRecordFile(folder.editDir).picked).toBe('v2');
    expect(await same()).toBe(true);
    expect((await bytes(other)).equals(await bytes(join(folder.editDir, 'music/v2.mp3')))).toBe(
      true,
    );

    expect((await service.pick(job, 'v1')).ok).toBe(true);
    expect(await same()).toBe(true);
    expect((await bytes(other)).equals(await bytes(join(folder.editDir, 'music/v1.mp3')))).toBe(
      true,
    );

    expect((await service.pick(job, 'off')).ok).toBe(true);
    expect(await same()).toBe(true);
    expect(statSync(other).size).toBeGreaterThan(0);
  });

  it('picks the song and the versions in turn, end to end', async () => {
    const { folder, run } = await jobWithV1();
    const service = createMusicService({
      inboxPath: folder.inboxPath,
      logger: { warn: vi.fn() },
      jobs: { get: () => folder.job },
      run,
      fake: true,
    });
    const preview = join(folder.editDir, MUSIC_FILES.preview);
    // A `song` call (SG3) records the song and its part; here the record and the file are written by hand.
    writeFileSync(join(folder.editDir, MUSIC_FILES.song), 'the song’s part');
    const part = { startMs: 1_000, endMs: 5_000, how: 'measured' } as const;
    writeRecord(folder.editDir, {
      ...readRecordFile(folder.editDir),
      song: aSong({ fullMs: 20_000, part }),
    });

    const picked = await service.pick(folder.job, 'song');
    expect(picked.ok && picked.view).toMatchObject({ picked: 'song', canMake: true });
    expect((await bytes(preview)).toString()).toBe('the song’s part');
    expect(readRecordFile(folder.editDir).picks.map((pick) => pick.id)).toEqual(['v1', 'song']);

    // A version put back leaves the song in the record, to pick again.
    const back = await service.pick(folder.job, 'v1');
    expect(back.ok && back.view).toMatchObject({ picked: 'v1' });
    expect((await bytes(preview)).equals(await bytes(join(folder.editDir, 'music/v1.mp3')))).toBe(
      true,
    );
    expect(back.ok && back.view.song?.title).toBe('נתתי לך בית');

    // No music is silence as long as the plan; the song comes back after it.
    expect((await service.pick(folder.job, 'off')).ok).toBe(true);
    const again = await service.pick(folder.job, 'song');
    expect(again.ok && again.view.picked).toBe('song');
    expect((await bytes(preview)).toString()).toBe('the song’s part');
  });

  it('puts the folder’s music file back after No music, end to end', async () => {
    const folder = musicJobFolder();
    folders.push(folder);
    const jobDir = join(folder.editDir, '..');
    const made = spawnSync(ffmpeg as string, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=330:duration=2',
      join(jobDir, 'Summer Vibes.mp3'),
    ]);
    expect(made.status).toBe(0);
    const run = createMusicScriptRunner({ cwd: folder.inboxPath });
    expect(
      await run({ argv: ['supplied', folder.editDir, 'Summer Vibes.mp3'], timeoutMs: 60_000 }),
    ).toMatchObject({ kind: 'ran', line: { ok: true, id: 'file' } });
    const service = createMusicService({
      inboxPath: folder.inboxPath,
      logger: { warn: vi.fn() },
      jobs: { get: () => folder.job },
      run,
    });
    const preview = join(folder.editDir, MUSIC_FILES.preview);

    const off = await service.pick(folder.job, 'off');
    expect(off.ok && off.view.picked).toBe('off');
    expect((await bytes(preview)).equals(await bytes(join(jobDir, 'Summer Vibes.mp3')))).toBe(
      false,
    );
    const back = await service.pick(folder.job, 'file');
    expect(back.ok && back.view).toMatchObject({ source: 'supplied', picked: 'file' });
    expect((await bytes(preview)).equals(await bytes(join(jobDir, 'Summer Vibes.mp3')))).toBe(true);
    expect(await service.pick(folder.job, 'series')).toMatchObject({ ok: false, status: 404 });
  });

  it('shows the script’s own failure from music.json when it cannot make, keeps the pick, and allows another try', async () => {
    const { folder } = await jobWithV1();
    const events: JobMusicEvent[] = [];
    const broken = createMusicService({
      inboxPath: folder.inboxPath,
      logger: { warn: vi.fn() },
      jobs: { get: () => folder.job },
      publish: (event) => events.push(event),
      // No ffmpeg to make the tone with: the script fails and writes the failure into music.json.
      run: createMusicScriptRunner({
        cwd: folder.inboxPath,
        env: { ...process.env, MUSIC_FFMPEG: '/no/such/ffmpeg' },
      }),
      fake: true,
    });

    const started = await broken.makeAnother(folder.job);
    expect(started.ok && started.view.making?.id).toBe('v2');
    await until(() => expect(lastEvent(events)?.music?.making).toBeNull());

    const failed = lastEvent(events)?.music;
    expect(failed).toMatchObject({
      picked: 'v1',
      failure: { id: 'v2', code: 'failed' },
      canMake: true,
    });
    expect(failed?.versions.map((version) => version.id)).toEqual(['v1']);
    expect(readRecordFile(folder.editDir).failure?.id).toBe('v2');

    // Another try, with ffmpeg: makes the same id, and the failure is gone.
    const working = createMusicService({
      inboxPath: folder.inboxPath,
      logger: { warn: vi.fn() },
      jobs: { get: () => folder.job },
      publish: (event) => events.push(event),
      run: createMusicScriptRunner({ cwd: folder.inboxPath }),
      fake: true,
    });
    await working.makeAnother(folder.job);
    await until(() => expect(lastEvent(events)?.music?.picked).toBe('v2'));
    expect(lastEvent(events)?.music).toMatchObject({ failure: null, making: null });
  });
});
