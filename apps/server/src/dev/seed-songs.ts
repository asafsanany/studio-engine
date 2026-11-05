// Dev fixture for Songs' design QA (CVP-396): `pnpm seed:canvas --songs` seeds one job for each state of
// the boards SGStates (the Music list in Review: the song, No music picked, couldn't get the song,
// "Original audio", a trending pick, a note added) and SGNote (Note for the editor: a pasted screenshot,
// nothing attached) and SGSheet (the job sheet after Approve: both files, the second still being made,
// the second one failed), so Review's list, the note dialog and the sheet show every state on the Mac and
// the phone.
//
// - Every job has what the engine leaves behind: edit/music/ (plan.json, music.json, and song.mp3 or
//   v1.mp3), edit/preview/ (the sample composition stretched to the cut's length, playing music.mp3) and
//   edit/preview/music.mp3. The records are written here, not made by the `song` command: they say what
//   the command writes for the boards' song (the studio track from YouTube Music, 3:12, the part 0:42 to
//   1:21 measured, Yael's screenshot IMG_4412.PNG), so each reads as drawn; the audio is an ffmpeg tone,
//   a made-up 39 s part. (The e2e specs run the real `song` command against stand-ins instead:
//   e2e/songs.spec.ts, apps/server/src/music/testdata/fake-e2e-songs.mjs.) The two jobs that fell back to
//   ElevenLabs get their v1 from the music script's fake path, as the Soundtrack seed does.
// - The notes of the two "added" states are real unsent review notes at 0:00, the words Another song and
//   Pick a trending one add; the arriving job has IMG_4412.PNG in edit/brief/from-you/ and a note, as
//   Save in Note for the editor leaves them.
// - The second file of the approved jobs is the engine's own NoSongExports over the seed's inbox and
//   exports folder, with a stand-in for its render: the first approved job has both files already, the
//   second is being made for as long as the seed runs, and the third one failed (no disk space) until
//   Try again, which makes it. The files are placeholders, not real videos.
// - Times are UTC clock times on the boards' day, a day behind the real one so the jobs are never in the
//   future (Sat 24 Oct 2026, "Now" 21:30). Open the page in UTC to read them as the boards do.
//
// Dev-only: nothing in apps/ imports it but the seed.

import { copyFile, mkdir, readdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  MUSIC_FILES,
  type MusicRecord,
  type MusicVersion,
  musicRecordSchema,
  NOTE_ATTACHMENTS,
  noSongExportName,
  type Song,
} from '@studio/shared';
import type { NoSongExportsOptions } from '../clients/no-song-export.js';
import { NoteRepository, type StudioDb } from '../db/index.js';
import { createMusicScriptRunner, type MusicScriptRunner } from '../music/music-script.js';
import { writeFakePreview } from '../pipeline/fake-preview.js';
import type { CanvasJobSpec } from './seed-canvas.js';
import {
  at,
  cut,
  ffmpeg,
  plan,
  type RunSpec,
  record,
  script,
  seedMusicRuns,
  shifted,
  stretchedSample,
  writeTone,
} from './seed-music.js';

/** The moment the Songs boards are drawn at: "Now", Sat 24 Oct 2026, 21:30 (UTC). */
export const SONGS_NOW = '2026-10-24T21:30:00.000Z';

const DAY = '2026-10-24';
const MB = 1_000_000;
const GB = 1_000_000_000;

/** `HH:MM` on the boards' day, as the ISO timestamp the records and the database hold. */
const t = (time: string): string => at(time, DAY);

const FALCON = 'Falcon FPV';

/** The jobs of the songs seed, by what they show. */
export const SONGS_IDS = {
  /** Review: the song from Yael's screenshot, with its part bar. The What's new screenshot. */
  song: 'sg-song',
  /** Review: No music picked (the song is still in the list). */
  off: 'sg-off',
  /** Review: couldn't get the song, ElevenLabs made v1. */
  fallback: 'sg-fallback',
  /** Review: the screenshot says "Original audio". */
  original: 'sg-original',
  /** Review: a trending pick, with Instagram's numbers. */
  trend: 'sg-trend',
  /** Review: the song, and a note asking for another one ("Use … instead."). */
  notedSong: 'sg-noted-song',
  /** Review: ElevenLabs' v1, and the note "Use a trending song that fits the cut.". */
  notedTrend: 'sg-noted-trend',
  /** Arriving: a pasted screenshot and a note, as Note for the editor leaves them. */
  arrivingShot: 'sg-arriving-shot',
  /** Arriving: nothing attached (the drop zone). */
  arrivingEmpty: 'sg-arriving-empty',
  /** Approved: both files. The sheet's board. */
  approved: 'sg-approved',
  /** Approved: the second file is being made. */
  making: 'sg-making',
  /** Approved: the second file could not be made. */
  failed: 'sg-failed',
} as const;

/** The two approved jobs whose second file the seed's stand-in render holds, or fails once. */
export const SONGS_NO_SONG_JOBS = {
  making: { client: FALCON, name: 'Demo 12', id: SONGS_IDS.making },
  failed: { client: FALCON, name: 'Demo 13', id: SONGS_IDS.failed },
} as const;

/** The name of the screenshot Yael sends, the boards' own. */
export const SONGS_SCREENSHOT = 'IMG_4412.PNG';
/** What Another song adds: the board's words for a name typed. */
export const SONGS_NOTE_SONG = 'Use Blinding Lights instead.';
export const SONGS_NOTE_TREND = 'Use a trending song that fits the cut.';
export const SONGS_NOTE_PICTURE = 'Yael wants this song. Start it where the reel does.';

// --- the jobs --------------------------------------------------------------------------------------

const preview = (durationSec: number) => ({ durationSec, width: 1080, height: 1920 });

const review = (
  id: string,
  name: string,
  added: string,
  updated: string,
  extra: Partial<CanvasJobSpec> = {},
): CanvasJobSpec => ({
  id,
  state: 'review',
  client: FALCON,
  name,
  inputs: [12, 0, 1, 0],
  sizeBytes: 2.1 * GB,
  addedAt: t(added),
  updatedAt: t(updated),
  step: 7,
  preview: preview(39),
  ...extra,
});

const approved = (id: string, name: string, extra: Partial<CanvasJobSpec> = {}): CanvasJobSpec => ({
  id,
  state: 'ready',
  client: FALCON,
  name,
  inputs: [12, 0, 1, 0],
  sizeBytes: 2.1 * GB,
  addedAt: t('20:50'),
  updatedAt: t('21:24'),
  step: 8,
  runKind: 'render',
  approvedAt: t('21:20'),
  output: { durationSec: 39, width: 1080, height: 1920, sizeBytes: 31 * MB },
  preview: preview(39),
  effort: 'high',
  ...extra,
});

/**
 * The jobs, in the order of the boards' states. Every cut is 0:39, the boards' length; every job is
 * Falcon FPV's, as on SGSheet and SGNote.
 */
export const SONGS_JOB_SPECS: readonly CanvasJobSpec[] = [
  review(SONGS_IDS.song, 'Demo 2', '20:48', '21:12', { effort: 'high' }),
  review(SONGS_IDS.off, 'Demo 3', '20:40', '21:05'),
  review(SONGS_IDS.fallback, 'Demo 4', '20:35', '21:00'),
  review(SONGS_IDS.original, 'Demo 5', '20:30', '20:55'),
  review(SONGS_IDS.trend, 'Demo 6', '20:25', '20:50', {
    inputs: [9, 0, 0, 0],
    sizeBytes: 1.6 * GB,
  }),
  review(SONGS_IDS.notedSong, 'Demo 7', '20:20', '20:45'),
  review(SONGS_IDS.notedTrend, 'Demo 8', '20:15', '20:40', {
    inputs: [9, 0, 0, 0],
    sizeBytes: 1.6 * GB,
  }),
  {
    id: SONGS_IDS.arrivingShot,
    state: 'arriving',
    client: FALCON,
    name: 'Demo 9',
    inputs: [14, 0, 1, 0],
    sizeBytes: 2.3 * GB,
    addedAt: t('21:28'),
    updatedAt: t('21:29'),
    lastChangeAt: `${DAY}T21:29:40.000Z`,
    note: SONGS_NOTE_PICTURE,
  },
  {
    id: SONGS_IDS.arrivingEmpty,
    state: 'arriving',
    client: FALCON,
    name: 'Demo 10',
    inputs: [8, 0, 0, 0],
    sizeBytes: 1.1 * GB,
    addedAt: t('21:29'),
    updatedAt: t('21:29'),
    lastChangeAt: `${DAY}T21:29:50.000Z`,
  },
  approved(SONGS_IDS.approved, 'Demo 11'),
  approved(SONGS_IDS.making, SONGS_NO_SONG_JOBS.making.name, {
    addedAt: t('20:55'),
    approvedAt: t('21:25'),
    updatedAt: t('21:27'),
  }),
  approved(SONGS_IDS.failed, SONGS_NO_SONG_JOBS.failed.name, {
    addedAt: t('20:45'),
    approvedAt: t('21:10'),
    updatedAt: t('21:14'),
  }),
];

// --- the records -----------------------------------------------------------------------------------

const DEMO_LINE =
  'Intense cinematic electronic, 120 BPM. Builds to a big drop at 0:18 and lands on the logo at 0:35.';
const PLAN = plan(39, DEMO_LINE);

/** The song of the boards: A Home for You by Ofek Adanek, the studio track from YouTube Music, 3:12. */
function song(fields: Partial<Song> = {}): Song {
  return {
    title: 'A Home for You',
    artist: 'Ofek Adanek',
    version: null,
    asked: { from: 'screenshot', file: SONGS_SCREENSHOT, url: null, by: 'brief' },
    source: {
      site: 'youtube-music',
      via: 'yt-dlp',
      url: 'https://music.youtube.com/watch?v=Zq3Rk1pXo9A',
      id: 'Zq3Rk1pXo9A',
    },
    fullMs: 192_000,
    part: { startMs: 42_000, endMs: 81_000, how: 'measured', beatCount: 78 },
    trending: null,
    file: 'song.mp3',
    instagramLine:
      'In Instagram tap Add audio, pick A Home for You by Ofek Adanek and slide it to start at 0:42.',
    gotAt: t('21:03'),
    ...fields,
  };
}

/** A record whose music is the song: the command's own (source and pick song, the plan of the cut). */
const withSong = (fields: Partial<MusicRecord> = {}): MusicRecord =>
  record({
    source: 'song',
    plan: PLAN,
    picked: 'song',
    picks: [{ id: 'song', at: t('21:03') }],
    song: song(),
    ...fields,
  });

/** ElevenLabs' v1, which the edit run made when the song could not be got. */
const V1: MusicVersion = {
  id: 'v1',
  file: 'v1.mp3',
  describe: PLAN.describe,
  ask: null,
  seed: 4712,
  model: 'fake',
  lengthMs: 39_000,
  by: 'edit',
  madeAt: t('21:04'),
};

/** A record whose song could not be got and whose music is v1. */
const withV1 = (fields: Partial<MusicRecord> = {}): MusicRecord =>
  record({
    plan: PLAN,
    picked: 'v1',
    versions: [V1],
    picks: [{ id: 'v1', at: t('21:04') }],
    ...fields,
  });

/** What each job's edit/music/music.json says. The jobs with no music have no record. */
export const SONGS_RECORDS: Readonly<Record<string, MusicRecord>> = {
  [SONGS_IDS.song]: withSong(),
  [SONGS_IDS.off]: withSong({
    picked: 'off',
    picks: [
      { id: 'song', at: t('21:03') },
      { id: 'off', at: t('21:06') },
    ],
  }),
  [SONGS_IDS.fallback]: withV1({
    songFailure: {
      asked: 'https://www.instagram.com/reel/DQx7mK2kF9a/',
      code: 'unavailable',
      message:
        'A Home for You, from the reel link Yael sent: the downloader didn’t answer. ElevenLabs made v1 instead.',
      at: t('21:03'),
    },
  }),
  [SONGS_IDS.original]: withV1({
    songFailure: {
      asked: 'Original audio · @reels.creator',
      code: 'original_audio',
      message: 'The screenshot says “Original audio”: there is no song to look up.',
      at: t('21:02'),
    },
  }),
  [SONGS_IDS.trend]: withSong({
    song: song({
      asked: { from: 'trending', file: null, url: null, by: 'editor' },
      trending: { reels: 18_400, isTrending: true, nicheTop20: 3, niche: '#fpv' },
    }),
  }),
  [SONGS_IDS.notedSong]: withSong(),
  [SONGS_IDS.notedTrend]: withV1(),
  [SONGS_IDS.approved]: withSong(),
  [SONGS_IDS.making]: withSong(),
  [SONGS_IDS.failed]: withSong(),
};

/** The unsent notes of the two "added" states, at 0:00, as Another song and Pick a trending one add them. */
export const SONGS_NOTES: readonly { id: string; jobId: string; text: string }[] = [
  { id: 'sg-note-song', jobId: SONGS_IDS.notedSong, text: SONGS_NOTE_SONG },
  { id: 'sg-note-trend', jobId: SONGS_IDS.notedTrend, text: SONGS_NOTE_TREND },
];

// --- the step runs ---------------------------------------------------------------------------------

/** A render run of the approved jobs: Approve to the export. */
function rendered(jobId: string, start: string, minutes: number): RunSpec {
  return { jobId, runKind: 'render', day: DAY, steps: [[8, start, minutes]] };
}

export const SONGS_RUNS: readonly RunSpec[] = [
  cut(SONGS_IDS.song, [20, 50], DAY),
  cut(SONGS_IDS.off, [20, 42], DAY),
  cut(SONGS_IDS.fallback, [20, 37], DAY),
  cut(SONGS_IDS.original, [20, 32], DAY),
  cut(SONGS_IDS.trend, [20, 27], DAY),
  cut(SONGS_IDS.notedSong, [20, 22], DAY),
  cut(SONGS_IDS.notedTrend, [20, 17], DAY),
  // The sheet's board: the Brief at 21:00, the edit to 21:12, approved at 21:20, rendered by 21:24.
  cut(SONGS_IDS.approved, [21, 0], DAY),
  rendered(SONGS_IDS.approved, '21:21', 3),
  cut(SONGS_IDS.making, [20, 57], DAY),
  rendered(SONGS_IDS.making, '21:26', 1),
  cut(SONGS_IDS.failed, [20, 47], DAY),
  rendered(SONGS_IDS.failed, '21:11', 3),
];

/** Writes the step runs of the songs seed's jobs into a database that has the jobs. */
export function seedSongsRuns(db: StudioDb, shiftMs = 0): void {
  seedMusicRuns(db, shiftMs, SONGS_RUNS);
}

/** Writes the unsent notes of the "added" states into a database that has the jobs. */
export function seedSongsNotes(db: StudioDb, shiftMs = 0): void {
  let minute = 0;
  for (const note of SONGS_NOTES) {
    minute += 1;
    const created = Date.parse(t('21:20')) + shiftMs + minute * 60_000;
    new NoteRepository(db, { clock: () => new Date(created) }).create({
      id: note.id,
      jobId: note.jobId,
      kind: 'text',
      atSec: 0,
      text: note.text,
    });
  }
}

// --- the files -------------------------------------------------------------------------------------

/**
 * A screenshot of a reel at 9:16, drawn by ffmpeg alone: a dusk gradient, a dark strip at the bottom
 * where the audio label sits and two light lines on it. The picture is only to be looked at in the
 * note dialog's row, so it says nothing the brief could read.
 */
async function reelScreenshot(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const strip = 'drawbox=y=ih-96:w=iw:h=96:color=black@0.62:t=fill';
  const label = [
    'drawbox=x=40:y=ih-66:w=14:h=14:color=white@0.9:t=fill',
    'drawbox=x=64:y=ih-68:w=190:h=8:color=white@0.9:t=fill',
    'drawbox=x=64:y=ih-48:w=120:h=6:color=white@0.55:t=fill',
  ].join(',');
  await ffmpeg([
    ...['-f', 'lavfi', '-i', 'color=c=black:s=360x640'],
    ...[
      '-vf',
      `format=rgb24,geq=r='46+150*Y/H':g='58+80*Y/H':b='132+70*(1-Y/H)',${strip},${label}`,
    ],
    ...['-frames:v', '1', path],
  ]);
}

export interface SeedSongsOptions {
  inboxPath: string;
  /** Where the seed's exports are: the main export of a ready job is there (placeholders), and the second file's copy. */
  exportsDir: string;
  /** The seed's own folder, for the stretched samples. */
  dir: string;
  /** The sample composition (apps/server/src/pipeline/testdata/preview/). */
  samplePreviewDir: string;
  /** Every time moves by this much, as the jobs' did. */
  shiftMs?: number;
  specs?: readonly CanvasJobSpec[];
  /** Runs the music script (v1 of the two jobs that fell back). Default: the real one, in `dir`. */
  run?: MusicScriptRunner;
}

/** The pitch of each job's tone, so what plays under each is told apart. */
const TONE_HZ: Readonly<Record<string, number>> = {
  [SONGS_IDS.trend]: 392,
};
const SONG_HZ = 330;

/**
 * Writes what each job has on disk: edit/music/ (the plan, the record, song.mp3 or v1.mp3), the preview
 * composition (stretched to the cut, playing music.mp3 when there is one), the arriving job's picture, and
 * the approved jobs' second file where it is already made.
 */
export async function seedSongsFiles({
  inboxPath,
  exportsDir,
  dir,
  samplePreviewDir,
  shiftMs = 0,
  specs = SONGS_JOB_SPECS,
  run = createMusicScriptRunner({ cwd: dir }),
}: SeedSongsOptions): Promise<void> {
  const workDir = join(dir, 'songs-seed');
  await mkdir(workDir, { recursive: true });
  const samples = new Map<number, string>();

  for (const spec of specs) {
    const music = SONGS_RECORDS[spec.id];
    const jobDir = join(inboxPath, spec.client, spec.name);
    const editDir = join(jobDir, 'edit');
    const musicDir = join(editDir, MUSIC_FILES.dir);

    // The arriving job with a picture: what Save in Note for the editor leaves.
    if (spec.id === SONGS_IDS.arrivingShot) {
      await reelScreenshot(join(editDir, NOTE_ATTACHMENTS.dir, SONGS_SCREENSHOT));
    }
    if (music === undefined) {
      await mkdir(jobDir, { recursive: true });
      continue;
    }

    await mkdir(musicDir, { recursive: true });
    await writeFile(join(editDir, MUSIC_FILES.plan), `${JSON.stringify(PLAN, null, 2)}\n`);
    const writeRecord = async (): Promise<void> => {
      const checked = musicRecordSchema.parse(shifted(music, shiftMs));
      await writeFile(join(editDir, MUSIC_FILES.record), `${JSON.stringify(checked, null, 2)}\n`);
    };

    if (music.source === 'song') {
      // The part of the song the cut plays: song.mp3, and the copy the composition plays.
      await writeTone(join(musicDir, 'song.mp3'), 39, TONE_HZ[spec.id] ?? SONG_HZ);
      await mkdir(join(editDir, 'preview'), { recursive: true });
      await copyFile(join(musicDir, 'song.mp3'), join(editDir, MUSIC_FILES.preview));
      await writeRecord();
      // No music: the script's own pick writes the silence the preview plays, then the record is the board's.
      if (music.picked === 'off') await script(run, ['pick', editDir, 'off']);
      await writeRecord();
    } else {
      // The song could not be got: the script's fake path makes v1, then the record is the board's.
      await script(run, ['make', editDir, '--by', 'edit', '--fake']);
      await writeRecord();
    }

    // The composition of a job that waits for review, or was approved: as long as the cut, playing music.mp3.
    if (spec.preview !== undefined) {
      const seconds = spec.preview.durationSec;
      let template = samples.get(seconds);
      if (template === undefined) {
        template = await stretchedSample(samplePreviewDir, workDir, seconds);
        samples.set(seconds, template);
      }
      const hasMusic = await readFile(join(editDir, MUSIC_FILES.preview)).then(
        () => true,
        () => false,
      );
      await writeFakePreview(editDir, spec.name, template, { music: hasMusic });
    }
  }

  // The composition of an approved job is as old as the edit that made it (21:12), so the second file
  // of the first one, rendered at 21:24, is newer than it: the engine reads that as current. Every file
  // in preview/ counts (the baked cut.mp4 too, `newestSource`), so every file is moved back.
  const editedAt = new Date(Date.parse(t('21:12')) + shiftMs);
  for (const spec of specs) {
    if (spec.state !== 'ready' || spec.preview === undefined) continue;
    await touchTree(join(inboxPath, spec.client, spec.name, 'edit', 'preview'), editedAt);
  }

  // The first approved job has its second file already: the render in edit/ and its copy next to the
  // export, the same size, and newer than the composition.
  const ready = specs.find((spec) => spec.id === SONGS_IDS.approved);
  if (ready !== undefined && ready.output !== undefined) {
    const jobDir = join(inboxPath, ready.client, ready.name);
    const bytes = Buffer.alloc(18 * 1_000);
    const edit = join(jobDir, 'edit', 'final-no-song.mp4');
    const copy = join(exportsDir, ready.client, noSongExportName(ready.name));
    await mkdir(dirname(copy), { recursive: true });
    await writeFile(edit, bytes);
    await writeFile(copy, bytes);
    // At the boards' time ("Rendered with the song, and without it", 21:24), moved with the rest.
    const rendered = new Date(Date.parse(t('21:24')) + shiftMs);
    await utimes(edit, rendered, rendered);
    await utimes(copy, rendered, rendered);
  }
}

/** Sets the modified time of every file under `dir` (a folder that is not there is left as it is). */
async function touchTree(dir: string, when: Date): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await touchTree(path, when);
    else await utimes(path, when, when).catch(() => undefined);
  }
}

// --- the second file's render ------------------------------------------------------------------------

/**
 * The stand-in for the engine's delivery render, for the second file of the seed's approved jobs: the
 * one in `SONGS_NO_SONG_JOBS.making` never finishes (it stops when the seed does), the one in
 * `.failed` fails the first time, as a disk that is full would, and Try again makes it; any other job's
 * writes a placeholder at once. The files are not real videos.
 */
export function songsNoSongRender(): NonNullable<NoSongExportsOptions['render']> {
  let failedOnce = false;
  return async (cwd, out, signal) => {
    const job = basename(dirname(dirname(cwd)));
    if (job === SONGS_NO_SONG_JOBS.making.name) {
      await new Promise<never>((_, reject) => {
        const stop = (): void => reject(new Error('stopped'));
        if (signal.aborted) stop();
        else signal.addEventListener('abort', stop, { once: true });
      });
    }
    if (job === SONGS_NO_SONG_JOBS.failed.name && !failedOnce) {
      failedOnce = true;
      throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    }
    await writeFile(out, Buffer.alloc(18 * 1_000));
  };
}
