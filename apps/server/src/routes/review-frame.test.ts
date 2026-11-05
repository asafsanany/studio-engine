import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { type Job, LUT_MESSAGES, type LutKind } from '@studio/shared';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import type { PreviewVideoStatus, PreviewVideos } from '../clients/preview-video.js';
import { JobRepository, type StudioDb } from '../db/index.js';
import { LutRepository } from '../db/lut-repository.js';
import { fakeClock, makeScan, memoryDb } from '../db/test-utils.js';
import { createBuiltInLuts } from '../luts/lut-builtin.js';
import { lutFramePath } from '../luts/lut-frames.js';
import { createDisabledLutService } from '../luts/lut-service.js';
import {
  cubeText,
  hasCommand,
  hasFfmpeg,
  identity,
  invert,
  jpegSize,
  writeFakeSkill,
} from '../luts/lut-test-utils.js';
import {
  createFakeReviewFrames,
  createRealReviewFrames,
  type ReviewFrames,
  reviewFramesRoot,
} from '../luts/review-frames.js';
import { makeTempDir } from '../test-temp.js';

vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// The look on the paused frame (LU11): GET /api/jobs/:id/review/frame, over the real job and LUT
// repositories (in memory), a temp inbox and data folder, the fake skill, and either the fake frame
// maker (no ffmpeg at all) or the real one on a clip made here with ffmpeg (skipped without ffmpeg).

const ffmpegHere = hasFfmpeg();

let root: string;
let inboxPath: string;
let dataDir: string;
let db: StudioDb;
let jobs: JobRepository;
let luts: LutRepository;

beforeEach(() => {
  root = makeTempDir('studio-review-frame-');
  inboxPath = join(root, 'inbox');
  dataDir = join(root, 'data');
  mkdirSync(join(inboxPath, '_LUTs'), { recursive: true });
  db = memoryDb();
  jobs = new JobRepository(db, { clock: fakeClock() });
  luts = new LutRepository(db);
});

afterEach(() => {
  if (db.sqlite.open) db.close();
});

/** A job of Acme whose folder has a preview composition (and `video` as its small preview video). */
function job(options: { composition?: boolean; name?: string } = {}): Job {
  const { job: scanned } = jobs.upsertFromScan(makeScan('Acme', options.name ?? 'Promo'));
  const preview = join(inboxPath, scanned.relPath, 'edit', 'preview');
  mkdirSync(preview, { recursive: true });
  if (options.composition !== false) writeFileSync(join(preview, 'index.html'), '<html></html>');
  return scanned;
}

/** A LUT of Yours: its file in _LUTs and its row. */
function addLut(name: string, kind: LutKind = 'look', fn = invert) {
  const file = `${name}.cube`;
  writeFileSync(join(inboxPath, '_LUTs', file), cubeText(9, fn));
  return luts.create({
    name,
    kind,
    size: 9,
    file,
    bytes: 100,
    sha256: `${name.length.toString(16).padStart(2, '0')}${'c0ffee'.repeat(10)}`,
    sourceName: file,
  });
}

function build(frames: ReviewFrames, options: { switches?: boolean } = {}): Hono {
  const builtIn = createBuiltInLuts({
    skillDir: writeFakeSkill(join(root, 'skill')),
    dataDir,
    python: 'python3',
  });
  return createApp({
    luts: options.switches !== false,
    lutsInEdits: options.switches !== false,
    lutsRoutes: {
      luts: { service: createDisabledLutService() },
      previews: {
        luts,
        builtIn,
        previews: { still: async () => '', warm: () => {} },
        inboxPath,
      },
    },
    reviewFrame: { jobs, luts, builtIn, inboxPath, frames },
  });
}

const bytesOf = async (res: Response) => Buffer.from(await res.arrayBuffer());

describe('the fake frame maker (no ffmpeg, no video)', () => {
  let app: Hono;
  const get = (path: string, headers: Record<string, string> = {}) =>
    Promise.resolve(app.request(path, { headers }));

  beforeEach(() => {
    app = build(createFakeReviewFrames({ dataDir, inboxPath }));
  });

  it('answers the plain frame, and with a LUT a visibly different one', async () => {
    const { id } = job();
    addLut('Golden Hour Warm');

    const plain = await get(`/api/jobs/${id}/review/frame?t=3.2`);
    const graded = await get(`/api/jobs/${id}/review/frame?t=3.2&lut=golden-hour-warm`);

    expect(plain.status).toBe(200);
    expect(plain.headers.get('content-type')).toBe('image/jpeg');
    expect((await bytesOf(plain)).equals(readFileSync(lutFramePath('person')))).toBe(true);
    expect(graded.status).toBe(200);
    expect((await bytesOf(graded)).equals(readFileSync(lutFramePath('person', true)))).toBe(true);
  });

  it('runs a built-in LUT, Cinematic’s baked cube included', async () => {
    const { id } = job();
    for (const slug of [
      'film-contrast',
      'red-skin-fix',
      ...(hasCommand('python3', '--version') ? ['cinematic'] : []),
    ]) {
      const res = await get(`/api/jobs/${id}/review/frame?t=1&lut=${slug}`);
      expect(res.status, slug).toBe(200);
    }
  });

  it('is 404 when the job is unknown or has no preview', async () => {
    const bare = job({ composition: false });

    const unknown = await get('/api/jobs/nope/review/frame?t=1');
    const none = await get(`/api/jobs/${bare.id}/review/frame?t=1`);

    expect(unknown.status).toBe(404);
    expect(none.status).toBe(404);
    expect(await none.json()).toEqual({ error: LUT_MESSAGES.frameNoPreview });
  });

  it('is 422 for a Camera LUT, the one of Yours and the built-in one, with the sentence of the plan', async () => {
    const { id } = job();
    addLut('Sony SLog3 to 709', 'camera');

    for (const slug of ['sony-slog3-to-709', 's-gamut3-to-cine']) {
      const res = await get(`/api/jobs/${id}/review/frame?t=1&lut=${slug}`);
      expect(res.status, slug).toBe(422);
      expect(await res.json(), slug).toEqual({ error: 'That LUT cannot be previewed.' });
    }
  });

  it('is 404 for a LUT that is not there and when the file of one of Yours left _LUTs', async () => {
    const { id } = job();
    const gone = addLut('Gone');
    rmSync(join(inboxPath, '_LUTs', gone.file));

    const unknown = await get(`/api/jobs/${id}/review/frame?t=1&lut=no-such-lut`);
    const missing = await get(`/api/jobs/${id}/review/frame?t=1&lut=gone`);
    const empty = await get(`/api/jobs/${id}/review/frame?t=1&lut=`);

    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: LUT_MESSAGES.notFound });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: LUT_MESSAGES.fileMissing });
    expect(empty.status).toBe(404);
  });

  it('is 400 for a time that is not a number of seconds', async () => {
    const { id } = job();
    for (const t of ['', 'soon', '-1', 'Infinity', '1e9']) {
      const res = await get(`/api/jobs/${id}/review/frame?t=${t}`);
      expect(res.status, t).toBe(400);
      expect(await res.json(), t).toEqual({ error: LUT_MESSAGES.frameBadTime });
    }
    const missing = await get(`/api/jobs/${id}/review/frame`);
    expect(missing.status).toBe(400);
  });

  it('answers the newest round, and a round that is not the newest has no preview', async () => {
    const { id, round } = job();

    const newest = await get(`/api/jobs/${id}/review/frame?t=1&round=${round}`);
    const old = await get(`/api/jobs/${id}/review/frame?t=1&round=${round + 1}`);
    const bad = await get(`/api/jobs/${id}/review/frame?t=1&round=x`);

    expect(newest.status).toBe(200);
    expect(old.status).toBe(404);
    expect(bad.status).toBe(404);
  });

  it('keeps the frame (cache folders by job, preview, time and LUT) and answers 304 to its tag', async () => {
    const { id } = job();
    addLut('Moody');

    const first = await get(`/api/jobs/${id}/review/frame?t=4.04&lut=moody`);
    const tag = first.headers.get('etag') as string;
    const same = await get(`/api/jobs/${id}/review/frame?t=4&lut=moody`, { 'If-None-Match': tag });
    const otherTime = await get(`/api/jobs/${id}/review/frame?t=4.1&lut=moody`);

    expect(first.headers.get('cache-control')).toBe('no-cache');
    expect(tag).toMatch(/^"/);
    // 4.04 and 4 are the same tenth of a second: same frame, same tag.
    expect(same.status).toBe(304);
    expect(otherTime.headers.get('etag')).not.toBe(tag);
    const folder = join(reviewFramesRoot(dataDir), id);
    const files = readdirSync(folder).flatMap((generation) =>
      readdirSync(join(folder, generation)),
    );
    expect(files.sort()).toHaveLength(2);
    expect(files.every((name) => name.startsWith('t40') || name.startsWith('t41'))).toBe(true);
  });

  it('shares one frame between two asks made together', async () => {
    const { id } = job();
    addLut('Moody');

    const [a, b] = await Promise.all([
      get(`/api/jobs/${id}/review/frame?t=2&lut=moody`),
      get(`/api/jobs/${id}/review/frame?t=2&lut=moody`),
    ]);

    expect(a.status).toBe(200);
    expect((await bytesOf(a)).equals(await bytesOf(b))).toBe(true);
  });

  it('is 404 "LUTs are off." when the switches are off', async () => {
    const { id } = job();
    const off = build(createFakeReviewFrames({ dataDir, inboxPath }), { switches: false });

    const res = await off.request(`/api/jobs/${id}/review/frame?t=1`);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: LUT_MESSAGES.off });
  });

  it('answers a plain sentence, never the reason, when the frame cannot be made', async () => {
    const { id } = job();
    const failing: ReviewFrames = {
      frameFor: async () => ({ ok: false, status: 500, error: LUT_MESSAGES.frameFailed }),
    };

    const res = await build(failing).request(`/api/jobs/${id}/review/frame?t=1`);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: LUT_MESSAGES.frameFailed });
  });
});

// --- the real maker, on a clip made with ffmpeg ----------------------------------------------------

/** A 4 s test-pattern clip of `size`, written to `target`. */
function makeVideo(target: string, size = '540x960'): void {
  const made = spawnSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `testsrc2=size=${size}:rate=25:duration=4`,
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-g',
      '25',
      target,
    ],
    { stdio: 'ignore' },
  );
  if (made.status !== 0) throw new Error('could not make the test clip');
}

/** The mean colour of a JPEG, from ffmpeg itself. */
function meanColour(file: string): [number, number, number] {
  const out = spawnSync(
    'ffmpeg',
    ['-v', 'error', '-i', file, '-vf', 'scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'],
    { encoding: 'buffer' },
  ).stdout;
  return [out[0] ?? 0, out[1] ?? 0, out[2] ?? 0];
}

describe.skipIf(!ffmpegHere)('the real frame maker', () => {
  let video: string;
  let status: PreviewVideoStatus;
  let statusCalls: number;
  let app: Hono;
  let countFile: string;

  const videos = {
    statusFor: async () => {
      statusCalls += 1;
      return status;
    },
  } as unknown as Pick<PreviewVideos, 'statusFor'>;
  const get = (path: string, headers: Record<string, string> = {}) =>
    Promise.resolve(app.request(path, { headers }));
  const frames = () => readFileSync(countFile, 'utf8').split('\n').filter(Boolean).length;

  beforeEach(() => {
    video = join(root, 'preview-lite.mp4');
    makeVideo(video);
    status = { state: 'ready', path: video };
    statusCalls = 0;
    // An ffmpeg that counts its runs, then is the real one.
    countFile = join(root, 'runs.log');
    writeFileSync(countFile, '');
    const wrapper = join(root, 'ffmpeg-counting');
    const real = spawnSync('which', ['ffmpeg'], { encoding: 'utf8' }).stdout.trim();
    writeFileSync(wrapper, `#!/bin/sh\necho run >> "${countFile}"\nexec "${real}" "$@"\n`);
    chmodSync(wrapper, 0o755);
    app = build(createRealReviewFrames({ dataDir, videos, ffmpegBin: wrapper }));
  });

  it('takes a JPEG frame of the round’s video at the asked time, at the video’s size', async () => {
    const { id } = job();

    const res = await get(`/api/jobs/${id}/review/frame?t=2.5`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(jpegSize(await bytesOf(res))).toEqual({ width: 540, height: 960 });
  });

  it('runs the frame through the LUT: an inverting LUT gives the opposite colours', async () => {
    const { id } = job();
    addLut('Negative');
    addLut('Neutral', 'look', identity);

    const plain = await get(`/api/jobs/${id}/review/frame?t=1.5`);
    const negative = await get(`/api/jobs/${id}/review/frame?t=1.5&lut=negative`);
    const neutral = await get(`/api/jobs/${id}/review/frame?t=1.5&lut=neutral`);
    const files = {
      plain: join(root, 'plain.jpg'),
      negative: join(root, 'negative.jpg'),
      neutral: join(root, 'neutral.jpg'),
    };
    writeFileSync(files.plain, await bytesOf(plain));
    writeFileSync(files.negative, await bytesOf(negative));
    writeFileSync(files.neutral, await bytesOf(neutral));

    const [p, n, same] = [files.plain, files.negative, files.neutral].map(meanColour) as [
      [number, number, number],
      [number, number, number],
      [number, number, number],
    ];
    for (let channel = 0; channel < 3; channel += 1) {
      // The mean of the negative is the negative of the mean, give or take the JPEG.
      expect(Math.abs((p[channel] ?? 0) + (n[channel] ?? 0) - 255)).toBeLessThan(12);
      expect(Math.abs((p[channel] ?? 0) - (same[channel] ?? 0))).toBeLessThan(6);
    }
  });

  it('takes frames of different times from different moments of the video', async () => {
    const { id } = job();

    const early = await bytesOf(await get(`/api/jobs/${id}/review/frame?t=0.2`));
    const late = await bytesOf(await get(`/api/jobs/${id}/review/frame?t=3`));

    expect(early.equals(late)).toBe(false);
  });

  it('runs ffmpeg once per frame: the same pause again, and its Compare, come from the cache', async () => {
    const { id } = job();
    addLut('Negative');

    await get(`/api/jobs/${id}/review/frame?t=2&lut=negative`);
    expect(frames()).toBe(1);
    await get(`/api/jobs/${id}/review/frame?t=2.04&lut=negative`);
    expect(frames()).toBe(1);
    await get(`/api/jobs/${id}/review/frame?t=2`);
    expect(frames()).toBe(2);
    await get(`/api/jobs/${id}/review/frame?t=2`);
    expect(frames()).toBe(2);
  });

  it('shares the run between asks made together', async () => {
    const { id } = job();
    addLut('Negative');

    const all = await Promise.all(
      [1, 2, 3, 4].map(() => get(`/api/jobs/${id}/review/frame?t=1&lut=negative`)),
    );

    expect(all.map((res) => res.status)).toEqual([200, 200, 200, 200]);
    expect(frames()).toBe(1);
  });

  it('takes the last frame when the time is past the end of the video', async () => {
    const { id } = job();

    const res = await get(`/api/jobs/${id}/review/frame?t=90`);

    expect(res.status).toBe(200);
    expect(jpegSize(await bytesOf(res))).toEqual({ width: 540, height: 960 });
  });

  it('never goes past the cut’s length when the job knows it', async () => {
    const { id } = job();
    jobs.setPreview(id, { durationSec: 4, width: 1080, height: 1920 });

    const res = await get(`/api/jobs/${id}/review/frame?t=90`);
    const tag = res.headers.get('etag') as string;

    expect(res.status).toBe(200);
    expect(tag).toContain('t40');
  });

  it('is 404 while the video is being made, and when there is none or it failed', async () => {
    const { id } = job();
    status = { state: 'making' };
    const making = await get(`/api/jobs/${id}/review/frame?t=1`);
    status = { state: 'none' };
    const none = await get(`/api/jobs/${id}/review/frame?t=1`);
    status = { state: 'failed', message: 'the render failed' };
    const failed = await get(`/api/jobs/${id}/review/frame?t=1`);

    expect(making.status).toBe(404);
    expect(await making.json()).toEqual({ error: LUT_MESSAGES.frameMaking });
    expect(none.status).toBe(404);
    expect(await none.json()).toEqual({ error: LUT_MESSAGES.frameNoPreview });
    expect(failed.status).toBe(404);
    expect(frames()).toBe(0);
  });

  it('asks the video again each time, so a new round’s video is never shown from the old one', async () => {
    const { id } = job();
    await get(`/api/jobs/${id}/review/frame?t=1`);
    const before = readdirSync(join(reviewFramesRoot(dataDir), id));

    // The round's video is made again: a new file, so a new folder, and the old one is cleared.
    const later = new Date(Date.now() + 60_000);
    utimesSync(video, later, later);
    await get(`/api/jobs/${id}/review/frame?t=1`);
    const after = readdirSync(join(reviewFramesRoot(dataDir), id));

    expect(statusCalls).toBe(2);
    expect(before).toHaveLength(1);
    expect(after).toHaveLength(1);
    expect(after[0]).not.toBe(before[0]);
    expect(frames()).toBe(2);
  });

  it('answers a plain sentence when ffmpeg is not there', async () => {
    const { id } = job();
    const broken = build(createRealReviewFrames({ dataDir, videos, ffmpegBin: '/no/such/ffmpeg' }));

    const res = await broken.request(`/api/jobs/${id}/review/frame?t=1`);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: LUT_MESSAGES.frameFailed });
  });

  it('answers each frame within a second and a half once the video exists (warm and cold)', async () => {
    const { id } = job();
    addLut('Negative');
    const started = performance.now();

    await get(`/api/jobs/${id}/review/frame?t=2&lut=negative`);
    const cold = performance.now() - started;
    const warmStarted = performance.now();
    await get(`/api/jobs/${id}/review/frame?t=2&lut=negative`);
    const warm = performance.now() - warmStarted;

    expect(cold).toBeLessThan(1500);
    expect(warm).toBeLessThan(200);
  });
});
