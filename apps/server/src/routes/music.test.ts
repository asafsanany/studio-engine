import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  apiErrorSchema,
  type Job,
  type JobEvent,
  type JobMusicEvent,
  MUSIC_FILES,
  MUSIC_MESSAGES,
  musicRecordSchema,
  musicResponseSchema,
} from '@studio/shared';
import type { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { JobRepository, type StudioDb } from '../db/index.js';
import { makeScan, memoryDb, SAMPLE_PREVIEW } from '../db/test-utils.js';
import type { MusicScriptRunner } from '../music/music-script.js';
import { createMusicService } from '../music/music-service.js';
import { ranOk } from '../music/test-utils.js';

// The music routes (Soundtrack): 404 "Music is off." for every music path while the switch is off;
// while it is on, GET reads the job's music.json (the fixture of the plan page's example), POST
// is Make another (202, in the background) and PUT /pick is Pick, both only while the job waits
// for review. The music script is a stand-in here; music-service.test.ts runs the real one.

const FIXTURE = fileURLToPath(new URL('../music/testdata/music.json', import.meta.url));

const REVIEW_PATH: JobEvent[] = [
  { type: 'SETTLED' },
  { type: 'START' },
  { type: 'PREVIEW_READY', preview: SAMPLE_PREVIEW },
];

const dirs: string[] = [];
const opened: StudioDb[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) if (db.sqlite.open) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  app: Hono;
  jobs: JobRepository;
  job: Job;
  editDir: string;
  warn: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn<MusicScriptRunner>>;
  events: JobMusicEvent[];
}

/** A job `Horizon FPV / Demo` (in review unless `path` says otherwise) and the routes on a stand-in script. */
function harness({
  music = true,
  path = REVIEW_PATH,
}: {
  music?: boolean;
  path?: JobEvent[];
} = {}): Harness {
  const base = mkdtempSync(join(tmpdir(), 'studio-music-routes-'));
  dirs.push(base);
  const inboxPath = join(base, 'inbox');
  const db = memoryDb();
  opened.push(db);
  const jobs = new JobRepository(db);
  const { job: scanned } = jobs.upsertFromScan(makeScan('Horizon FPV', 'Demo'));
  let job = scanned;
  for (const event of path) job = jobs.applyTransition(job.id, event);
  const editDir = join(inboxPath, job.relPath, 'edit');
  mkdirSync(join(editDir, 'music'), { recursive: true });
  const warn = vi.fn();
  const events: JobMusicEvent[] = [];
  const run = vi.fn<MusicScriptRunner>(async () => ranOk('v3'));
  const app = createApp({
    music,
    musicRoutes: {
      jobs,
      music: createMusicService({
        inboxPath,
        logger: { warn },
        jobs,
        publish: (event) => events.push(event),
        run,
      }),
    },
  });
  return { app, jobs, job, editDir, warn, run, events };
}

const send = (app: Hono, path: string, init?: RequestInit) => app.request(path, init);
const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const put = (body: unknown): RequestInit => json(body, 'PUT');

async function errorOf(res: Response): Promise<string> {
  return apiErrorSchema.parse(await res.json()).error;
}

describe('with the switch off', () => {
  it.each([
    ['GET', '/music'],
    ['POST', '/music'],
    ['PUT', '/music/pick'],
    ['GET', '/music/anything/else'],
  ])('%s %s answers 404 "Music is off."', async (method, tail) => {
    for (const app of [createApp(), harness({ music: false }).app]) {
      const res = await send(app, `/api/jobs/a1b2c3d4e5f6${tail}`, { method });
      expect(res.status).toBe(404);
      expect(await errorOf(res)).toBe(MUSIC_MESSAGES.off);
    }
  });

  it('leaves the other job routes alone', async () => {
    const res = await createApp().request('/api/jobs/a1b2c3d4e5f6/musical');
    expect(res.status).toBe(404);
    expect(await errorOf(res)).toBe('Not found');
  });
});

describe('GET /api/jobs/:id/music', () => {
  it('reads the job’s music.json: the record, canMake, whyNot and rev', async () => {
    const { app, job, editDir, warn } = harness();
    copyFileSync(FIXTURE, join(editDir, MUSIC_FILES.record));
    mkdirSync(join(editDir, 'preview'), { recursive: true });
    writeFileSync(join(editDir, MUSIC_FILES.preview), 'mp3');
    const mtime = Math.floor(statSync(join(editDir, MUSIC_FILES.preview)).mtimeMs);

    const res = await send(app, `/api/jobs/${job.id}/music`);
    expect(res.status).toBe(200);
    const view = musicResponseSchema.parse(await res.json());
    const record = musicRecordSchema.parse(JSON.parse(readFileSync(FIXTURE, 'utf8')));
    expect(view).toEqual({ ...record, canMake: true, whyNot: null, rev: mtime });
    expect(view?.picked).toBe('v2');
    expect(warn).not.toHaveBeenCalled();
  });

  it('says rev 0 while there is no music.mp3', async () => {
    const { app, job, editDir } = harness();
    copyFileSync(FIXTURE, join(editDir, MUSIC_FILES.record));
    const view = musicResponseSchema.parse(
      await (await send(app, `/api/jobs/${job.id}/music`)).json(),
    );
    expect(view?.rev).toBe(0);
  });

  it('answers null for a job without music.json', async () => {
    const { app, job, warn } = harness();
    const res = await send(app, `/api/jobs/${job.id}/music`);
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('answers null for a music.json it cannot use, and says so in the log', async () => {
    const { app, job, editDir, warn } = harness();
    for (const bad of ['{not json', JSON.stringify({ v: 2 })]) {
      writeFileSync(join(editDir, MUSIC_FILES.record), bad);
      const res = await send(app, `/api/jobs/${job.id}/music`);
      expect(res.status).toBe(200);
      expect(await res.json()).toBeNull();
    }
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ jobId: job.id });
  });

  it('answers 404 for a job the engine does not know', async () => {
    const res = await send(harness().app, '/api/jobs/nope/music');
    expect(res.status).toBe(404);
    expect(await errorOf(res)).toBe('Job nope not found');
  });
});

describe('GET: what the job may do', () => {
  it('says why not, in plain words, when the job is not waiting for review or is an episode', async () => {
    const editing = harness({ path: [{ type: 'SETTLED' }, { type: 'START' }] });
    copyFileSync(FIXTURE, join(editing.editDir, MUSIC_FILES.record));
    const view = musicResponseSchema.parse(
      await (await send(editing.app, `/api/jobs/${editing.job.id}/music`)).json(),
    );
    expect(view).toMatchObject({
      canMake: false,
      whyNot: 'Music can be changed while the video waits for your review.',
    });
  });
});

describe('POST /api/jobs/:id/music (Make another)', () => {
  it('answers 202 with the view, now making the next version, with words or without', async () => {
    for (const init of [{ method: 'POST' }, json({}), json({ ask: 'darker, more drums' })]) {
      const { app, job, editDir, run } = harness();
      copyFileSync(FIXTURE, join(editDir, MUSIC_FILES.record));
      const res = await send(app, `/api/jobs/${job.id}/music`, init);
      expect(res.status).toBe(202);
      const view = musicResponseSchema.parse(await res.json());
      expect(view).toMatchObject({
        making: { id: 'v3' },
        canMake: false,
        whyNot: 'Music v3 is still being made.',
        picked: 'v2',
      });
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    }
  });

  it('passes the words, trimmed, to the script; blank words are no words', async () => {
    const { app, job, editDir, run } = harness();
    copyFileSync(FIXTURE, join(editDir, MUSIC_FILES.record));
    const res = await send(app, `/api/jobs/${job.id}/music`, json({ ask: '  calmer  ' }));
    expect(musicResponseSchema.parse(await res.json())?.making?.ask).toBe('calmer');
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(run.mock.calls[0]?.[0].argv).toEqual([
      'make',
      editDir,
      '--again',
      '--ask',
      'calmer',
      '--by',
      'you',
    ]);

    const blank = harness();
    copyFileSync(FIXTURE, join(blank.editDir, MUSIC_FILES.record));
    const again = await send(blank.app, `/api/jobs/${blank.job.id}/music`, json({ ask: '   ' }));
    expect(musicResponseSchema.parse(await again.json())?.making?.ask).toBeNull();
  });

  it('answers 409 with the reason while a version is being made', async () => {
    const { app, job, editDir, run } = harness();
    copyFileSync(FIXTURE, join(editDir, MUSIC_FILES.record));
    run.mockImplementation(() => new Promise(() => {}));
    expect((await send(app, `/api/jobs/${job.id}/music`, json({}))).status).toBe(202);

    const second = await send(app, `/api/jobs/${job.id}/music`, json({}));
    expect(second.status).toBe(409);
    expect(await errorOf(second)).toBe('Music v3 is still being made.');
  });

  it.each([
    ['the job is editing', { path: [{ type: 'SETTLED' }, { type: 'START' }] }, true, 'review'],
    ['the job is queued', { path: [{ type: 'SETTLED' }] }, true, 'review'],
    ['the job has no music.json (no plan)', {}, false, 'plan'],
  ] as const)('answers 409 with the reason when %s', async (_name, options, withRecord, why) => {
    const { app, job, editDir, run } = harness(options as { path?: JobEvent[] });
    if (withRecord) copyFileSync(FIXTURE, join(editDir, MUSIC_FILES.record));

    const res = await send(app, `/api/jobs/${job.id}/music`, json({}));

    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe(
      why === 'review' ? MUSIC_MESSAGES.notInReview : MUSIC_MESSAGES.noPlan,
    );
    expect(run).not.toHaveBeenCalled();
  });

  it('answers 409 for an episode of a series', async () => {
    const { app, job, editDir, jobs } = harness();
    copyFileSync(FIXTURE, join(editDir, MUSIC_FILES.record));
    jobs.setSeries(job.id, { seriesId: 'series-1', episode: 4, pinned: false });
    const res = await send(app, `/api/jobs/${job.id}/music`, json({}));
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe('Episodes play the series’ music.');
  });

  it('refuses a body it cannot read with 400, and an unknown job with 404', async () => {
    const { app, job } = harness();
    for (const init of [
      { method: 'POST', body: '{nope' },
      json({ ask: 'x'.repeat(201) }),
      json({ ask: 5 }),
    ]) {
      expect(
        (await send(app, `/api/jobs/${job.id}/music`, init)).status,
        JSON.stringify(init),
      ).toBe(400);
    }
    expect((await send(app, '/api/jobs/nope/music', json({}))).status).toBe(404);
  });
});

describe('PUT /api/jobs/:id/music/pick', () => {
  it('picks a version or off and answers the view', async () => {
    const { app, job, editDir, run } = harness();
    copyFileSync(FIXTURE, join(editDir, MUSIC_FILES.record));
    run.mockImplementation(async (call) => {
      const id = call.argv[2];
      const record = musicRecordSchema.parse(
        JSON.parse(readFileSync(join(editDir, MUSIC_FILES.record), 'utf8')),
      );
      writeFileSync(join(editDir, MUSIC_FILES.record), JSON.stringify({ ...record, picked: id }));
      return ranOk(id ?? 'v1');
    });

    for (const id of ['v1', 'off']) {
      const res = await send(app, `/api/jobs/${job.id}/music/pick`, put({ id }));
      expect(res.status).toBe(200);
      expect(musicResponseSchema.parse(await res.json())?.picked).toBe(id);
    }
    expect(
      run.mock.calls.map((call) => call[0].argv.slice(0, 1).concat(call[0].argv.slice(2))),
    ).toEqual([
      ['pick', 'v1'],
      ['pick', 'off'],
    ]);
  });

  it('picks the folder’s music file again after off, and answers 404 for music the job did not bring', async () => {
    const { app, job, editDir, run } = harness();
    const supplied = {
      ...musicRecordSchema.parse(JSON.parse(readFileSync(FIXTURE, 'utf8'))),
      source: 'supplied' as const,
      file: 'Summer Vibes.mp3',
      plan: null,
      versions: [],
      picked: 'off' as const,
      picks: [],
    };
    writeFileSync(join(editDir, MUSIC_FILES.record), JSON.stringify(supplied));
    run.mockImplementation(async (call) => {
      writeFileSync(
        join(editDir, MUSIC_FILES.record),
        JSON.stringify({ ...supplied, picked: call.argv[2] }),
      );
      return ranOk(call.argv[2] ?? 'file');
    });

    const res = await send(app, `/api/jobs/${job.id}/music/pick`, put({ id: 'file' }));
    expect(res.status).toBe(200);
    expect(musicResponseSchema.parse(await res.json())?.picked).toBe('file');
    expect(run.mock.calls.map((call) => call[0].argv.slice(2))).toEqual([['file']]);

    for (const id of ['series', 'v1']) {
      const missing = await send(app, `/api/jobs/${job.id}/music/pick`, put({ id }));
      expect(missing.status, id).toBe(404);
      expect(await errorOf(missing)).toBe(MUSIC_MESSAGES.noSuchVersion);
    }
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('answers 404 for a version the job does not have, and 409 when the job is not in review', async () => {
    const { app, job, editDir } = harness();
    copyFileSync(FIXTURE, join(editDir, MUSIC_FILES.record));
    const missing = await send(app, `/api/jobs/${job.id}/music/pick`, put({ id: 'v9' }));
    expect(missing.status).toBe(404);
    expect(await errorOf(missing)).toBe(MUSIC_MESSAGES.noSuchVersion);

    const editing = harness({ path: [{ type: 'SETTLED' }, { type: 'START' }] });
    copyFileSync(FIXTURE, join(editing.editDir, MUSIC_FILES.record));
    const refused = await send(
      editing.app,
      `/api/jobs/${editing.job.id}/music/pick`,
      put({ id: 'v1' }),
    );
    expect(refused.status).toBe(409);
    expect(await errorOf(refused)).toBe(MUSIC_MESSAGES.notInReview);
    expect(editing.run).not.toHaveBeenCalled();
  });

  it('answers 409 with the reason while a version is being made', async () => {
    const { app, job, editDir, run } = harness();
    copyFileSync(FIXTURE, join(editDir, MUSIC_FILES.record));
    run.mockImplementation(() => new Promise(() => {}));
    await send(app, `/api/jobs/${job.id}/music`, json({}));

    const res = await send(app, `/api/jobs/${job.id}/music/pick`, put({ id: 'v1' }));
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe('Music v3 is still being made.');
  });

  it('refuses a body it cannot read with 400, and an unknown job with 404', async () => {
    const { app, job } = harness();
    for (const init of [put({ id: 'none' }), put({ id: 'v0' }), put({}), { method: 'PUT' }]) {
      expect(
        (await send(app, `/api/jobs/${job.id}/music/pick`, init)).status,
        JSON.stringify(init),
      ).toBe(400);
    }
    expect((await send(app, '/api/jobs/nope/music/pick', put({ id: 'v1' }))).status).toBe(404);
  });
});
