// Dev fixture for Soundtrack's design QA (CVP-287): `pnpm seed:canvas --music` seeds one job for each
// state of the boards SDStates (the Music list in Review: made once, made twice, making, failed, off,
// a file in the folder, a style that says no music, a series episode) and SDSheet (the job sheet's
// Music row and History: making, ready to review with v1 and with v2 of 2, a supplied file, no music
// on purpose, couldn't make it), so Review's list and the sheet show every state on the Mac and the
// phone.
//
// - Every job has what the engine leaves behind: edit/music/ (plan.json, v1.mp3 …, music.json),
//   edit/preview/ (the sample composition stretched to the cut's length, playing music.mp3) and
//   edit/preview/music.mp3. The mp3s are made by the music script's own fake path (an ffmpeg tone, a
//   different note per version, silence for No music), so Make another and Pick work on any job in
//   Review with the same script; only the records are written here, so each reads as drawn.
// - Times are UTC clock times on the boards' two days (the day before, "Yesterday", and "Today" at
//   00:20 when the boards were drawn). Open the page in UTC to read them as the boards do.
// - "Demo 3" is being made for real: the seed asks the music service for v2 with a runner that never
//   finishes, so its view says making (and Approve waits) until the seed stops.
// - The two list states that offer "Make one" (the folder's file and a style that says no music) have
//   a plan in their record, as the boards draw them. Today's edit run writes none for those two, so in
//   the real engine that button is disabled with "There’s no music plan for this video." (C34).
//
// Dev-only: nothing in apps/ imports it but the seed.

import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  MUSIC_FILES,
  type MusicPlan,
  type MusicRecord,
  type MusicVersion,
  musicRecordSchema,
  type StepId,
} from '@studio/shared';
import type { StudioDb } from '../db/index.js';
import { stepRuns } from '../db/schema.js';
import {
  createMusicScriptRunner,
  type MusicScriptCall,
  type MusicScriptOutcome,
  type MusicScriptRunner,
} from '../music/music-script.js';
import { writeFakePreview } from '../pipeline/fake-preview.js';
import type { CanvasJobSpec } from './seed-canvas.js';

const execFileAsync = promisify(execFile);

/** The moment the music boards are drawn at: "Today, 00:20" (UTC). */
export const MUSIC_NOW = '2026-10-23T00:20:00.000Z';

const MB = 1_000_000;
const GB = 1_000_000_000;

const YESTERDAY = '2026-10-22';
const TODAY = '2026-10-23';

/** `HH:MM` on `day` as the ISO timestamp the records and the database hold. */
export function at(time: string, day: string = YESTERDAY): string {
  return `${day}T${time}:00.000Z`;
}

const OFEK = 'Horizon FPV';
const LAKESHORE = 'LAKESHORE';
const LAW = 'Levy Law';
const MYTH = 'Myth or fact';
const FAQ = 'Common questions';

/** The jobs of the music seed, by what they show. */
export const MUSIC_IDS = {
  /** Review: v1 and v2 (asked for darker, heavier drums), v2 playing. The What's new screenshot. */
  demo: 'mu-demo',
  /** Review: v1 only. */
  teaser: 'mu-teaser',
  /** Editing: the first music is being made (the sheet's Making board). */
  editing: 'mu-editing',
  /** Review: v1, and v2 being made right now ("darker, heavier drums"). */
  making: 'mu-making',
  /** Review: v1 playing, v2 couldn't be made (no credits). */
  failedV2: 'mu-failed-v2',
  /** Review: nothing was made (no credits), the video has no music. */
  failedV1: 'mu-failed-v1',
  /** Review: v1 and v2, No music picked. */
  off: 'mu-off',
  /** Review: the folder's Summer Vibes.mp3. */
  folder: 'mu-folder',
  /** Approved: the folder's file (the sheet's folder board). */
  folderApproved: 'mu-folder-approved',
  /** Review: the client's style says no music. */
  noStyle: 'mu-no-style',
  /** The series' format job (episode 5, ready). */
  mythFormat: 'mu-myth-5',
  /** Review: episode 6, the series' music. */
  series: 'mu-series',
} as const;

/** The job the seed makes v2 for in the background, and the words it was asked with. */
export const MUSIC_MAKING_JOB = { client: OFEK, name: 'Demo 3' } as const;
export const MUSIC_MAKING_ASK = 'darker, heavier drums';

// --- the jobs --------------------------------------------------------------------------------------

const preview = (durationSec: number) => ({ durationSec, width: 1080, height: 1920 });

/**
 * The jobs, in the order of the boards' states. The cut lengths are the boards' (0:39 for Demo, 0:41
 * for Demo 2 and the lawyer's FAQ, 0:44 for LAKESHORE, 0:38 for the lawyer's episode).
 */
export const MUSIC_JOB_SPECS: readonly CanvasJobSpec[] = [
  {
    id: MUSIC_IDS.demo,
    state: 'review',
    client: OFEK,
    name: 'Demo',
    inputs: [21, 0, 0, 0],
    sizeBytes: 3.4 * GB,
    addedAt: at('23:20'),
    updatedAt: at('23:35'),
    step: 7,
    effort: 'high',
    preview: preview(39),
  },
  {
    id: MUSIC_IDS.teaser,
    state: 'review',
    client: OFEK,
    name: 'Teaser',
    inputs: [9, 0, 0, 0],
    sizeBytes: 1.6 * GB,
    addedAt: at('22:40'),
    updatedAt: at('22:58'),
    step: 7,
    preview: preview(39),
  },
  {
    id: MUSIC_IDS.editing,
    state: 'editing',
    client: OFEK,
    name: 'Demo 2',
    inputs: [14, 0, 0, 0],
    sizeBytes: 2.3 * GB,
    addedAt: at('00:10', TODAY),
    updatedAt: at('00:19', TODAY),
    step: 6,
    subProgress: 'making the music',
    etaSec: 180,
    effort: 'high',
    startedAt: at('00:12', TODAY),
  },
  {
    id: MUSIC_IDS.making,
    state: 'review',
    client: OFEK,
    name: MUSIC_MAKING_JOB.name,
    inputs: [12, 0, 0, 0],
    sizeBytes: 2.1 * GB,
    addedAt: at('23:05'),
    updatedAt: at('23:30'),
    step: 7,
    preview: preview(39),
  },
  {
    id: MUSIC_IDS.failedV2,
    state: 'review',
    client: OFEK,
    name: 'Demo 4',
    inputs: [11, 0, 0, 0],
    sizeBytes: 1.9 * GB,
    addedAt: at('23:00'),
    updatedAt: at('23:28'),
    step: 7,
    preview: preview(39),
  },
  {
    id: MUSIC_IDS.failedV1,
    state: 'review',
    client: OFEK,
    name: 'Demo 5',
    inputs: [14, 0, 0, 0],
    sizeBytes: 2.3 * GB,
    addedAt: at('00:10', TODAY),
    updatedAt: at('00:19', TODAY),
    step: 7,
    preview: preview(41),
  },
  {
    id: MUSIC_IDS.off,
    state: 'review',
    client: OFEK,
    name: 'Reel',
    inputs: [18, 0, 0, 0],
    sizeBytes: 2.8 * GB,
    addedAt: at('21:50'),
    updatedAt: at('22:15'),
    step: 7,
    preview: preview(39),
  },
  {
    id: MUSIC_IDS.folder,
    state: 'review',
    client: LAKESHORE,
    name: 'Summer promo',
    inputs: [6, 1, 0, 0],
    sizeBytes: 1.3 * GB,
    addedAt: at('22:05'),
    updatedAt: at('22:25'),
    step: 7,
    preview: preview(44),
  },
  {
    id: MUSIC_IDS.folderApproved,
    state: 'ready',
    client: LAKESHORE,
    name: 'Project tour',
    inputs: [6, 1, 0, 0],
    sizeBytes: 1.4 * GB,
    addedAt: at('09:40', TODAY),
    updatedAt: at('10:15', TODAY),
    step: 8,
    runKind: 'render',
    approvedAt: at('10:12', TODAY),
    output: { durationSec: 44, width: 1080, height: 1920, sizeBytes: 31 * MB },
    note: 'Use the summer track',
  },
  {
    id: MUSIC_IDS.noStyle,
    state: 'review',
    client: LAW,
    name: `${FAQ} 5`,
    inputs: [1, 0, 0, 0],
    sizeBytes: 0.6 * GB,
    addedAt: at('23:02'),
    updatedAt: at('23:30'),
    step: 7,
    preview: preview(41),
  },
  {
    id: MUSIC_IDS.mythFormat,
    state: 'ready',
    client: LAW,
    name: `${MYTH} 5`,
    inputs: [7, 0, 1, 0],
    sizeBytes: 1.4 * GB,
    addedAt: at('08:50', YESTERDAY),
    updatedAt: at('09:42', YESTERDAY),
    step: 8,
    runKind: 'render',
    approvedAt: at('09:30', YESTERDAY),
    output: { durationSec: 36, width: 1080, height: 1920, sizeBytes: 26 * MB },
  },
  {
    id: MUSIC_IDS.series,
    state: 'review',
    client: LAW,
    name: `${MYTH} 6`,
    inputs: [7, 0, 1, 0],
    sizeBytes: 1.5 * GB,
    addedAt: at('22:30'),
    updatedAt: at('22:55'),
    step: 7,
    preview: preview(38),
  },
];

/** The lawyer's series of the music seed: the format job is episode 5, the one in Review episode 6. */
export const MUSIC_SERIES_JOBS = {
  formatJobId: MUSIC_IDS.mythFormat,
  episodes: [
    { jobId: MUSIC_IDS.mythFormat, episode: 5 },
    { jobId: MUSIC_IDS.series, episode: 6 },
  ],
} as const;

// --- the plans -------------------------------------------------------------------------------------

/** What an edit run writes for a cut with a build, a rise, the drop, a golden stretch and the logo. */
export function plan(lengthSec: number, describe: string, logoAt = 35): MusicPlan {
  // The drop lands at 0:18 on every cut of the boards; the logo starts at `logoAt` (0:35 on theirs).
  const sections = [
    ['Build', 10, ['sparse pulse', 'rising']],
    ['Rise', 8, ['faster', 'tension building']],
    ['Drop', 6, ['big drop', 'full drums and bass']],
    ['Golden', logoAt - 24, ['wide', 'driving']],
    ['Logo', lengthSec - logoAt, ['final hit on the logo', 'short tail']],
  ] as const;
  return {
    lengthMs: lengthSec * 1000,
    styles: ['intense cinematic electronic', '120 BPM', 'big drops', 'instrumental'],
    avoid: ['vocals', 'singing', 'lyrics'],
    sections: sections.map(([name, sec, styles]) => ({
      name,
      ms: sec * 1000,
      styles: [...styles],
      avoid: [],
    })),
    describe,
  };
}

const SAME_SHAPE = 'the drop at 0:18, the end on the logo.';
const DEMO_LINE =
  'Intense cinematic electronic, 120 BPM. Builds to a big drop at 0:18 and lands on the logo at 0:35.';
const DEMO_PLAN = plan(39, DEMO_LINE);
const FAQ_PLAN = plan(
  41,
  'Sparse and calm, 90 BPM. A soft build, the answer on top, a gentle end.',
);
const FOLDER_PLAN = plan(
  44,
  'Warm summer pop, 110 BPM. Builds to the chorus at 0:18, ends on the logo.',
  38,
);

const ASK = 'darker, heavier drums';

/** The version of the edit run (or the owner's, with words). */
function version(
  id: string,
  planned: MusicPlan,
  time: string,
  by: MusicVersion['by'],
  ask: string | null,
  day: string = YESTERDAY,
): MusicVersion {
  return {
    id,
    file: `${id}.mp3`,
    // What the script writes for a version made with words, with the board's shorter second half.
    describe: ask === null ? planned.describe : `You asked: ${ask}. Same shape: ${SAME_SHAPE}`,
    ask,
    // Fixed, so the seed reads the same every time.
    seed: 4711 + Number(id.slice(1)),
    model: 'fake',
    lengthMs: planned.lengthMs,
    by,
    madeAt: at(time, day),
  };
}

export const record = (fields: Partial<MusicRecord>): MusicRecord => ({
  v: 1,
  source: 'made',
  reason: null,
  file: null,
  plan: null,
  picked: null,
  versions: [],
  picks: [],
  making: null,
  failure: null,
  song: null,
  songFailure: null,
  ...fields,
});

/** What each job's edit/music/music.json says. The record of every job that has one, in full. */
export const MUSIC_RECORDS: Readonly<Record<string, MusicRecord>> = {
  [MUSIC_IDS.demo]: record({
    plan: DEMO_PLAN,
    picked: 'v2',
    versions: [
      version('v1', DEMO_PLAN, '23:31', 'edit', null),
      version('v2', DEMO_PLAN, '23:58', 'you', ASK),
    ],
    picks: [
      { id: 'v1', at: at('23:31') },
      { id: 'v2', at: at('23:58') },
    ],
  }),
  [MUSIC_IDS.teaser]: record({
    plan: DEMO_PLAN,
    picked: 'v1',
    versions: [version('v1', DEMO_PLAN, '22:50', 'edit', null)],
    picks: [{ id: 'v1', at: at('22:50') }],
  }),
  // The run is making v1 now: the record says so, and the job is editing, so the view does too.
  [MUSIC_IDS.editing]: record({
    plan: plan(41, DEMO_LINE),
    making: { id: 'v1', ask: null, startedAt: at('00:19', TODAY) },
  }),
  [MUSIC_IDS.making]: record({
    plan: DEMO_PLAN,
    picked: 'v1',
    versions: [version('v1', DEMO_PLAN, '23:24', 'edit', null)],
    picks: [{ id: 'v1', at: at('23:24') }],
  }),
  [MUSIC_IDS.failedV2]: record({
    plan: DEMO_PLAN,
    picked: 'v1',
    versions: [version('v1', DEMO_PLAN, '23:20', 'edit', null)],
    picks: [{ id: 'v1', at: at('23:20') }],
    failure: {
      id: 'v2',
      code: 'no_credits',
      message: 'ElevenLabs says this month’s credits are used up.',
      at: at('23:40'),
    },
  }),
  // The edit run's first make found no credits: no version, nothing picked, silence in the composition.
  [MUSIC_IDS.failedV1]: record({
    plan: plan(41, DEMO_LINE),
    failure: {
      id: 'v1',
      code: 'no_credits',
      message: 'ElevenLabs says this month’s credits are used up.',
      at: at('00:16', TODAY),
    },
  }),
  [MUSIC_IDS.off]: record({
    plan: DEMO_PLAN,
    picked: 'off',
    versions: [
      version('v1', DEMO_PLAN, '22:05', 'edit', null),
      version('v2', DEMO_PLAN, '22:12', 'you', null),
    ],
    picks: [
      { id: 'v1', at: at('22:05') },
      { id: 'v2', at: at('22:12') },
      { id: 'off', at: at('22:14') },
    ],
  }),
  [MUSIC_IDS.folder]: record({
    source: 'supplied',
    file: 'Summer Vibes.mp3',
    plan: FOLDER_PLAN,
    picked: 'file',
    picks: [{ id: 'file', at: at('22:15') }],
  }),
  [MUSIC_IDS.folderApproved]: record({
    source: 'supplied',
    file: 'Summer Vibes.mp3',
    picked: 'file',
    picks: [{ id: 'file', at: at('09:55', TODAY) }],
  }),
  [MUSIC_IDS.noStyle]: record({
    source: 'none',
    reason: 'The client’s style says no music under the lawyer’s answers.',
    plan: FAQ_PLAN,
  }),
  [MUSIC_IDS.series]: record({
    source: 'series',
    file: 'edit/series/kit/assets/audio/Theme.mp3',
    picked: 'series',
    picks: [{ id: 'series', at: at('22:40') }],
  }),
};

// --- the step runs ---------------------------------------------------------------------------------

/** `[step, clock time it started, minutes it took]`, `null` minutes: still running. */
type Timed = readonly [StepId, string, number | null];

export interface RunSpec {
  jobId: string;
  runKind: 'edit' | 'render';
  day: string;
  steps: readonly Timed[];
}

/** The seven steps of a first cut from `start` (the board's lengths), ending where review waits. */
export function cut(
  jobId: string,
  start: [h: number, m: number],
  day: string = YESTERDAY,
): RunSpec {
  const lengths = [1, 1, 2, 3, 1, 1, 3] as const;
  let minutes = start[0] * 60 + start[1];
  const steps = lengths.map((length, index): Timed => {
    const time = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    minutes += length;
    return [(index + 1) as StepId, time, length];
  });
  return { jobId, runKind: 'edit', day, steps };
}

/** The steps of the job the engine is making music for: Preview is running. */
const EDITING_RUN: RunSpec = {
  jobId: MUSIC_IDS.editing,
  runKind: 'edit',
  day: TODAY,
  steps: [
    [1, '00:12', 1],
    [2, '00:13', 2],
    [3, '00:15', 1],
    [4, '00:16', 1],
    [5, '00:17', 1],
    [6, '00:18', null],
  ],
};

export const MUSIC_RUNS: readonly RunSpec[] = [
  cut(MUSIC_IDS.demo, [23, 23]),
  cut(MUSIC_IDS.teaser, [22, 44]),
  EDITING_RUN,
  cut(MUSIC_IDS.making, [23, 18]),
  cut(MUSIC_IDS.failedV2, [23, 15]),
  cut(MUSIC_IDS.failedV1, [0, 12], TODAY),
  cut(MUSIC_IDS.off, [22, 0]),
  cut(MUSIC_IDS.folder, [22, 10]),
  cut(MUSIC_IDS.folderApproved, [9, 45], TODAY),
  {
    jobId: MUSIC_IDS.folderApproved,
    runKind: 'render',
    day: TODAY,
    steps: [[8, '10:14', 1]],
  },
  cut(MUSIC_IDS.noStyle, [23, 5]),
  cut(MUSIC_IDS.series, [22, 35]),
];

// --- writing ---------------------------------------------------------------------------------------

export async function ffmpeg(args: readonly string[]): Promise<void> {
  try {
    await execFileAsync('ffmpeg', [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      ...args,
    ]);
  } catch (error) {
    throw new Error(
      `The music seed needs ffmpeg (brew install ffmpeg): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** A tone of `seconds` at `hz`, as an mp3: the folder's and the series' music. */
export async function writeTone(path: string, seconds: number, hz: number): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await ffmpeg([
    ...['-f', 'lavfi', '-i', `sine=frequency=${hz}:sample_rate=44100:duration=${seconds}`],
    ...['-b:a', '128k', path],
  ]);
}

/** A triangle wave between 0 and 1 in ffmpeg's expression language, sharp at both ends: a ridge line. */
const tri = (x: string): string => `abs(mod(${x},2)-1)`;

/**
 * One frame of a low mountain meadow (the boards' FPV shot: a sky, a far ridge, a near ridge and a
 * green meadow) at the composition's 9:16, drawn by ffmpeg alone: a different expression for each
 * layer, the same one for the three colour channels.
 */
async function meadowFrame(path: string): Promise<void> {
  const far = `215+70*${tri('X/150+0.2')}`;
  const near = `300+40*${tri('X/110+0.55')}`;
  const channel = (sky: readonly [number, number], farC: number, nearC: number, ground: number) =>
    `if(gt(Y,375),${ground},if(gt(Y,${near}),${nearC},if(gt(Y,${far}),${farC},${sky[0]}+(${sky[1]}-${sky[0]})*min(1,Y/360))))`;
  const r = channel([111, 232], 124, 63, 78);
  const g = channel([168, 241], 140, 91, 122);
  const b = channel([220, 248], 154, 58, 53);
  await ffmpeg([
    ...['-f', 'lavfi', '-i', `color=c=black:s=${CUT_WIDTH}x${CUT_HEIGHT}`],
    ...['-vf', `format=rgb24,geq=r='${r}':g='${g}':b='${b}'`],
    ...['-frames:v', '1', path],
  ]);
}

/** The cut's frame size: the sample composition's 9:16, small. */
const CUT_WIDTH = 360;
const CUT_HEIGHT = 640;

/**
 * The sample composition of the Review seed, as long as the board's cut: the sample's own files, with
 * the cut a slow pan over the meadow (a silent track, as the composition expects one) and every 6 s
 * in the composition made `seconds` (the root, the cut and the progress bar).
 */
export async function stretchedSample(
  samples: string,
  workDir: string,
  seconds: number,
): Promise<string> {
  const target = join(workDir, `sample-${seconds}`);
  await cp(samples, target, { recursive: true });
  const frame = join(workDir, 'meadow.png');
  if (
    !(await readFile(frame).then(
      () => true,
      () => false,
    ))
  )
    await meadowFrame(frame);
  await ffmpeg([
    ...['-loop', '1', '-framerate', '25', '-i', frame],
    ...['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo'],
    ...['-t', String(seconds)],
    ...[
      '-vf',
      `scale=${CUT_WIDTH * 1.2}:${CUT_HEIGHT * 1.2},crop=${CUT_WIDTH}:${CUT_HEIGHT}:x='${CUT_WIDTH * 0.1}+${CUT_WIDTH * 0.08}*sin(t*0.5)':y='${CUT_HEIGHT * 0.1}+${CUT_HEIGHT * 0.03}*sin(t*0.35)',format=yuv420p`,
    ],
    ...['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30'],
    ...['-c:a', 'aac', '-b:a', '48k', '-movflags', '+faststart'],
    join(target, 'cut.mp4'),
  ]);
  const index = join(target, 'index.html');
  const html = (await readFile(index, 'utf8'))
    .replaceAll('data-duration="6"', `data-duration="${seconds}"`)
    .replace('duration: 6, ease: "none"', `duration: ${seconds}, ease: "none"`);
  await writeFile(index, html);
  return target;
}

export interface SeedMusicOptions {
  inboxPath: string;
  /** The seed's own folder, for the stretched samples. */
  dir: string;
  /** The sample composition (apps/server/src/pipeline/testdata/preview/). */
  samplePreviewDir: string;
  /** Every time moves by this much, as the jobs' did. */
  shiftMs?: number;
  specs?: readonly CanvasJobSpec[];
  /** Runs the music script. Default: the real one, in `dir`. */
  run?: MusicScriptRunner;
}

/** A call of the script that must work: it makes the seed's mp3s. */
export async function script(run: MusicScriptRunner, argv: readonly string[]): Promise<void> {
  const call: MusicScriptCall = { argv, timeoutMs: 60_000 };
  const outcome: MusicScriptOutcome = await run(call);
  if (outcome.kind !== 'ran' || outcome.line?.ok !== true) {
    throw new Error(`The music script failed: ${JSON.stringify(outcome)}`);
  }
}

/** The time of every field of a record moved by `shiftMs`. */
export function shifted(source: MusicRecord, shiftMs: number): MusicRecord {
  if (shiftMs === 0) return source;
  const move = (iso: string): string => new Date(Date.parse(iso) + shiftMs).toISOString();
  return {
    ...source,
    versions: source.versions.map((each) => ({ ...each, madeAt: move(each.madeAt) })),
    picks: source.picks.map((each) => ({ ...each, at: move(each.at) })),
    making:
      source.making === null
        ? null
        : { ...source.making, startedAt: move(source.making.startedAt) },
    failure: source.failure === null ? null : { ...source.failure, at: move(source.failure.at) },
    song: source.song === null ? null : { ...source.song, gotAt: move(source.song.gotAt) },
    songFailure:
      source.songFailure === null
        ? null
        : { ...source.songFailure, at: move(source.songFailure.at) },
  };
}

/**
 * Writes what each job of the music seed has on disk: the preview composition (stretched to the
 * cut's length, playing music.mp3 when there is one), edit/music/ with its plan, versions and
 * music.json, and the folder's or the series' music file.
 */
export async function seedMusicFiles({
  inboxPath,
  dir,
  samplePreviewDir,
  shiftMs = 0,
  specs = MUSIC_JOB_SPECS,
  run = createMusicScriptRunner({ cwd: dir }),
}: SeedMusicOptions): Promise<void> {
  const workDir = join(dir, 'music-seed');
  await mkdir(workDir, { recursive: true });
  const samples = new Map<number, string>();

  for (const spec of specs) {
    const music = MUSIC_RECORDS[spec.id];
    const jobDir = join(inboxPath, spec.client, spec.name);
    const editDir = join(jobDir, 'edit');
    const musicDir = join(editDir, MUSIC_FILES.dir);
    await mkdir(musicDir, { recursive: true });

    if (music !== undefined) {
      if (music.plan !== null) {
        await writeFile(
          join(editDir, MUSIC_FILES.plan),
          `${JSON.stringify(music.plan, null, 2)}\n`,
        );
      }
      const writeRecord = async (): Promise<void> => {
        const checked = musicRecordSchema.parse(shifted(music, shiftMs));
        await writeFile(join(editDir, MUSIC_FILES.record), `${JSON.stringify(checked, null, 2)}\n`);
      };

      if (music.source === 'made' && music.versions.length > 0) {
        // One make for each version (the script's fake path: a tone, a different note per version).
        for (let index = 0; index < music.versions.length; index += 1) {
          await script(run, ['make', editDir, '--by', 'edit', '--fake']);
        }
        if (music.picked !== null && music.picked !== music.versions.at(-1)?.id) {
          await script(run, ['pick', editDir, music.picked]);
        }
      } else if (music.source === 'made' && music.plan !== null && music.failure !== null) {
        // The first make found no credits: the script leaves silence of the plan's length.
        await writeRecord();
        await script(run, ['pick', editDir, 'off']);
      } else if (music.source === 'supplied') {
        const file = join(jobDir, 'Summer Vibes.mp3');
        await writeTone(file, 44, 392);
        await script(run, ['supplied', editDir, 'Summer Vibes.mp3']);
      } else if (music.source === 'series' && music.file !== null) {
        await writeTone(join(jobDir, music.file), 38, 330);
        await script(run, ['series', editDir, music.file]);
      }
      if (music.picked === 'off' && music.versions.length > 0) {
        await script(run, ['pick', editDir, 'off']);
      }
      await writeRecord();
    }

    // The composition of a job that waits for review: as long as the cut, playing music.mp3 when
    // the job has one (a job whose music is none has no music element, as the prompts say).
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
}

/** Writes the step runs of the music seed's jobs into a database that has the jobs. */
export function seedMusicRuns(
  db: StudioDb,
  shiftMs = 0,
  runs: readonly RunSpec[] = MUSIC_RUNS,
): void {
  const ms = (iso: string): number => Date.parse(iso) + shiftMs;
  for (const spec of runs) {
    for (const [step, start, minutes] of spec.steps) {
      const startedAt = ms(at(start, spec.day));
      db.orm
        .insert(stepRuns)
        .values({
          jobId: spec.jobId,
          step,
          startedAt,
          endedAt: minutes === null ? null : startedAt + minutes * 60_000,
          footageSeconds: 0,
          runKind: spec.runKind,
        })
        .run();
    }
  }
}

/**
 * A music runner that never finishes the `make` of `holdFolder` (a job's folder): it answers once it
 * is aborted. That is how the seed shows "Demo 3" as being made, for as long as the seed runs. Every
 * other call goes to `run`.
 */
export function holdingRunner(run: MusicScriptRunner, holdFolder: string): MusicScriptRunner {
  return (call) => {
    const held = call.argv[0] === 'make' && (call.argv[1] ?? '').startsWith(holdFolder);
    if (!held) return run(call);
    return new Promise<MusicScriptOutcome>((resolve) => {
      const stop = (): void =>
        resolve({
          kind: 'stopped',
          reason: call.signal?.reason === 'shutdown' ? 'shutdown' : 'cancel',
        });
      if (call.signal?.aborted) stop();
      else call.signal?.addEventListener('abort', stop, { once: true });
    });
  };
}
