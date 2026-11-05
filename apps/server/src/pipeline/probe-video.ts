// What ffprobe says about the finished video (E6): its length and its picture size as a player
// shows it. Kept apart from finalize.ts so the parsing (rotation, odd containers) is tested on
// its own, with canned ffprobe output.

import { execFile } from 'node:child_process';

/** What the web app shows about an export, besides its size on disk. */
export interface VideoFacts {
  durationSec: number;
  /** As a player shows the picture: already swapped with `height` for a video rotated ±90°. */
  width: number;
  height: number;
}

/**
 * ffprobe could not tell what the video is: the file is not a usable video, or ffprobe itself did
 * not run. The message is written for the person looking at the failed job.
 */
export class ProbeError extends Error {
  override readonly name = 'ProbeError';
}

/** A probe that takes longer than this fails the export. Reading a container's header is quick. */
export const PROBE_TIMEOUT_MS = 60_000;

/** Longest ffprobe error text that goes into a message, so one line of the job stays readable. */
const DETAIL_CHARS = 240;

interface RawStream {
  codec_type?: unknown;
  width?: unknown;
  height?: unknown;
  duration?: unknown;
  tags?: { rotate?: unknown };
  side_data_list?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A positive count of pixels, or `null`. */
function pixelCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

/** A picture stored in the file as its cover (an MP3's artwork, say), not video. */
function isCoverImage(stream: Record<string, unknown>): boolean {
  const { disposition } = stream;
  return isRecord(disposition) && disposition.attached_pic === 1;
}

/** ffprobe prints seconds as a string (`"2.000000"`); `N/A` or a missing key means unknown. */
function seconds(value: unknown): number | null {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * How far the picture is turned for display, in degrees, or 0 when it is not. Reads the display
 * matrix side data (every ffmpeg since 5) and falls back to the older `rotate` tag. The sign
 * (iPhone portrait clips say -90) does not matter here, only the quarter turns do.
 */
function rotationOf(stream: RawStream): number {
  if (Array.isArray(stream.side_data_list)) {
    for (const entry of stream.side_data_list as unknown[]) {
      if (
        isRecord(entry) &&
        typeof entry.rotation === 'number' &&
        Number.isFinite(entry.rotation)
      ) {
        return entry.rotation;
      }
    }
  }
  const tag = Number(stream.tags?.rotate);
  return Number.isFinite(tag) ? tag : 0;
}

/** Whether a turn of `degrees` puts the picture on its side (90 or 270, allowing for rounding). */
function isSideways(degrees: number): boolean {
  const turn = ((degrees % 360) + 360) % 360;
  return Math.abs(turn - 90) < 1 || Math.abs(turn - 270) < 1;
}

/**
 * Reads ffprobe's `-print_format json -show_format -show_streams` output.
 * The first real video track counts (a cover image in the file is not one). Throws
 * {@link ProbeError} when the output is not usable.
 */
export function parseProbeJson(text: string): VideoFacts {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ProbeError("The finished video can't be read (ffprobe gave no answer)");
  }
  const streams: unknown[] = isRecord(data) && Array.isArray(data.streams) ? data.streams : [];
  const video = streams.find(
    (stream): stream is RawStream =>
      isRecord(stream) && stream.codec_type === 'video' && !isCoverImage(stream),
  );
  if (video === undefined) {
    throw new ProbeError('The finished video has no picture (no video track in it)');
  }

  const stored = { width: pixelCount(video.width), height: pixelCount(video.height) };
  if (stored.width === null || stored.height === null) {
    throw new ProbeError("The finished video's picture has no size");
  }
  const sideways = isSideways(rotationOf(video));

  const format = isRecord(data) && isRecord(data.format) ? data.format : {};
  const durationSec = seconds(format.duration) ?? seconds(video.duration);
  if (durationSec === null) {
    throw new ProbeError("The finished video's length can't be read");
  }

  return {
    durationSec: Math.round(durationSec * 1000) / 1000,
    width: sideways ? stored.height : stored.width,
    height: sideways ? stored.width : stored.height,
  };
}

/** The first line of ffprobe's complaint, cut short. */
function detailOf(stderr: string): string {
  const line = stderr.split('\n').find((candidate) => candidate.trim() !== '') ?? '';
  const trimmed = line.trim();
  return trimmed.length > DETAIL_CHARS ? `${trimmed.slice(0, DETAIL_CHARS)}...` : trimmed;
}

/**
 * Runs ffprobe on `absPath`. Rejects with {@link ProbeError} when the file cannot be read as a
 * video or ffprobe cannot be started, and with the signal's reason when `signal` fires.
 */
export function probeVideo(bin: string, absPath: string, signal: AbortSignal): Promise<VideoFacts> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-i', absPath],
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, signal, windowsHide: true },
      (error, stdout, stderr) => {
        if (signal.aborted) {
          reject(signal.reason ?? new Error('The export was stopped'));
          return;
        }
        if (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (typeof code === 'string' && /^E[A-Z]+$/.test(code)) {
            // ENOENT, EACCES: ffprobe itself did not start, which says nothing about the video.
            reject(new ProbeError(`ffprobe could not be started (${code})`));
            return;
          }
          const killed = (error as { killed?: boolean }).killed === true;
          const detail = killed ? 'ffprobe took too long' : detailOf(stderr) || error.message;
          reject(new ProbeError(`The finished video can't be read (ffprobe: ${detail})`));
          return;
        }
        try {
          resolve(parseProbeJson(stdout));
        } catch (parseError) {
          reject(parseError);
        }
      },
    );
  });
}
