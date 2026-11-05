// The second export of a job whose music is a song (Songs, SG8): the file without it, to post.
//
//   Approve  ->  _Exports/<Client>/<Job>.mp4              the normal export, with the song
//   then     ->  _Exports/<Client>/<Job> · no song.mp4    the same video with the song silenced
//
// The song is added in Instagram, so the file to post has the voices and sounds and no music. The
// engine makes it, with no Claude run, from the composition the owner approved:
//
//   <job>/edit/preview/  --APFS clone-->  <job>/edit/.preview-no-song.tmp/
//        music.mp3 there is replaced by silence of the same length, rate and channels
//   <clone>  --hyperframes render -q delivery-->  <job>/edit/final-no-song.mp4
//   final-no-song.mp4  --copy-->  <exportsDir>/<Client>/<noSongExportName(job)>
//
// The clone is removed whatever happens, and the real music.mp3 is never touched.
//
// Rules
// - It starts when a job reaches `ready` (the worker's `afterReady`), after the normal export
//   landed, and never makes the worker wait: the job is Approved as it always was, and the second
//   file follows. A failure is remembered (`failed`, with its words) and never fails the job; Try
//   again (`start`) renders again.
// - It exists only for a job whose music.json picked the song. With any other pick, or no preview
//   to render, the status is `none` and nothing is made.
// - It is current while edit/final-no-song.mp4 is newer than everything the composition is made of
//   (the same rule as Review's export, `newestSource`), so asking again, or Try again after the copy
//   to _Exports was lost, costs no render. Review's Export MP4 changes nothing here: the second file
//   is made from the preview either way.
// - The copy to _Exports follows the normal export's rules: a hidden partial in the client folder,
//   renamed into place when every byte arrived; an earlier file of the name is moved to the first
//   free "(n)" first, never deleted.
// - A job that is deleted, cancelled or leaves `ready` has its render stopped and its clone
//   removed (`stopJob`, `listen`); shutdown stops it too (`stop`). Nothing is resumed at the next
//   boot: the status is `idle` and the sheet offers Try again.

import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  type Job,
  MUSIC_FILES,
  type MusicRecord,
  musicRecordSchema,
  type NoSongStatus,
  noSongExportName,
  pickedSong,
} from '@studio/shared';
import type { EventBus } from '../events/bus.js';
import { EDIT_DIR_NAME } from '../inbox/classify.js';
import { KILL_GRACE_MS, type RunnerLogger, SILENT_LOGGER } from '../pipeline/claude-process.js';
import { resolveFfmpeg, runFfmpeg } from '../pipeline/fake-media.js';
import { copyFileStreamed, numberedName } from '../pipeline/finalize.js';
import { PREVIEW_DIR_PATH } from '../pipeline/preview-files.js';
import { COMPOSITION_INDEX } from '../routes/composition-files.js';
import { resolveInside } from '../routes/download.js';
import { cloneTree } from '../versions/version-service.js';
import { ensureEditDir } from './edit-dir.js';
import { newestSource } from './preview-video.js';
import { renderDelivery } from './review-export.js';

/** Where the rendered file is kept, inside the job folder. */
export const NO_SONG_VIDEO_PATH = join(EDIT_DIR_NAME, 'final-no-song.mp4');

/** The clone of the preview the file is rendered from, in edit/ next to it. Dot-named: nothing watches it. */
export const NO_SONG_CLONE_PATH = join(EDIT_DIR_NAME, '.preview-no-song.tmp');

/** The composition's music, the file the clone gets silence in place of. */
const MUSIC_FILE = 'music.mp3';

/** The longest the delivery render may take, as Review's export and Approve's render. */
const RENDER_TIMEOUT_MS = 60 * 60_000;

/** How long ffprobe and the silence may take: they read and write a few seconds of audio. */
const AUDIO_TIMEOUT_MS = 60_000;

/** A silence made for a music file whose bit rate cannot be read. */
const FALLBACK_BIT_RATE = 192_000;

/** Most "(n)" names tried before giving up. Far more than anyone re-edits a job. */
const MAX_COLLISIONS = 9_999;

/** The status the engine keeps, with where the file is for the download route. */
export type NoSongExportStatus =
  | Exclude<NoSongStatus, { state: 'ready' }>
  | { state: 'ready'; path: string; file: string; at: string };

export interface NoSongExportsOptions {
  /** `Config.inboxPath`: a job's folder is `<inboxPath>/<job.relPath>`. */
  inboxPath: string;
  /** `Config.exportsDir`: where `job.output.fileName` is. */
  exportsDir: string;
  /** Renders the composition in `cwd` to `out` at delivery quality; default `npx hyperframes render`. */
  render?: (cwd: string, out: string, signal: AbortSignal) => Promise<void>;
  ffmpegBin?: string;
  ffprobeBin?: string;
  /** Told when a job's second file started being made or stopped being made (made or failed); the engine publishes `job.upsert`. */
  onChanged?: (jobId: string) => void;
  logger?: RunnerLogger;
}

/** What the silence needs to know about the music it stands in for. */
export interface AudioFacts {
  /** ffprobe's own text, e.g. "38.944000": handed to ffmpeg as it is, so the lengths agree to the ms. */
  duration: string;
  sampleRate: number;
  channels: number;
  bitRate: number;
}

/** An error whose message is already written for the person looking at the sheet. */
class NoSongError extends Error {
  override readonly name = 'NoSongError';
}

async function statOrNull(path: string) {
  try {
    const info = await stat(path);
    return info.isFile() && info.size > 0 ? info : null;
  } catch {
    return null;
  }
}

function errorCode(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** The job's music.json, or `null` when there is none that fits the contract. */
async function readMusicRecord(jobDir: string): Promise<MusicRecord | null> {
  try {
    const text = await readFile(join(jobDir, EDIT_DIR_NAME, MUSIC_FILES.record), 'utf8');
    const parsed = musicRecordSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** What ffprobe says about an audio file: the length as it prints it, the rate, the channels, the bit rate. */
export function probeAudio(
  ffprobe: string,
  path: string,
  signal: AbortSignal,
): Promise<AudioFacts> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      ffprobe,
      [
        '-v',
        'error',
        '-select_streams',
        'a:0',
        '-show_entries',
        'stream=sample_rate,channels,bit_rate:format=duration',
        '-of',
        'json',
        path,
      ],
      { timeout: AUDIO_TIMEOUT_MS, maxBuffer: 1024 * 1024, signal },
      (error, stdout) => {
        if (error) {
          reject(
            signal.aborted
              ? error
              : new NoSongError('The song’s music file in the preview can’t be read'),
          );
          return;
        }
        try {
          const data = JSON.parse(stdout) as {
            streams?: Array<Record<string, unknown>>;
            format?: Record<string, unknown>;
          };
          const stream = data.streams?.[0] ?? {};
          const duration = String(data.format?.duration ?? stream.duration ?? '');
          const seconds = Number(duration);
          const sampleRate = Number(stream.sample_rate);
          const channels = Number(stream.channels);
          const bitRate = Number(stream.bit_rate);
          if (!Number.isFinite(seconds) || seconds <= 0 || !Number.isFinite(sampleRate)) {
            throw new Error('no audio');
          }
          resolvePromise({
            duration,
            sampleRate,
            channels: Number.isFinite(channels) && channels > 0 ? channels : 2,
            bitRate: Number.isFinite(bitRate) && bitRate > 0 ? bitRate : FALLBACK_BIT_RATE,
          });
        } catch {
          reject(new NoSongError('The song’s music file in the preview has no sound to silence'));
        }
      },
    );
  });
}

/** The words for a failure, written for the sheet. */
function failureMessage(error: unknown): string {
  if (error instanceof NoSongError) return error.message;
  const code = errorCode(error);
  if (code === 'ENOSPC' || code === 'EDQUOT') {
    return 'Not enough disk space to make the file without the song';
  }
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
    return 'No permission to write the file without the song to the exports folder';
  }
  const detail = error instanceof Error ? error.message.trim() : '';
  return detail === ''
    ? 'The file without the song could not be made'
    : `The file without the song could not be made: ${detail}`;
}

interface Making {
  promise: Promise<void>;
  controller: AbortController;
}

export class NoSongExports {
  private readonly inboxPath: string;
  private readonly exportsRoot: string;
  private readonly render: NonNullable<NoSongExportsOptions['render']>;
  private readonly ffmpegBin: string;
  private readonly ffprobeBin: string;
  private readonly onChanged: (jobId: string) => void;
  private readonly logger: RunnerLogger;
  private readonly making = new Map<string, Making>();
  /** Jobs whose `start` is looking at the files, a moment before the render begins. */
  private readonly starting = new Set<string>();
  /** A failure, kept until the composition changes, by job id. */
  private readonly failed = new Map<string, { sourceMs: number; message: string }>();
  private stopped = false;

  constructor({
    inboxPath,
    exportsDir,
    render = renderDelivery,
    ffmpegBin = 'ffmpeg',
    ffprobeBin = 'ffprobe',
    onChanged = () => {},
    logger = SILENT_LOGGER,
  }: NoSongExportsOptions) {
    this.inboxPath = inboxPath;
    this.exportsRoot = resolve(exportsDir);
    this.render = render;
    this.ffmpegBin = ffmpegBin;
    this.ffprobeBin = ffprobeBin;
    this.onChanged = onChanged;
    this.logger = logger;
  }

  /** The second file's place in the exports folder, `Client/Job · no song.mp4`, or `null` for a job with no export. */
  relPathFor(job: Pick<Job, 'name' | 'output'>): string | null {
    if (job.output === null) return null;
    const folder = dirname(job.output.fileName);
    const name = noSongExportName(job.name);
    return folder === '.' ? name : `${folder}/${name}`;
  }

  /**
   * Where the second file stands. Never starts a render. `none` for everything that is not a ready
   * job whose music is the song and whose preview can be rendered.
   */
  async statusFor(job: Job): Promise<NoSongExportStatus> {
    const status = await this.inspect(job);
    // A render under way (or about to start) is what the sheet shows, whatever the files say yet.
    if (
      (status.state === 'idle' || status.state === 'failed') &&
      (this.making.has(job.id) || this.starting.has(job.id))
    ) {
      return { state: 'making' };
    }
    return status;
  }

  /** What the job and the files say, without the render that may be under way. */
  private async inspect(job: Job): Promise<NoSongExportStatus> {
    if (job.state !== 'ready' || job.output === null) return { state: 'none' };
    const jobDir = join(this.inboxPath, job.relPath);
    if (pickedSong(await readMusicRecord(jobDir)) === null) return { state: 'none' };
    const root = await resolveInside(jobDir, PREVIEW_DIR_PATH);
    if (root === null || (await resolveInside(root, COMPOSITION_INDEX)) === null) {
      return { state: 'none' };
    }

    const sourceMs = await newestSource(root);
    const video = await statOrNull(join(jobDir, NO_SONG_VIDEO_PATH));
    if (video !== null && video.mtimeMs >= sourceMs) {
      const rel = this.relPathFor(job);
      const placed = rel === null ? null : await resolveInside(this.exportsRoot, rel);
      const copy = placed === null ? null : await statOrNull(placed);
      if (placed !== null && copy !== null && copy.size === video.size) {
        return {
          state: 'ready',
          path: placed,
          file: noSongExportName(job.name),
          at: new Date(video.mtimeMs).toISOString(),
        };
      }
    }
    const failure = this.failed.get(job.id);
    if (failure !== undefined && failure.sourceMs === sourceMs) {
      return { state: 'failed', message: failure.message };
    }
    return { state: 'idle' };
  }

  /**
   * Starts making the second file unless it is current, none is wanted, or one is being made. The
   * answer comes at once: `making` when the render started. Asking again meanwhile (or asking for
   * the status) already says `making`.
   */
  async start(job: Job): Promise<NoSongExportStatus> {
    if (this.stopped) return { state: 'none' };
    if (this.making.has(job.id) || this.starting.has(job.id)) return { state: 'making' };
    this.starting.add(job.id);
    try {
      const status = await this.inspect(job);
      if (status.state !== 'idle' && status.state !== 'failed') return status;
      const jobDir = join(this.inboxPath, job.relPath);
      const root = await resolveInside(jobDir, PREVIEW_DIR_PATH);
      if (root === null) return { state: 'none' };
      const sourceMs = await newestSource(root);
      if (this.stopped) return { state: 'none' };
      this.failed.delete(job.id);

      const controller = new AbortController();
      const promise = this.make(job, root, controller)
        .catch((error: unknown) => {
          // Stopped on purpose (the job was deleted, cancelled, or the engine is stopping): not a failure.
          if (controller.signal.aborted) return;
          this.failed.set(job.id, { sourceMs, message: failureMessage(error) });
          this.logger.warn(
            { jobId: job.id, err: error },
            'could not make the file without the song',
          );
        })
        .finally(() => {
          this.making.delete(job.id);
          if (!controller.signal.aborted) this.changed(job.id);
        });
      this.making.set(job.id, { promise, controller });
      this.changed(job.id);
      return { state: 'making' };
    } finally {
      this.starting.delete(job.id);
    }
  }

  /** Resolves when the job's second file is no longer being made (tests). */
  async idle(jobId: string): Promise<void> {
    while (this.starting.has(jobId) || this.making.has(jobId)) {
      await (this.making.get(jobId)?.promise ?? new Promise((resolve) => setTimeout(resolve, 5)));
    }
  }

  /** Stops the render of a job and waits until it has stopped and its clone is gone. */
  async stopJob(jobId: string): Promise<void> {
    const making = this.making.get(jobId);
    if (making === undefined) return;
    if (!making.controller.signal.aborted) making.controller.abort('cancel');
    await making.promise;
  }

  /** Stops every render (the engine is stopping) and starts none again. */
  async stop(): Promise<void> {
    this.stopped = true;
    const running = [...this.making.values()];
    for (const making of running) {
      if (!making.controller.signal.aborted) making.controller.abort('shutdown');
    }
    await Promise.all(running.map((making) => making.promise));
  }

  /**
   * Follows the bus: a job that is removed, or that is no longer `ready` (cancelled, sent back for
   * a new run), has its render stopped. Returns what ends the listening.
   */
  listen(bus: Pick<EventBus, 'subscribe'>): () => void {
    return bus.subscribe((event) => {
      if (event.type === 'job.remove') this.failed.delete(event.id);
      const jobId =
        event.type === 'job.remove'
          ? event.id
          : event.type === 'job.upsert' && event.job.state !== 'ready'
            ? event.job.id
            : undefined;
      if (jobId === undefined || !this.making.has(jobId)) return;
      this.stopJob(jobId).catch((err: unknown) => {
        this.logger.warn({ jobId, err }, 'could not stop the file without the song');
      });
    });
  }

  private changed(jobId: string): void {
    try {
      this.onChanged(jobId);
    } catch (err) {
      this.logger.error({ jobId, err }, 'the listener of the file without the song threw');
    }
  }

  private async make(job: Job, root: string, controller: AbortController): Promise<void> {
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(RENDER_TIMEOUT_MS)]);
    const jobDir = join(this.inboxPath, job.relPath);
    const video = join(jobDir, NO_SONG_VIDEO_PATH);

    // Rendered unless an earlier one is still current (the copy to _Exports was what was lost).
    const sourceMs = await newestSource(root);
    const earlier = await statOrNull(video);
    if (earlier === null || earlier.mtimeMs < sourceMs) {
      await this.renderSilenced(jobDir, root, video, signal);
    }
    await this.exportCopy(job, video, signal);
  }

  /** The clone with silence for music, rendered to `video`. The clone and the partial are removed whatever happens. */
  private async renderSilenced(
    jobDir: string,
    root: string,
    video: string,
    signal: AbortSignal,
  ): Promise<void> {
    const clone = join(jobDir, NO_SONG_CLONE_PATH);
    const partial = join(jobDir, EDIT_DIR_NAME, '.final-no-song.partial.mp4');
    // Not recursive: a job deleted while it waited must not get its folder back.
    await ensureEditDir(jobDir);
    // A leftover of a render a crash cut short.
    await rm(clone, { recursive: true, force: true });
    await rm(partial, { force: true });
    try {
      const music = join(root, MUSIC_FILE);
      if ((await statOrNull(music)) === null) {
        throw new NoSongError('The preview has no music file to leave the song out of');
      }
      await cloneTree(root, clone, true, this.logger);
      await this.silence(music, join(clone, MUSIC_FILE), signal);
      await this.render(clone, partial, signal);
      if ((await statOrNull(partial)) === null) {
        throw new NoSongError('The render made no video');
      }
      await rename(partial, video);
    } catch (error) {
      if (signal.aborted && !(error instanceof NoSongError)) {
        throw new NoSongError(
          signal.reason === 'cancel' || signal.reason === 'shutdown'
            ? 'The render was stopped'
            : 'The render took too long',
        );
      }
      throw error;
    } finally {
      await rm(clone, { recursive: true, force: true }).catch(() => undefined);
      await rm(partial, { force: true }).catch(() => undefined);
    }
  }

  /**
   * Writes `target` (in the clone) as silence with the length, rate and channels of `source` (the
   * real music.mp3): an mp3 like the original. The entry in the clone is removed first, so nothing
   * written there can reach the original through a link.
   */
  private async silence(source: string, target: string, signal: AbortSignal): Promise<void> {
    const ffmpeg = await resolveFfmpeg(this.ffmpegBin);
    if (ffmpeg === null) throw new NoSongError('ffmpeg was not found');
    const ffprobe = await resolveFfmpeg(this.ffprobeBin);
    if (ffprobe === null) throw new NoSongError('ffprobe was not found');
    const facts = await probeAudio(ffprobe, source, signal);
    const partial = join(dirname(target), '.music-silence.partial.mp3');
    try {
      const result = await runFfmpeg({ bin: ffmpeg, signal, killGraceMs: KILL_GRACE_MS }, [
        '-f',
        'lavfi',
        '-i',
        `anullsrc=channel_layout=${facts.channels === 1 ? 'mono' : 'stereo'}:sample_rate=${facts.sampleRate}`,
        '-t',
        facts.duration,
        '-c:a',
        'libmp3lame',
        '-b:a',
        String(facts.bitRate),
        '-f',
        'mp3',
        '-y',
        partial,
      ]);
      if (result.status === 'failed') throw new NoSongError(result.message);
      if (result.status === 'aborted') throw new Error('stopped');
      await rm(target, { force: true });
      await rename(partial, target);
    } finally {
      await rm(partial, { force: true }).catch(() => undefined);
    }
  }

  /** Copies the rendered file to `_Exports/<Client>/<Job> · no song.mp4`, the way the normal export is copied. */
  private async exportCopy(job: Job, video: string, signal: AbortSignal): Promise<void> {
    const rel = this.relPathFor(job);
    if (rel === null) throw new NoSongError('The job has no export to put the file next to');
    const destination = resolve(this.exportsRoot, rel);
    const inside = relative(this.exportsRoot, destination);
    if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
      throw new NoSongError(`The names of this job don't make a valid export path (${rel})`);
    }
    const folder = dirname(destination);
    await mkdir(folder, { recursive: true });

    const partial = join(folder, `.${job.id}.no-song.mp4.partial`);
    await rm(partial, { force: true });
    try {
      await copyFileStreamed(video, partial, signal);
      const [copied, source] = await Promise.all([stat(partial), stat(video)]);
      if (copied.size !== source.size) {
        throw new NoSongError(
          `The copy of the video is incomplete (${copied.size} of ${source.size} bytes)`,
        );
      }

      // An earlier file of the name moves to the first free "(n)"; it is put back if the new one
      // cannot take its place.
      const existing = await lstat(destination).catch(() => null);
      let movedTo: string | null = null;
      if (existing !== null) {
        if (!existing.isFile()) {
          throw new NoSongError(
            `${basename(destination)} is already there and is not a video file`,
          );
        }
        movedTo = await this.firstFreeName(destination);
        await rename(destination, movedTo);
      }
      try {
        await rename(partial, destination);
      } catch (error) {
        if (movedTo !== null) await rename(movedTo, destination).catch(() => undefined);
        throw error;
      }
    } finally {
      await rm(partial, { force: true }).catch(() => undefined);
    }
  }

  private async firstFreeName(absPath: string): Promise<string> {
    for (let n = 1; n <= MAX_COLLISIONS; n += 1) {
      const candidate = numberedName(absPath, n);
      if ((await lstat(candidate).catch(() => null)) === null) return candidate;
    }
    throw new NoSongError(`There are too many earlier files named ${basename(absPath)}`);
  }
}

/**
 * The worker's `afterReady` with the second file started before `next` runs: the start is not
 * waited for (the render takes minutes and the worker waits for `afterReady` before it picks the
 * next job), and a start that fails is logged, never the job's problem. Without `noSong` (Songs
 * off) it is `next` itself.
 */
export function withNoSongOnReady(
  next: (job: Job) => Promise<void>,
  noSong: Pick<NoSongExports, 'start'> | null,
  logger: RunnerLogger = SILENT_LOGGER,
): (job: Job) => Promise<void> {
  if (noSong === null) return next;
  return async (job) => {
    noSong.start(job).catch((err: unknown) => {
      logger.warn({ jobId: job.id, err }, 'could not start the file without the song');
    });
    await next(job);
  };
}
