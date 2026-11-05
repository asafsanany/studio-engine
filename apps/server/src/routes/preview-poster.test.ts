import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { apiErrorSchema, type Job } from '@studio/shared';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { firstVideoSrc, JobStills, POSTER_PATH } from '../clients/job-still.js';
import { JobRepository, type StudioDb } from '../db/index.js';
import { fakeClock, makeScan, memoryDb } from '../db/test-utils.js';
import { resolveFfmpeg, runFfmpeg } from '../pipeline/fake-media.js';
import { NO_POSTER_MESSAGE } from './preview.js';

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// The preview's poster: GET /api/jobs/:id/preview-poster, over the real job repository (in
// memory) and a temp inbox. The frames are made by the real ffmpeg when the machine has it.

const ffmpeg = await resolveFfmpeg('ffmpeg');

let root: string;
let inboxPath: string;
let db: StudioDb;
let jobs: JobRepository;
let app: Hono;

function build(posters = new JobStills({ inboxPath, exportsDir: join(inboxPath, '_Exports') })) {
  return createApp({ preview: { jobs, inboxPath, posters } });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'studio-preview-poster-'));
  inboxPath = join(root, 'inbox');
  db = memoryDb();
  jobs = new JobRepository(db, { clock: fakeClock() });
  app = build();
});

afterEach(() => {
  if (db.sqlite.open) db.close();
  rmSync(root, { recursive: true, force: true });
});

/** A job of Acme whose folder exists; its edit/preview/index.html is `html` when given. */
function job(html?: string, name = 'Promo'): Job {
  const { job: scanned } = jobs.upsertFromScan(makeScan('Acme', name));
  const preview = join(inboxPath, scanned.relPath, 'edit', 'preview');
  mkdirSync(preview, { recursive: true });
  if (html !== undefined) writeFileSync(join(preview, 'index.html'), html);
  return scanned;
}

const previewFile = (j: Job, name: string) => join(inboxPath, j.relPath, 'edit', 'preview', name);
const poster = (id: string) => Promise.resolve(app.request(`/api/jobs/${id}/preview-poster`));

const PAGE = `<!doctype html><html><body>
<div data-composition-id="main">
  <video id="broll" class="clip" src="broll.mp4" data-start="4" playsinline></video>
  <video id="cut" class="clip" src="cut.mp4" data-start="0" data-duration="3" playsinline></video>
  <audio src="music.m4a" data-start="0"></audio>
</div></body></html>`;

describe('firstVideoSrc', () => {
  it('takes the video that starts at 0, before an earlier tag that starts later', () => {
    expect(firstVideoSrc(PAGE)).toBe('cut.mp4');
  });

  it('takes the first video when none says it starts at 0, in either kind of quotes', () => {
    expect(firstVideoSrc(`<video data-start='2' src='a.mp4'></video><video src="b.mp4">`)).toBe(
      'a.mp4',
    );
  });

  it('is null for a page with no video, and skips one with no src or a full URL', () => {
    expect(firstVideoSrc('<audio src="music.m4a"></audio>')).toBeNull();
    expect(firstVideoSrc('<video data-start="0"></video>')).toBeNull();
    expect(firstVideoSrc('<video src="https://cdn.example/a.mp4"></video>')).toBeNull();
  });
});

describe('GET /api/jobs/:id/preview-poster', () => {
  it('answers 404 for an unknown job, a job with no preview, and a preview with no video', async () => {
    expect((await poster('nope')).status).toBe(404);

    const none = job();
    const noPreview = await poster(none.id);
    expect(noPreview.status).toBe(404);
    expect(apiErrorSchema.parse(await noPreview.json()).error).toBe(NO_POSTER_MESSAGE);

    const audioOnly = job('<audio src="music.m4a"></audio>', 'Audio only');
    expect((await poster(audioOnly.id)).status).toBe(404);
  });

  it('answers 404 while the video the page names is not there', async () => {
    const j = job(PAGE);
    expect((await poster(j.id)).status).toBe(404);
  });

  it('answers 500 when there is no ffmpeg to make it', async () => {
    app = build(new JobStills({ inboxPath, exportsDir: root, ffmpegBin: join(root, 'no-ffmpeg') }));
    const j = job(PAGE);
    writeFileSync(previewFile(j, 'cut.mp4'), 'not really a video');
    const res = await poster(j.id);
    expect(res.status).toBe(500);
    expect(apiErrorSchema.parse(await res.json()).error).toMatch(/ffmpeg was not found/);
  });

  it('answers 404 without a poster maker (the engine always passes one)', async () => {
    app = createApp({ preview: { jobs, inboxPath } });
    expect((await poster(job(PAGE).id)).status).toBe(404);
  });

  describe.skipIf(ffmpeg === null)('with ffmpeg', () => {
    /** 3 s, 1080×1920: green for 1 s, then blue. The first frame is green. */
    async function makeCut(path: string): Promise<void> {
      mkdirSync(dirname(path), { recursive: true });
      const result = await runFfmpeg(
        { bin: ffmpeg as string, signal: new AbortController().signal, killGraceMs: 1_000 },
        [
          '-f',
          'lavfi',
          '-i',
          'color=c=green:s=1080x1920:r=25:d=1',
          '-f',
          'lavfi',
          '-i',
          'color=c=blue:s=1080x1920:r=25:d=2',
          '-filter_complex',
          '[0:v][1:v]concat=n=2:v=1:a=0',
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
          '-pix_fmt',
          'yuv420p',
          '-y',
          path,
        ],
      );
      expect(result).toEqual({ status: 'ok' });
    }

    /** The width and height of a picture, and the colour of its middle pixel, by ffmpeg. */
    function look(path: string): { width: number; height: number; middle: number[] } {
      const ffprobe = join(dirname(ffmpeg as string), 'ffprobe');
      const [width, height] = execFileSync(ffprobe, [
        '-v',
        'error',
        '-show_entries',
        'stream=width,height',
        '-of',
        'csv=p=0',
        path,
      ])
        .toString()
        .trim()
        .split(',')
        .map(Number) as [number, number];
      const pixel = execFileSync(ffmpeg as string, [
        '-v',
        'error',
        '-i',
        path,
        '-vf',
        `crop=16:16:${Math.floor(width / 2) - 8}:${Math.floor(height / 2) - 8},scale=1:1`,
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        '-',
      ]);
      return { width, height, middle: [...pixel] };
    }

    it('is the first frame of the video the page starts with, 720 px wide, kept as edit/poster.jpg', async () => {
      const j = job(PAGE);
      await makeCut(previewFile(j, 'cut.mp4'));

      const res = await poster(j.id);

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/jpeg');
      expect(res.headers.get('cache-control')).toBe('no-cache');
      const bytes = Buffer.from(await res.arrayBuffer());
      expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xd8]);
      const kept = join(inboxPath, j.relPath, POSTER_PATH);
      expect(readFileSync(kept)).toEqual(bytes);
      const { width, height, middle } = look(kept);
      expect([width, height]).toEqual([720, 1280]);
      // Green, the colour at 0 s.
      const [red, green, blue] = middle as [number, number, number];
      expect(green).toBeGreaterThan(80);
      expect(red).toBeLessThan(60);
      expect(blue).toBeLessThan(60);
    });

    it('serves the kept poster again, and makes it anew once the video is newer', async () => {
      const j = job(PAGE);
      const cut = previewFile(j, 'cut.mp4');
      await makeCut(cut);
      expect((await poster(j.id)).status).toBe(200);
      const kept = join(inboxPath, j.relPath, POSTER_PATH);
      const first = statSync(kept).mtimeMs;

      expect((await poster(j.id)).status).toBe(200);
      expect(statSync(kept).mtimeMs).toBe(first);

      // A new round writes a new cut.
      const later = new Date(first + 60_000);
      utimesSync(cut, later, later);
      expect((await poster(j.id)).status).toBe(200);
      expect(statSync(kept).mtimeMs).toBeGreaterThan(first);
    });
  });
});
