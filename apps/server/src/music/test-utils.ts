// Helpers for the music tests. Not part of the server build (see tsconfig.build.json).

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Job,
  MUSIC_FILES,
  type MusicPlan,
  type MusicRecord,
  musicRecordSchema,
  songSchema,
} from '@studio/shared';
import { makeJob } from '../events/test-utils.js';
import type { MusicScriptOutcome } from './music-script.js';

/** The plan page's example record (Horizon FPV / Demo): v1 by the edit run, v2 with words, v2 picked. */
export function fixtureRecord(overrides: Partial<MusicRecord> = {}): MusicRecord {
  const text = readFileSync(
    fileURLToPath(new URL('./testdata/music.json', import.meta.url)),
    'utf8',
  );
  return { ...musicRecordSchema.parse(JSON.parse(text)), ...overrides };
}

export interface MusicJobFolder {
  /** The temp inbox. */
  inboxPath: string;
  /** `<inbox>/Horizon FPV/Demo/edit`. */
  editDir: string;
  /** A job waiting for review in that folder. */
  job: Job;
  /** Removes everything. */
  remove(): void;
}

/** A temp inbox with the job `Horizon FPV / Demo` in review; its edit/music/ folder exists. */
export function musicJobFolder(overrides: Partial<Job> = {}, name = 'Demo'): MusicJobFolder {
  const inboxPath = mkdtempSync(join(tmpdir(), 'studio-music-'));
  const relPath = `Horizon FPV/${name}`;
  const editDir = join(inboxPath, relPath, 'edit');
  mkdirSync(join(editDir, 'music'), { recursive: true });
  const job = makeJob({
    id: `job-${name}`.slice(0, 12).padEnd(12, '0'),
    client: 'Horizon FPV',
    name,
    relPath,
    state: 'review',
    step: 7,
    subProgress: null,
    ...overrides,
  });
  return {
    inboxPath,
    editDir,
    job,
    remove: () => rmSync(inboxPath, { recursive: true, force: true }),
  };
}

/** Writes edit/music/music.json. */
export function writeRecord(editDir: string, record: MusicRecord): void {
  mkdirSync(join(editDir, MUSIC_FILES.dir), { recursive: true });
  writeFileSync(join(editDir, MUSIC_FILES.record), `${JSON.stringify(record, null, 2)}\n`);
}

/** Writes edit/preview/music.mp3 (a few bytes: nothing plays it). */
export function writePreviewMusic(editDir: string, bytes = 'mp3'): void {
  mkdirSync(dirname(join(editDir, MUSIC_FILES.preview)), { recursive: true });
  writeFileSync(join(editDir, MUSIC_FILES.preview), bytes);
}

export function readRecordFile(editDir: string): MusicRecord {
  return musicRecordSchema.parse(
    JSON.parse(readFileSync(join(editDir, MUSIC_FILES.record), 'utf8')),
  );
}

/** A small plan that fits the contract: 6 s in two sections. */
export function smallPlan(overrides: Partial<MusicPlan> = {}): MusicPlan {
  return {
    lengthMs: 6_000,
    styles: ['intense cinematic electronic', '120 BPM'],
    avoid: ['vocals'],
    sections: [
      { name: 'Build', ms: 3_000, styles: ['rising'], avoid: [] },
      { name: 'Drop', ms: 3_000, styles: ['full drop'], avoid: [] },
    ],
    describe: 'Intense cinematic electronic, 120 BPM. Drops at 0:03.',
    ...overrides,
  };
}

/** What a script that made `id` and printed its line comes to. */
export function ranOk(id: string, lengthMs: number | null = 39_000): MusicScriptOutcome {
  return {
    kind: 'ran',
    exitCode: 0,
    signal: null,
    line: { ok: true, id: id as 'v1', lengthMs },
    stderr: '',
  };
}

/** What a script that failed with `code` and printed its line comes to. */
export function ranFailed(
  code: 'no_credits' | 'no_access' | 'no_key' | 'down' | 'bad_plan' | 'failed',
  message: string,
  exitCode = 2,
): MusicScriptOutcome {
  return { kind: 'ran', exitCode, signal: null, line: { ok: false, code, message }, stderr: '' };
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/**
 * The record of a video whose music is the song (Songs): source and pick `song`, the part 0:42 to
 * 1:21 of נתתי לך בית by Ofek Adanek. It must parse as the contract's, so the song is built with
 * `songSchema`.
 */
export function songRecord(overrides: Partial<MusicRecord> = {}): MusicRecord {
  const song = songSchema.parse({
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
  });
  return {
    ...fixtureRecord(),
    source: 'song',
    plan: null,
    picked: 'song',
    versions: [],
    picks: [{ id: 'song', at: '2026-10-25T21:03:00.000Z' }],
    song,
    ...overrides,
  };
}

/**
 * Writes a tone of `seconds` to `path` as an mp3 like the song part the music script leaves
 * (48 kHz stereo, 192 kb/s), with the ffmpeg at `ffmpegBin`. A few kilobytes, so a test can make
 * the music a composition plays.
 */
export function writeToneMp3(ffmpegBin: string, path: string, seconds = 2.5): void {
  mkdirSync(dirname(path), { recursive: true });
  execFileSync(
    ffmpegBin,
    [
      '-nostdin',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
      '-ac',
      '2',
      '-c:a',
      'libmp3lame',
      '-b:a',
      '192k',
      '-y',
      path,
    ],
    { stdio: 'ignore' },
  );
}
