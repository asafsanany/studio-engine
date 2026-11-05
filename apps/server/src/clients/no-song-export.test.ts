import { execFile } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { type Job, MUSIC_FILES, type ServerEvent } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { createEventBus } from '../events/bus.js';
import { fixtureRecord, songRecord, writeRecord, writeToneMp3 } from '../music/test-utils.js';
import { resolveFfmpeg } from '../pipeline/fake-media.js';
import { makeTempDir } from '../test-temp.js';
import {
  NO_SONG_CLONE_PATH,
  NO_SONG_VIDEO_PATH,
  NoSongExports,
  probeAudio,
  withNoSongOnReady,
} from './no-song-export.js';

// The second export: the file without the song. Real files in a temp inbox and a temp exports
// folder, real ffmpeg for the audio (the silence is the point), and a fake render that records what
// the clone it was handed held.

const run = promisify(execFile);
const ffmpeg = await resolveFfmpeg('ffmpeg');
const ffprobe = await resolveFfmpeg('ffprobe');
const haveTools = ffmpeg !== null && ffprobe !== null;

/** The mean and peak volume of an audio file, in dB (−91 is digital silence). */
async function volume(file: string): Promise<{ mean: number; max: number }> {
  const { stderr } = await run(ffmpeg as string, [
    '-nostdin',
    '-i',
    file,
    '-af',
    'volumedetect',
    '-f',
    'null',
    '-',
  ]);
  const mean = /mean_volume: (-?[\d.]+) dB/.exec(stderr)?.[1];
  const max = /max_volume: (-?[\d.]+) dB/.exec(stderr)?.[1];
  return { mean: Number(mean), max: Number(max) };
}

/** A tone of `seconds` at 48 kHz stereo, as an mp3 like SG3's song part. */
async function writeSong(path: string, seconds = 2.5): Promise<void> {
  writeToneMp3(ffmpeg as string, path, seconds);
}

interface Bench {
  inbox: string;
  exports: string;
  jobDir: string;
  editDir: string;
  preview: string;
  job: Job;
  /** What every render saw in its clone. */
  renders: Array<{ cwd: string; mean: number; max: number; duration: string; files: string[] }>;
  changed: string[];
  noSong: NoSongExports;
}

interface BenchOptions {
  name?: string;
  record?: ReturnType<typeof songRecord> | null;
  render?: (cwd: string, out: string, signal: AbortSignal) => Promise<void>;
  withMusic?: boolean;
}

async function bench(options: BenchOptions = {}): Promise<Bench> {
  const inbox = makeTempDir('no-song-inbox-');
  const exports = makeTempDir('no-song-exports-');
  const name = options.name ?? 'Job';
  const jobDir = join(inbox, 'Client', name);
  const editDir = join(jobDir, 'edit');
  const preview = join(editDir, 'preview');
  mkdirSync(preview, { recursive: true });
  writeFileSync(join(preview, 'index.html'), '<html><body>hello</body></html>');
  mkdirSync(join(preview, 'compositions'));
  writeFileSync(join(preview, 'compositions', 'a.html'), '<div></div>');
  if (options.withMusic !== false) await writeSong(join(preview, 'music.mp3'));
  if (options.record !== null) writeRecord(editDir, options.record ?? songRecord());
  // Everything the composition is made of is older than whatever is rendered from it.
  const past = new Date(Date.now() - 60_000);
  for (const file of ['index.html', 'compositions/a.html', 'music.mp3']) {
    if (existsSync(join(preview, file))) utimesSync(join(preview, file), past, past);
  }

  const job = {
    id: 'job-1',
    client: 'Client',
    name,
    relPath: `Client/${name}`,
    state: 'ready',
    output: { fileName: `Client/${name}.mp4`, durationSec: 2.5, width: 1, height: 1, sizeBytes: 1 },
  } as unknown as Job;
  mkdirSync(join(exports, 'Client'), { recursive: true });
  writeFileSync(join(exports, 'Client', `${name}.mp4`), 'main export');

  const renders: Bench['renders'] = [];
  const changed: string[] = [];
  const render =
    options.render ??
    (async (cwd: string, out: string) => {
      const music = join(cwd, 'music.mp3');
      const { mean, max } = await volume(music);
      const facts = await probeAudio(ffprobe as string, music, new AbortController().signal);
      renders.push({
        cwd,
        mean,
        max,
        duration: facts.duration,
        files: readdirSync(cwd).sort(),
      });
      writeFileSync(out, `video-${renders.length}`);
    });
  const noSong = new NoSongExports({
    inboxPath: inbox,
    exportsDir: exports,
    render,
    onChanged: (jobId) => changed.push(jobId),
  });
  return { inbox, exports, jobDir, editDir, preview, job, renders, changed, noSong };
}

const noSongPath = (b: Bench, name = 'Job · no song.mp4') => join(b.exports, 'Client', name);

describe.skipIf(!haveTools)('the file without the song', () => {
  it('is made from a clone whose music is silence of the same length, rate and channels, and leaves the real music alone', async () => {
    const b = await bench();
    const realBefore = readFileSync(join(b.preview, 'music.mp3'));
    const realFacts = await probeAudio(
      ffprobe as string,
      join(b.preview, 'music.mp3'),
      new AbortController().signal,
    );

    expect(await b.noSong.statusFor(b.job)).toEqual({ state: 'idle' });
    expect(await b.noSong.start(b.job)).toEqual({ state: 'making' });
    await b.noSong.idle(b.job.id);

    // One render, from a clone next to the preview that held the whole composition...
    expect(b.renders).toHaveLength(1);
    const [seen] = b.renders;
    expect(seen?.cwd).toBe(join(b.jobDir, NO_SONG_CLONE_PATH));
    expect(seen?.files).toEqual(['compositions', 'index.html', 'music.mp3']);
    // ...whose music was silent, and as long as the real one to the millisecond.
    expect(seen?.mean).toBe(-91);
    expect(seen?.max).toBe(-91);
    expect(seen?.duration).toBe(realFacts.duration);

    // The real music is the same bytes, still music.
    expect(readFileSync(join(b.preview, 'music.mp3')).equals(realBefore)).toBe(true);
    expect((await volume(join(b.preview, 'music.mp3'))).mean).toBeGreaterThan(-30);
    // The clone is gone, the file is in edit/ and in _Exports next to the normal export.
    expect(existsSync(join(b.jobDir, NO_SONG_CLONE_PATH))).toBe(false);
    expect(readFileSync(join(b.jobDir, NO_SONG_VIDEO_PATH), 'utf8')).toBe('video-1');
    expect(readFileSync(noSongPath(b), 'utf8')).toBe('video-1');
    expect(readFileSync(join(b.exports, 'Client', 'Job.mp4'), 'utf8')).toBe('main export');
    expect(readdirSync(join(b.exports, 'Client')).sort()).toEqual(['Job · no song.mp4', 'Job.mp4']);

    const status = await b.noSong.statusFor(b.job);
    expect(status).toMatchObject({
      state: 'ready',
      path: realpathSync(noSongPath(b)),
      file: 'Job · no song.mp4',
    });
    expect(status.state === 'ready' && Number.isNaN(Date.parse(status.at))).toBe(false);
    // The page is told when it started and when it ended.
    expect(b.changed).toEqual(['job-1', 'job-1']);
  });

  it('is made only for a job whose music is the song', async () => {
    const withoutRecord = await bench({ record: null });
    const aVersion = await bench({ record: fixtureRecord() });
    const songNotPicked = await bench({ record: songRecord({ picked: 'off' }) });
    const noPreview = await bench();
    const notReady = await bench();
    const noOutput = await bench();
    await rm(join(noPreview.editDir, 'preview'), { recursive: true });

    for (const [b, job] of [
      [withoutRecord, withoutRecord.job],
      [aVersion, aVersion.job],
      [songNotPicked, songNotPicked.job],
      [noPreview, noPreview.job],
      [notReady, { ...notReady.job, state: 'review' } as Job],
      [noOutput, { ...noOutput.job, output: null } as Job],
    ] as const) {
      expect(await b.noSong.statusFor(job)).toEqual({ state: 'none' });
      expect(await b.noSong.start(job)).toEqual({ state: 'none' });
      expect(b.renders).toEqual([]);
      expect(b.changed).toEqual([]);
      expect(existsSync(join(b.jobDir, NO_SONG_VIDEO_PATH))).toBe(false);
    }
  });

  it('answers at once while the render goes on, and does not start a second one', async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let renders = 0;
    const b = await bench({
      render: async (_cwd, out) => {
        renders += 1;
        await held;
        writeFileSync(out, 'video');
      },
    });

    expect(await b.noSong.start(b.job)).toEqual({ state: 'making' });
    expect(await b.noSong.start(b.job)).toEqual({ state: 'making' });
    expect(await b.noSong.statusFor(b.job)).toEqual({ state: 'making' });
    // The render begins once the clone and the silence are made.
    await waitFor(() => renders === 1);
    expect(await b.noSong.start(b.job)).toEqual({ state: 'making' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(renders).toBe(1);

    release();
    await b.noSong.idle(b.job.id);
    expect(renders).toBe(1);
    expect((await b.noSong.statusFor(b.job)).state).toBe('ready');
  });

  it('never makes the job’s own export wait: the worker’s hook returns while the render is under way', async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const b = await bench({
      render: async (_cwd, out) => {
        await held;
        writeFileSync(out, 'video');
      },
    });
    const order: string[] = [];
    const afterReady = withNoSongOnReady(async () => {
      order.push('learn');
    }, b.noSong);

    await afterReady(b.job);
    order.push('hook returned');
    expect(order).toEqual(['learn', 'hook returned']);
    expect(await b.noSong.statusFor(b.job)).toEqual({ state: 'making' });

    release();
    await b.noSong.idle(b.job.id);
    expect((await b.noSong.statusFor(b.job)).state).toBe('ready');
    // With Songs off there is no second file, and the hook is the plain one.
    const plain = async () => {};
    expect(withNoSongOnReady(plain, null)).toBe(plain);
  });

  it('asks again for nothing while the composition has not changed, and copies again when the export was lost', async () => {
    const b = await bench();
    await b.noSong.start(b.job);
    await b.noSong.idle(b.job.id);
    expect(b.renders).toHaveLength(1);

    // Ready: nothing starts.
    expect(await b.noSong.start(b.job)).toMatchObject({ state: 'ready' });
    expect(b.renders).toHaveLength(1);

    // The copy in _Exports was deleted: Try again puts it back from edit/, with no render.
    await rm(noSongPath(b));
    expect(await b.noSong.statusFor(b.job)).toEqual({ state: 'idle' });
    expect(await b.noSong.start(b.job)).toEqual({ state: 'making' });
    await b.noSong.idle(b.job.id);
    expect(b.renders).toHaveLength(1);
    expect(readFileSync(noSongPath(b), 'utf8')).toBe('video-1');
    expect(await b.noSong.statusFor(b.job)).toMatchObject({ state: 'ready' });
  });

  it('is made again when the composition changed, and the earlier file moves to “(1)”', async () => {
    const b = await bench();
    await b.noSong.start(b.job);
    await b.noSong.idle(b.job.id);

    const later = new Date(Date.now() + 60_000);
    utimesSync(join(b.preview, 'index.html'), later, later);
    expect(await b.noSong.statusFor(b.job)).toEqual({ state: 'idle' });

    // A later file counts as made after the change.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await b.noSong.start(b.job)).toEqual({ state: 'making' });
    await b.noSong.idle(b.job.id);
    expect(b.renders).toHaveLength(2);
    expect(readFileSync(noSongPath(b), 'utf8')).toBe('video-2');
    expect(readFileSync(noSongPath(b, 'Job · no song (1).mp4'), 'utf8')).toBe('video-1');
  });

  it('works for the same composition whether or not Review’s Export MP4 was used', async () => {
    // Export MP4 writes edit/review-export.mp4 and changes nothing in the composition.
    const b = await bench();
    writeFileSync(join(b.editDir, 'review-export.mp4'), 'full quality');
    await b.noSong.start(b.job);
    await b.noSong.idle(b.job.id);
    expect(readFileSync(noSongPath(b), 'utf8')).toBe('video-1');
    expect(readFileSync(join(b.editDir, 'review-export.mp4'), 'utf8')).toBe('full quality');
  });

  it('names the file after the job the way the normal export is named, next to it', async () => {
    const b = await bench({ name: 'הדגמה: 2' });
    // The normal export's name replaced ":" by "-".
    const job = {
      ...b.job,
      output: { ...(b.job.output as object), fileName: 'Client/הדגמה- 2.mp4' },
    } as Job;
    await b.noSong.start(job);
    await b.noSong.idle(job.id);
    expect(readdirSync(join(b.exports, 'Client')).sort()).toContain('הדגמה- 2 · no song.mp4');
    expect(await b.noSong.statusFor(job)).toMatchObject({ file: 'הדגמה- 2 · no song.mp4' });
  });

  describe('when it fails', () => {
    it('says why, never throws, leaves no clone, and Try again makes it', async () => {
      let fail = true;
      const b = await bench({
        render: async (_cwd, out) => {
          if (fail) throw new Error('the render failed (1): Chrome crashed');
          writeFileSync(out, 'video');
        },
      });

      expect(await b.noSong.start(b.job)).toEqual({ state: 'making' });
      await b.noSong.idle(b.job.id);
      expect(await b.noSong.statusFor(b.job)).toEqual({
        state: 'failed',
        message:
          'The file without the song could not be made: the render failed (1): Chrome crashed',
      });
      expect(existsSync(join(b.jobDir, NO_SONG_CLONE_PATH))).toBe(false);
      expect(existsSync(join(b.jobDir, NO_SONG_VIDEO_PATH))).toBe(false);
      expect(readdirSync(join(b.exports, 'Client'))).toEqual(['Job.mp4']);
      // The job's own export is as it was.
      expect(readFileSync(join(b.exports, 'Client', 'Job.mp4'), 'utf8')).toBe('main export');
      // The page was told at the start and at the end.
      expect(b.changed).toEqual(['job-1', 'job-1']);

      fail = false;
      expect(await b.noSong.start(b.job)).toEqual({ state: 'making' });
      await b.noSong.idle(b.job.id);
      expect(await b.noSong.statusFor(b.job)).toMatchObject({ state: 'ready' });
    });

    it('forgets a failure when the composition changes', async () => {
      const b = await bench({
        render: async () => {
          throw new Error('boom');
        },
      });
      await b.noSong.start(b.job);
      await b.noSong.idle(b.job.id);
      expect((await b.noSong.statusFor(b.job)).state).toBe('failed');

      const later = new Date(Date.now() + 60_000);
      utimesSync(join(b.preview, 'compositions', 'a.html'), later, later);
      expect(await b.noSong.statusFor(b.job)).toEqual({ state: 'idle' });
    });

    it('says so when the preview has no music file, and when the render makes no video', async () => {
      const noMusic = await bench({ withMusic: false });
      await noMusic.noSong.start(noMusic.job);
      await noMusic.noSong.idle(noMusic.job.id);
      expect(await noMusic.noSong.statusFor(noMusic.job)).toEqual({
        state: 'failed',
        message: 'The preview has no music file to leave the song out of',
      });

      const empty = await bench({ render: async () => {} });
      await empty.noSong.start(empty.job);
      await empty.noSong.idle(empty.job.id);
      expect(await empty.noSong.statusFor(empty.job)).toEqual({
        state: 'failed',
        message: 'The render made no video',
      });
      expect(existsSync(join(empty.jobDir, NO_SONG_CLONE_PATH))).toBe(false);
    });

    it('does not touch the real music even when the preview’s music.mp3 is a link to another file', async () => {
      const b = await bench();
      const elsewhere = join(makeTempDir('no-song-elsewhere-'), 'song.mp3');
      await writeSong(elsewhere);
      const before = readFileSync(elsewhere);
      await rm(join(b.preview, 'music.mp3'));
      symlinkSync(elsewhere, join(b.preview, 'music.mp3'));

      await b.noSong.start(b.job);
      await b.noSong.idle(b.job.id);

      expect(b.renders[0]?.mean).toBe(-91);
      expect(readFileSync(elsewhere).equals(before)).toBe(true);
      expect((await volume(elsewhere)).mean).toBeGreaterThan(-30);
    });

    it.skipIf(process.getuid?.() === 0)(
      'keeps the rendered file when the copy to _Exports is refused, and Try again copies it with no new render',
      async () => {
        const b = await bench();
        chmodSync(join(b.exports, 'Client'), 0o555);
        try {
          await b.noSong.start(b.job);
          await b.noSong.idle(b.job.id);
          expect(await b.noSong.statusFor(b.job)).toEqual({
            state: 'failed',
            message: 'No permission to write the file without the song to the exports folder',
          });
          expect(readdirSync(join(b.exports, 'Client'))).toEqual(['Job.mp4']);
        } finally {
          chmodSync(join(b.exports, 'Client'), 0o755);
        }

        expect(await b.noSong.start(b.job)).toEqual({ state: 'making' });
        await b.noSong.idle(b.job.id);
        expect(b.renders).toHaveLength(1);
        expect(await b.noSong.statusFor(b.job)).toMatchObject({ state: 'ready' });
        expect(readFileSync(noSongPath(b), 'utf8')).toBe('video-1');
      },
    );
  });

  describe('when the job is deleted, cancelled or sent for a new run', () => {
    /** A render that waits for its signal and says it saw it. */
    function stoppable() {
      const seen: { aborted: boolean; cwd: string | null; started: boolean } = {
        aborted: false,
        cwd: null,
        started: false,
      };
      const render = (cwd: string, _out: string, signal: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          seen.started = true;
          seen.cwd = cwd;
          signal.addEventListener('abort', () => {
            seen.aborted = true;
            reject(new Error('stopped'));
          });
        });
      return { seen, render };
    }

    it('stopJob stops the render and removes the clone, with no failure and no file', async () => {
      const { seen, render } = stoppable();
      const b = await bench({ render });
      await b.noSong.start(b.job);
      await waitFor(() => seen.started);
      expect(existsSync(join(b.jobDir, NO_SONG_CLONE_PATH))).toBe(true);

      await b.noSong.stopJob(b.job.id);

      expect(seen.aborted).toBe(true);
      expect(existsSync(join(b.jobDir, NO_SONG_CLONE_PATH))).toBe(false);
      expect(existsSync(join(b.jobDir, NO_SONG_VIDEO_PATH))).toBe(false);
      expect(readdirSync(join(b.exports, 'Client'))).toEqual(['Job.mp4']);
      // Stopped on purpose: not a failure, and the page is not told it ended.
      expect(await b.noSong.statusFor(b.job)).toEqual({ state: 'idle' });
      expect(b.changed).toEqual(['job-1']);
      // Nothing to stop the second time.
      await b.noSong.stopJob(b.job.id);
    });

    it('follows the bus: a removed job, or one that left ready, is stopped; a ready one is not', async () => {
      const bus = createEventBus();
      for (const event of [
        { type: 'job.remove', id: 'job-1' },
        { type: 'job.upsert', job: { id: 'job-1', state: 'cancelled' } },
        { type: 'job.upsert', job: { id: 'job-1', state: 'queued' } },
      ] as ServerEvent[]) {
        const { seen, render } = stoppable();
        const b = await bench({ render });
        const stopListening = b.noSong.listen(bus);
        await b.noSong.start(b.job);
        await waitFor(() => seen.started);

        bus.publish({ type: 'job.upsert', job: b.job });
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(seen.aborted).toBe(false);

        bus.publish(event);
        await waitFor(() => seen.aborted);
        await b.noSong.idle(b.job.id);
        expect(existsSync(join(b.jobDir, NO_SONG_CLONE_PATH))).toBe(false);
        stopListening();
      }
    });

    it('stop (the engine is stopping) stops the render the same way and starts none after', async () => {
      const { seen, render } = stoppable();
      const b = await bench({ render });
      await b.noSong.start(b.job);
      await waitFor(() => seen.started);

      await b.noSong.stop();

      expect(seen.aborted).toBe(true);
      expect(existsSync(join(b.jobDir, NO_SONG_CLONE_PATH))).toBe(false);
      expect(await b.noSong.start(b.job)).toEqual({ state: 'none' });
    });
  });

  it('removes a clone a crashed render left behind before it makes a new one', async () => {
    const b = await bench();
    const leftover = join(b.jobDir, NO_SONG_CLONE_PATH);
    mkdirSync(leftover, { recursive: true });
    writeFileSync(join(leftover, 'stale.txt'), 'x');

    await b.noSong.start(b.job);
    await b.noSong.idle(b.job.id);

    expect(b.renders[0]?.files).toEqual(['compositions', 'index.html', 'music.mp3']);
    expect(existsSync(leftover)).toBe(false);
    expect(statSync(noSongPath(b)).size).toBeGreaterThan(0);
  });
});

/** Waits (briefly) until `condition` holds. */
async function waitFor(condition: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(condition()).toBe(true);
}

describe('the silence’s source', () => {
  it.skipIf(!haveTools)(
    'reads a music file’s length as ffprobe prints it, its rate and channels',
    async () => {
      const dir = makeTempDir('no-song-probe-');
      await writeSong(join(dir, 'song.mp3'), 3.2);
      const facts = await probeAudio(
        ffprobe as string,
        join(dir, 'song.mp3'),
        new AbortController().signal,
      );
      expect(Number(facts.duration)).toBeCloseTo(3.2, 1);
      expect(facts).toMatchObject({ sampleRate: 48_000, channels: 2, bitRate: 192_000 });
    },
  );

  it.skipIf(!haveTools)('refuses a file with no sound', async () => {
    const dir = makeTempDir('no-song-probe-');
    writeFileSync(join(dir, 'song.mp3'), 'not audio');
    await expect(
      probeAudio(ffprobe as string, join(dir, 'song.mp3'), new AbortController().signal),
    ).rejects.toThrow(/can.t be read|no sound/);
  });
});

// The record's file names are the contract's, not this test's.
describe('the files', () => {
  it('keeps the rendered file in edit/ next to the composition, and the clone is a dot-named folder', () => {
    expect(NO_SONG_VIDEO_PATH).toBe(join('edit', 'final-no-song.mp4'));
    expect(NO_SONG_CLONE_PATH).toBe(join('edit', '.preview-no-song.tmp'));
    expect(MUSIC_FILES.preview).toBe('preview/music.mp3');
  });
});
