import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  apiErrorSchema,
  type Job,
  type JobEvent,
  NO_SONG_MESSAGES,
  noSongStatusSchema,
} from '@studio/shared';
import type { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { NoSongExports } from '../clients/no-song-export.js';
import { JobRepository } from '../db/index.js';
import { makeScan, memoryDb } from '../db/test-utils.js';
import { songRecord, writeRecord, writeToneMp3 } from '../music/test-utils.js';
import { resolveFfmpeg } from '../pipeline/fake-media.js';
import { makeTempDir } from '../test-temp.js';

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// GET and POST /api/jobs/:id/no-song, `?file=no-song` of the download, and what deleting a job does
// to the second export (Songs, SG8): the real repository on an in-memory database, the real
// routes, the real service with a fake render, and the files on a real temp folder.

const ffmpeg = await resolveFfmpeg('ffmpeg');
const haveTools = ffmpeg !== null && (await resolveFfmpeg('ffprobe')) !== null;

const READY: JobEvent[] = [
  { type: 'SETTLED' },
  { type: 'START' },
  {
    type: 'SUCCEED',
    output: {
      fileName: 'Northwind Bakery/Spring menu.mp4',
      durationSec: 2.5,
      width: 1080,
      height: 1920,
      sizeBytes: 1000,
    },
  },
];

interface Harness {
  app: Hono;
  jobs: JobRepository;
  inbox: string;
  exports: string;
  noSong: NoSongExports;
  renders: number;
}

function harness({
  songs = true,
  render,
}: {
  songs?: boolean;
  render?: (cwd: string, out: string, signal: AbortSignal) => Promise<void>;
} = {}): Harness {
  const inbox = makeTempDir('studio-no-song-routes-');
  const exports = join(inbox, '_Exports');
  const jobs = new JobRepository(memoryDb());
  const state = { renders: 0 };
  const noSong = new NoSongExports({
    inboxPath: inbox,
    exportsDir: exports,
    render:
      render ??
      (async (_cwd, out) => {
        state.renders += 1;
        writeFileSync(out, `no song video ${state.renders}`);
      }),
  });
  const app = createApp({
    songs,
    music: true,
    jobs: { jobs, exportsDir: exports, inboxPath: inbox, ...(songs ? { noSong } : {}) },
    ...(songs ? { noSongRoutes: { jobs, noSong } } : {}),
  });
  return {
    app,
    jobs,
    inbox,
    exports,
    noSong,
    get renders() {
      return state.renders;
    },
  };
}

/** A ready job whose music is the song, with its preview, its music and its export on disk. */
function readyJob(h: Harness, { song = true }: { song?: boolean } = {}): Job {
  const { job } = h.jobs.upsertFromScan(makeScan('Northwind Bakery', 'Spring menu'));
  for (const event of READY) h.jobs.applyTransition(job.id, event);
  const jobDir = join(h.inbox, job.relPath);
  const preview = join(jobDir, 'edit', 'preview');
  mkdirSync(preview, { recursive: true });
  writeFileSync(join(preview, 'index.html'), '<html></html>');
  if (ffmpeg !== null) writeToneMp3(ffmpeg, join(preview, 'music.mp3'));
  if (song) writeRecord(join(jobDir, 'edit'), songRecord());
  mkdirSync(join(h.exports, 'Northwind Bakery'), { recursive: true });
  writeFileSync(join(h.exports, 'Northwind Bakery', 'Spring menu.mp4'), 'with the song');
  return h.jobs.get(job.id) as Job;
}

const get = (h: Harness, job: Job) => h.app.request(`/api/jobs/${job.id}/no-song`);
const post = (h: Harness, job: Job) =>
  h.app.request(`/api/jobs/${job.id}/no-song`, { method: 'POST' });
const download = (h: Harness, job: Job, query = '?file=no-song', init: RequestInit = {}) =>
  h.app.request(`/api/jobs/${job.id}/download${query}`, init);
const secondFile = (h: Harness) => join(h.exports, 'Northwind Bakery', 'Spring menu · no song.mp4');

describe('with Songs off', () => {
  it('has no such route, and ?file=no-song downloads the normal export as it always did', async () => {
    const h = harness({ songs: false });
    const job = readyJob(h);

    expect((await get(h, job)).status).toBe(404);
    expect((await post(h, job)).status).toBe(404);
    const res = await download(h, job);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('with the song');
  });
});

describe.skipIf(!haveTools)('GET and POST /api/jobs/:id/no-song', () => {
  it('404s an unknown job', async () => {
    const h = harness();
    for (const res of [
      await h.app.request('/api/jobs/nope/no-song'),
      await h.app.request('/api/jobs/nope/no-song', { method: 'POST' }),
    ]) {
      expect(res.status).toBe(404);
      apiErrorSchema.parse(await res.json());
    }
  });

  it('says none for a job with no second file, and refuses to make one', async () => {
    const h = harness();
    const aVersion = readyJob(h, { song: false });
    const res = await get(h, aVersion);
    expect(res.status).toBe(200);
    expect(noSongStatusSchema.parse(await res.json())).toEqual({ state: 'none' });

    const refused = await post(h, aVersion);
    expect(refused.status).toBe(409);
    expect(apiErrorSchema.parse(await refused.json())).toEqual({
      error: NO_SONG_MESSAGES.nothingToMake,
    });
    expect(h.renders).toBe(0);
  });

  it('says idle, starts on POST (Try again), then ready with the file name and the time, and not where it is', async () => {
    const h = harness();
    const job = readyJob(h);
    expect(noSongStatusSchema.parse(await (await get(h, job)).json())).toEqual({ state: 'idle' });
    // Asking never starts it.
    expect(h.renders).toBe(0);

    const started = await post(h, job);
    expect(started.status).toBe(200);
    expect(noSongStatusSchema.parse(await started.json())).toEqual({ state: 'making' });
    await h.noSong.idle(job.id);

    const ready = await get(h, job);
    expect(ready.headers.get('cache-control')).toBe('no-store');
    const body = noSongStatusSchema.parse(await ready.json());
    expect(body).toMatchObject({ state: 'ready', file: 'Spring menu · no song.mp4' });
    expect(Object.keys(body).sort()).toEqual(['at', 'file', 'state']);
    expect(h.renders).toBe(1);

    // Asking again to make it costs nothing.
    expect(noSongStatusSchema.parse(await (await post(h, job)).json())).toMatchObject({
      state: 'ready',
    });
    expect(h.renders).toBe(1);
  });

  it('says why it failed, with the words, and POST tries again', async () => {
    let fail = true;
    const h = harness({
      render: async (_cwd, out) => {
        if (fail) throw new Error('Chrome crashed');
        writeFileSync(out, 'video');
      },
    });
    const job = readyJob(h);
    await post(h, job);
    await h.noSong.idle(job.id);

    expect(noSongStatusSchema.parse(await (await get(h, job)).json())).toEqual({
      state: 'failed',
      message: 'The file without the song could not be made: Chrome crashed',
    });
    // The job is Approved all the same.
    expect(h.jobs.get(job.id)?.state).toBe('ready');

    fail = false;
    await post(h, job);
    await h.noSong.idle(job.id);
    expect(noSongStatusSchema.parse(await (await get(h, job)).json()).state).toBe('ready');
  });
});

describe.skipIf(!haveTools)('GET /api/jobs/:id/download?file=no-song', () => {
  it('404s until the file is made, then serves it as an attachment named for the job, with byte ranges', async () => {
    const h = harness();
    const job = readyJob(h);

    const early = await download(h, job);
    expect(early.status).toBe(404);
    expect(apiErrorSchema.parse(await early.json())).toEqual({ error: NO_SONG_MESSAGES.noFile });

    await post(h, job);
    await h.noSong.idle(job.id);

    const res = await download(h, job);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(res.headers.get('content-disposition')).toContain(
      `filename*=UTF-8''${encodeURIComponent('Spring menu · no song.mp4')}`,
    );
    expect(await res.text()).toBe('no song video 1');

    const part = await download(h, job, '?file=no-song', { headers: { Range: 'bytes=3-6' } });
    expect(part.status).toBe(206);
    expect(await part.text()).toBe('song');

    // The same path without the query is the normal export, as ever.
    const normal = await download(h, job, '');
    expect(await normal.text()).toBe('with the song');
    expect((await download(h, job, '?file=other')).status).toBe(200);
  });

  it('serves nothing for a job whose music is not the song', async () => {
    const h = harness();
    const job = readyJob(h, { song: false });
    expect((await download(h, job)).status).toBe(404);
  });
});

describe.skipIf(!haveTools)('DELETE /api/jobs/:id', () => {
  it('removes the file without the song with the export, and stops a render under way', async () => {
    let aborted = false;
    let started = false;
    const h = harness({
      render: (_cwd, _out, signal) =>
        new Promise<void>((_resolve, reject) => {
          started = true;
          signal.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('stopped'));
          });
        }),
    });
    const made = readyJob(h);
    // A file made earlier sits next to the export.
    writeFileSync(secondFile(h), 'made earlier');
    await post(h, made);
    await vi.waitFor(() => expect(started).toBe(true));
    const jobDir = join(h.inbox, made.relPath);
    expect(existsSync(join(jobDir, 'edit', '.preview-no-song.tmp'))).toBe(true);

    const res = await h.app.request(`/api/jobs/${made.id}`, { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(aborted).toBe(true);
    expect(existsSync(jobDir)).toBe(false);
    expect(readdirSync(join(h.exports, 'Northwind Bakery'))).toEqual([]);
    expect(h.jobs.get(made.id)).toBeNull();
  });

  it('leaves a file called “· no song” alone when Songs is off', async () => {
    const h = harness({ songs: false });
    const job = readyJob(h);
    writeFileSync(secondFile(h), 'someone’s own file');
    await h.app.request(`/api/jobs/${job.id}`, { method: 'DELETE' });
    expect(readFileSync(secondFile(h), 'utf8')).toBe('someone’s own file');
    expect(existsSync(join(h.exports, 'Northwind Bakery', 'Spring menu.mp4'))).toBe(false);
  });
});
