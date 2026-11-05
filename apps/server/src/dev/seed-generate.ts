// Dev fixture for Generated videos' design QA (GN8, GN9): `pnpm seed:canvas --generate` seeds
// the jobs below so Review's format switch and the note hints (GN8), and the Jobs row, the job
// sheet and the phone (GN9), can be looked at, on the Mac and on the phone, with no Higgsfield or
// ElevenLabs call and no key.
//
// Four jobs in Review (GN8):
//
//   "97 Window Ad"      Pinewood: generated, two formats (9:16 and 1:1), $2.33 of the $3 spent. It has
//                     the three notes of the board GNReview, the last one written on 1:1
//   "Spring promo"    Kova Coffee: generated, one format: the hints without "both formats"
//   "Studio tour"     Arc Fitness: an ordinary job in Review: Review is exactly what it always was
//   "Brand film"      Lumen Dental: two formats but not generated: the switch without the hints
//
// And one Pinewood job for each state of the boards GNStates and GNSheet (GN9), all named
// "97 Window Ad · <state>": the Brief at work, the voice (3/7), the looks (2/3), the keyframes (5/7),
// the clips (4/6, $1.65), the Higgsfield balance empty, the key not accepted, over the budget
// ($4.10 against $3), the budget ran out (1 clip below the bar), and approved with a file for each
// format. Each has the stage's History (edit/generate/history.jsonl), its step runs and, where the
// board shows them, its files.
//
// The Generate switch is forced on for this app only (`/api/health` says `generate: true`). Each
// generated job has the rows the Jobs list reads (`job_generate`), the hand-off files the hints
// read (edit/generate/shots.json and voice-words.json) and a live composition for each format: the
// sample composition (6 s) at 1080x1920, and for 1:1 a copy at 1080x1080 whose title says "1:1".
// The nine-clip PINEWOOD shape of the board is not drawn here: four clips and three voice lines over
// the sample's six seconds, with the board's prices ($0.36, $0.51, $0.18, $0.34). GN10 completes
// this seed. Dev-only: nothing in apps/ imports it but the seed.

import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  GENERATE_FILES,
  type GenerateCounts,
  type GenerateHistoryEvent,
  type GenerateShots,
  type GenerateVoiceWords,
  generateErrorMessage,
  type StepId,
} from '@studio/shared';
import type { GenerateRepository, NoteRepository, StudioDb } from '../db/index.js';
import type { JobRepository } from '../db/job-repository.js';
import { stepRuns } from '../db/schema.js';
import type { CanvasJobSpec } from './seed-canvas.js';

const GB = 1_000_000_000;

/** The jobs of the Generate seed, by what they show. */
export const GENERATE_IDS = {
  pinewood: 'gn-pinewood',
  single: 'gn-single',
  footage: 'gn-footage',
  twoFormats: 'gn-two-formats',
  // One job for each state of the boards GNStates and GNSheet (GN9).
  brief: 'gn-s-brief',
  voice: 'gn-s-voice',
  looks: 'gn-s-looks',
  keyframes: 'gn-s-keyframes',
  clips: 'gn-s-clips',
  balance: 'gn-s-balance',
  key: 'gn-s-key',
  over: 'gn-s-over',
  budget: 'gn-s-budget',
  approved: 'gn-s-approved',
} as const;

/** The cut's length: the sample composition's. */
const CUT_SEC = 6;

const MOMENT = Date.parse('2026-10-20T13:42:00.000Z');

function spec(
  id: string,
  client: string,
  name: string,
  minutesAgo: number,
  extra: Partial<CanvasJobSpec> = {},
): CanvasJobSpec {
  return {
    id,
    client,
    name,
    state: 'review',
    inputs: [0, 0, 0, 1],
    sizeBytes: 0.4 * GB,
    addedAt: new Date(MOMENT - (minutesAgo + 40) * 60_000).toISOString(),
    updatedAt: new Date(MOMENT - minutesAgo * 60_000).toISOString(),
    step: 7,
    preview: { durationSec: CUT_SEC, width: 1080, height: 1920 },
    sampleShape: 'portrait',
    ...extra,
  };
}

/** The four jobs in Review of GN8. */
const REVIEW_SPECS: readonly CanvasJobSpec[] = [
  spec(GENERATE_IDS.pinewood, 'Pinewood', '97 Window Ad', 1),
  spec(GENERATE_IDS.single, 'Kova Coffee', 'Spring promo', 2),
  spec(GENERATE_IDS.footage, 'Arc Fitness', 'Studio tour', 3, { inputs: [8, 0, 1, 0] }),
  spec(GENERATE_IDS.twoFormats, 'Lumen Dental', 'Brand film', 4, { inputs: [6, 1, 0, 0] }),
];

/** The Pinewood ad in one state: a job of its own, in the folder `Pinewood/97 Window Ad · <label>`. */
function stateSpec(
  id: string,
  label: string,
  minutesAgo: number,
  extra: Partial<CanvasJobSpec> & Pick<CanvasJobSpec, 'state'>,
): CanvasJobSpec {
  return {
    id,
    client: 'Pinewood',
    name: `97 Window Ad · ${label}`,
    // Seven references and the brief: no video in the folder.
    inputs: [0, 0, 7, 2],
    sizeBytes: 0.02 * GB,
    // The folder arrived well before the stage began.
    addedAt: new Date(MOMENT - 120 * 60_000).toISOString(),
    updatedAt: new Date(MOMENT - minutesAgo * 60_000).toISOString(),
    ...extra,
  };
}

const APPROVED_AT = new Date(MOMENT - 7 * 60_000).toISOString();

/** The fixed errors of the failed states, the engine's own sentences. */
const BALANCE_ERROR = generateErrorMessage('balance_empty');
const KEY_ERROR = generateErrorMessage('key_rejected');
const OVER_ERROR = generateErrorMessage('over_budget', { needUsd: 4.1, budgetUsd: 3 });

/** The files of the approved job: one video for each format, the main one first. */
const APPROVED_OUTPUT = {
  durationSec: 35,
  width: 1080,
  height: 1920,
  sizeBytes: 27_000_000,
  outputs: [
    { format: '9x16', fileName: 'Pinewood/97 Window Ad · approved.mp4', bytes: 27_000_000 },
    { format: '1x1', fileName: 'Pinewood/97 Window Ad · approved (1x1).mp4', bytes: 21_000_000 },
  ],
};

const REVIEW_PREVIEW = { durationSec: 35, width: 1080, height: 1920 } as const;

const STATE_SPECS: readonly CanvasJobSpec[] = [
  stateSpec(GENERATE_IDS.brief, 'brief', 5, {
    state: 'editing',
    step: 1,
    subProgress: 'reading 9 files',
  }),
  stateSpec(GENERATE_IDS.voice, 'voice', 6, {
    state: 'editing',
    step: 1,
    subProgress: 'Generate · voice 3/7',
  }),
  stateSpec(GENERATE_IDS.looks, 'looks', 7, {
    state: 'editing',
    step: 1,
    subProgress: 'Generate · looks 2/3',
  }),
  stateSpec(GENERATE_IDS.keyframes, 'keyframes', 8, {
    state: 'editing',
    step: 1,
    subProgress: 'Generate · keyframes 5/7',
  }),
  stateSpec(GENERATE_IDS.clips, 'clips', 9, {
    state: 'editing',
    step: 1,
    subProgress: 'Generate · clips 4/6 · $1.65',
  }),
  stateSpec(GENERATE_IDS.balance, 'balance empty', 10, {
    state: 'failed',
    step: 1,
    failedAt: 1,
    error: BALANCE_ERROR,
  }),
  stateSpec(GENERATE_IDS.key, 'key not accepted', 11, {
    state: 'failed',
    step: 1,
    failedAt: 1,
    error: KEY_ERROR,
  }),
  stateSpec(GENERATE_IDS.over, 'over the budget', 12, {
    state: 'failed',
    step: 1,
    failedAt: 1,
    error: OVER_ERROR,
  }),
  stateSpec(GENERATE_IDS.budget, 'budget ran out', 8, {
    state: 'review',
    step: 7,
    preview: REVIEW_PREVIEW,
    sampleShape: 'portrait',
  }),
  stateSpec(GENERATE_IDS.approved, 'approved', 2, {
    state: 'ready',
    step: 8,
    runKind: 'render',
    preview: REVIEW_PREVIEW,
    sampleShape: 'portrait',
    approvedAt: APPROVED_AT,
    output: APPROVED_OUTPUT,
  }),
];

export const GENERATE_JOB_SPECS: readonly CanvasJobSpec[] = [...REVIEW_SPECS, ...STATE_SPECS];

/** The sample composition at 1080x1080, from the portrait one. */
const PORTRAIT_TO_SQUARE: readonly (readonly [from: string, to: string])[] = [
  ['data-width="1080" data-height="1920"', 'data-width="1080" data-height="1080"'],
  ['width: 1080px; height: 1920px;', 'width: 1080px; height: 1080px;'],
  ['width=1080, height=1920', 'width=1080, height=1080'],
];

/**
 * The clips of the cut: what each shows, over which stretch of it, and what its kept take cost. The
 * last second is the end card (HyperFrames): no clip is on screen there.
 */
const CLIPS: GenerateShots['shots'] = [
  clip('A', 'The hero skylight', 0.36, [[0, 1.4]]),
  clip('B', 'The homeowner pours water', 0.51, [[1.4, 3.4]]),
  clip('C', 'The homeowner asleep', 0.18, [[3.4, 4.5]]),
  clip('D', 'The technician at the squeegee', 0.34, [[4.5, 5.2]]),
];

function clip(id: string, shows: string, usd: number, windows: [number, number][]) {
  return {
    id,
    file: `clips/${id}/take-1.mp4`,
    take: 1,
    windows: windows.map(([startSec, endSec]) => ({ startSec, endSec })),
    seconds: 5,
    shows,
    model: 'kling-2-5-turbo',
    usd,
    belowBar: false,
  };
}

/** The voice: three lines over the cut. */
const WORDS: GenerateVoiceWords['words'] = [
  { line: 'L1', text: 'You', startSec: 0.4, endSec: 0.8 },
  { line: 'L1', text: 'always', startSec: 0.8, endSec: 1.4 },
  { line: 'L1', text: 'think', startSec: 1.4, endSec: 2.2 },
  { line: 'L2', text: 'But', startSec: 2.2, endSec: 2.8 },
  { line: 'L2', text: 'what', startSec: 2.8, endSec: 3.4 },
  { line: 'L2', text: 'about', startSec: 3.4, endSec: 4 },
  { line: 'L3', text: 'the', startSec: 4, endSec: 4.4 },
  { line: 'L3', text: 'air', startSec: 4.4, endSec: 5.8 },
];

/** The board's three notes: a hand in a clip, a stressed word, and the end card on 1:1. */
const NOTES = [
  { id: 'gn-n1', atSec: 2.4, text: 'Their left hand bends oddly while he pours.', format: null },
  { id: 'gn-n2', atSec: 3, text: 'Stress the BUT more, with a real pause after it.', format: null },
  { id: 'gn-n3', atSec: 5.4, text: 'End card: logo bigger, the button lower.', format: '1x1' },
] as const;

/** A moment, in minutes from the seed's "now" (negative: before it). */
const minute = (min: number): string => new Date(MOMENT + min * 60_000).toISOString();

const PLAN_COUNTS = {
  voice: { done: 7, total: 7 },
  looks: { done: 3, total: 3 },
  keyframes: { done: 7, total: 7 },
  clips: { done: 6, total: 6 },
  belowBar: 0,
} satisfies GenerateCounts;

/** The counts of a stage that has made `made` of its parts and not started the rest. */
function counts(made: Partial<GenerateCounts>): GenerateCounts {
  return {
    voice: { done: 0, total: 7 },
    looks: { done: 0, total: 3 },
    keyframes: { done: 0, total: 7 },
    clips: { done: 0, total: 6 },
    belowBar: 0,
    ...made,
  };
}

/** What the stage's History says it did, for a stage that began `t0` minutes from now (negative). */
function timeline(t0: number) {
  return {
    decided: { kind: 'decided', at: minute(t0), formats: ['9:16', '1:1'] } as GenerateHistoryEvent,
    unpacked: {
      kind: 'unpacked',
      at: minute(t0),
      count: 7,
      what: 'logo, equipment, ladder, an older ad, a skylight clip',
    } as GenerateHistoryEvent,
    voice: { kind: 'voice', at: minute(t0 + 3), lines: 7, seconds: 31 } as GenerateHistoryEvent,
    looks: {
      kind: 'looks',
      at: minute(t0 + 7),
      names: ['the homeowner', 'the technician with the logo', 'the hero skylight'],
    } as GenerateHistoryEvent,
    keyframes: { kind: 'keyframes', at: minute(t0 + 11), clips: 6 } as GenerateHistoryEvent,
    clipA: {
      kind: 'clip',
      at: minute(t0 + 15),
      id: 'A',
      shows: 'the hero skylight',
      take: 1,
    } as GenerateHistoryEvent,
    clipD: {
      kind: 'clip',
      at: minute(t0 + 19),
      id: 'D',
      shows: 'the squeegee press',
      take: 1,
    } as GenerateHistoryEvent,
  };
}

interface StateRow {
  id: string;
  phase: 'plan' | 'voice' | 'looks' | 'keyframes' | 'clips' | 'sound' | 'done';
  counts: GenerateCounts;
  spendUsd: number;
  history: readonly GenerateHistoryEvent[];
  /** The step runs: [step, start minute, length in minutes (null: still open), run kind]. */
  runs: readonly (readonly [
    step: StepId,
    start: number,
    length: number | null,
    kind?: 'edit' | 'render',
  ])[];
}

/** The Brief ended where Generate began. */
const briefRun = (t0: number) => [1, t0 - 1, 1] as const;
/** The edit after Generate: Transcribe to Check. */
const editRuns = (t0: number) =>
  [
    [2, t0 + 31, 1],
    [3, t0 + 32, 2],
    [4, t0 + 34, 6],
    [5, t0 + 40, 7],
    [6, t0 + 47, 3],
    [7, t0 + 50, 1],
  ] as const;

// Stages that are still at work began 20 minutes ago; the ones that stopped began a little before
// their stop; a finished one began an hour ago.
const LIVE = timeline(-20);
const STOPPED_CLIPS = timeline(-35);
const STOPPED_VOICE = timeline(-20);
const STOPPED_BUDGET = timeline(-18);
const DONE = timeline(-60);

const STATE_ROWS: readonly StateRow[] = [
  {
    id: GENERATE_IDS.voice,
    phase: 'voice',
    counts: counts({ voice: { done: 3, total: 7 } }),
    spendUsd: 0,
    history: [LIVE.decided, LIVE.unpacked],
    runs: [briefRun(-20)],
  },
  {
    id: GENERATE_IDS.looks,
    phase: 'looks',
    counts: counts({ voice: { done: 7, total: 7 }, looks: { done: 2, total: 3 } }),
    spendUsd: 0.01,
    history: [LIVE.decided, LIVE.unpacked, LIVE.voice],
    runs: [briefRun(-20)],
  },
  {
    id: GENERATE_IDS.keyframes,
    phase: 'keyframes',
    counts: counts({
      voice: { done: 7, total: 7 },
      looks: { done: 3, total: 3 },
      keyframes: { done: 5, total: 7 },
    }),
    spendUsd: 0.04,
    history: [LIVE.decided, LIVE.unpacked, LIVE.voice, LIVE.looks],
    runs: [briefRun(-20)],
  },
  {
    id: GENERATE_IDS.clips,
    phase: 'clips',
    counts: counts({
      voice: { done: 7, total: 7 },
      looks: { done: 3, total: 3 },
      keyframes: { done: 7, total: 7 },
      clips: { done: 4, total: 6 },
    }),
    spendUsd: 1.65,
    history: [
      LIVE.decided,
      LIVE.unpacked,
      LIVE.voice,
      LIVE.looks,
      LIVE.keyframes,
      LIVE.clipA,
      LIVE.clipD,
    ],
    runs: [briefRun(-20)],
  },
  {
    id: GENERATE_IDS.balance,
    phase: 'clips',
    counts: counts({
      voice: { done: 7, total: 7 },
      looks: { done: 3, total: 3 },
      keyframes: { done: 7, total: 7 },
      clips: { done: 4, total: 6 },
    }),
    spendUsd: 1.65,
    history: [
      STOPPED_CLIPS.decided,
      STOPPED_CLIPS.unpacked,
      STOPPED_CLIPS.voice,
      STOPPED_CLIPS.looks,
      STOPPED_CLIPS.keyframes,
      STOPPED_CLIPS.clipA,
      STOPPED_CLIPS.clipD,
      { kind: 'stopped', at: minute(-10), code: 'balance_empty' },
    ],
    runs: [briefRun(-35)],
  },
  {
    id: GENERATE_IDS.key,
    phase: 'looks',
    counts: counts({ voice: { done: 7, total: 7 } }),
    spendUsd: 0,
    history: [
      STOPPED_VOICE.decided,
      STOPPED_VOICE.unpacked,
      STOPPED_VOICE.voice,
      { kind: 'stopped', at: minute(-11), code: 'key_rejected' },
    ],
    runs: [briefRun(-20)],
  },
  {
    id: GENERATE_IDS.over,
    phase: 'looks',
    counts: counts({ voice: { done: 7, total: 7 } }),
    spendUsd: 0,
    history: [
      STOPPED_BUDGET.decided,
      STOPPED_BUDGET.unpacked,
      STOPPED_BUDGET.voice,
      { kind: 'stopped', at: minute(-12), code: 'over_budget', needUsd: 4.1, budgetUsd: 3 },
    ],
    runs: [briefRun(-18)],
  },
  {
    id: GENERATE_IDS.budget,
    phase: 'done',
    counts: { ...PLAN_COUNTS, belowBar: 1 },
    spendUsd: 3,
    history: [
      DONE.decided,
      DONE.unpacked,
      DONE.voice,
      DONE.looks,
      DONE.keyframes,
      { kind: 'budget', at: minute(-30), id: 'B' },
    ],
    runs: [briefRun(-60), ...editRuns(-60)],
  },
  {
    id: GENERATE_IDS.approved,
    phase: 'done',
    counts: PLAN_COUNTS,
    spendUsd: 2.84,
    history: [
      DONE.decided,
      DONE.unpacked,
      DONE.voice,
      DONE.looks,
      DONE.keyframes,
      DONE.clipA,
      DONE.clipD,
      { kind: 'clips_done', at: minute(-33), count: 6 },
    ],
    runs: [briefRun(-60), ...editRuns(-60), [8, -7, 4, 'render']],
  },
];

/** The Brief job: no Generate row yet, only its open Brief run. */
const BRIEF_ROW_RUNS = [[1, -5, null]] as const;

export interface SeedGenerateOptions {
  jobs: JobRepository;
  generate: GenerateRepository;
  notes: NoteRepository;
  /** The database, for the jobs' step runs (the sheet's Steps read their times). */
  db: StudioDb;
  /** The exports folder: the second file of the approved job goes beside its first. */
  exportsDir: string;
  /** How far the seed's clock is from the board's: every time here is moved by it. */
  shiftMs?: number;
  inboxPath: string;
  /** The sample composition (1080x1920, 6 s) the previews are copied from. */
  samplePreviewDir: string;
  /** Leave the board's three notes out (Review opens with none). */
  noNotes?: boolean;
}

async function writeJson(path: string, body: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(body, null, 2)}\n`);
}

/** A copy of the sample composition for the extra format, in edit/preview-1x1/, titled "<job> · 1:1". */
async function writeSquarePreview(
  jobDir: string,
  samplePreviewDir: string,
  name: string,
): Promise<void> {
  const dir = join(jobDir, 'edit', 'preview-1x1');
  await cp(samplePreviewDir, dir, { recursive: true });
  const edit = async (relPath: string, change: (text: string) => string): Promise<void> => {
    const path = join(dir, relPath);
    await writeFile(path, change(await readFile(path, 'utf8')));
  };
  const square = (text: string): string =>
    PORTRAIT_TO_SQUARE.reduce((acc, [from, to]) => acc.replaceAll(from, to), text);
  await edit('index.html', (text) => square(text.replaceAll('Sample preview', `${name} · 1:1`)));
  await edit('compositions/badge.html', square);
}

/**
 * Gives the jobs of {@link GENERATE_JOB_SPECS} what makes them what they are: the formats, the
 * Generate rows, the hand-off files and the board's notes. The jobs themselves and the main
 * composition (`edit/preview/`) are written by the seed's usual steps.
 */
export async function seedGenerate({
  jobs,
  generate,
  notes,
  db,
  exportsDir,
  shiftMs = 0,
  inboxPath,
  samplePreviewDir,
  noNotes = false,
}: SeedGenerateOptions): Promise<void> {
  const dirOf = (spec: CanvasJobSpec): string => join(inboxPath, spec.client, spec.name);
  const byId = new Map(GENERATE_JOB_SPECS.map((one) => [one.id, one]));

  // The formats: the Pinewood ad and the brand film ask for two; the spring promo keeps its one.
  const TWO_FORMATS = [
    GENERATE_IDS.pinewood,
    GENERATE_IDS.twoFormats,
    GENERATE_IDS.budget,
    GENERATE_IDS.approved,
  ];
  for (const id of TWO_FORMATS) jobs.setFormats(id, ['1080x1920', '1080x1080']);
  for (const id of TWO_FORMATS) {
    const one = byId.get(id) as CanvasJobSpec;
    await writeSquarePreview(dirOf(one), samplePreviewDir, one.name);
  }

  // The Generate rows and the hand-off files of the two generated jobs: $2.33 of the $3 spent.
  for (const id of [GENERATE_IDS.pinewood, GENERATE_IDS.single]) {
    const one = byId.get(id) as CanvasJobSpec;
    generate.start(id, 3);
    generate.update(id, {
      phase: 'done',
      voice: { done: 3, total: 3 },
      looks: { done: 2, total: 2 },
      keyframes: { done: 4, total: 4 },
      clips: { done: 4, total: 4 },
      belowBar: 0,
      spendUsd: 2.33,
    });
    const generateDir = join(dirOf(one), 'edit', GENERATE_FILES.dir);
    await writeJson(join(generateDir, 'shots.json'), { shots: CLIPS });
    await writeJson(join(generateDir, 'voice-words.json'), { words: WORDS });
  }

  // The board's notes on the Pinewood ad (the last one on 1:1) and on the spring promo.
  if (!noNotes) {
    for (const id of [GENERATE_IDS.pinewood, GENERATE_IDS.single]) {
      for (const note of NOTES) {
        if (id === GENERATE_IDS.single && note.format !== null) continue;
        notes.create({
          id: `${note.id}-${id}`,
          jobId: id,
          kind: 'text',
          atSec: note.atSec,
          text: note.text,
          format: id === GENERATE_IDS.pinewood ? note.format : null,
        });
      }
    }
  }

  // GN9: one job for each state of the boards: the Generate row, its History, the step runs and
  // the files the sheet shows.
  const tick = (iso: string): number => Date.parse(iso) + shiftMs;
  for (const row of STATE_ROWS) {
    const one = byId.get(row.id) as CanvasJobSpec;
    generate.start(row.id, 3);
    generate.update(row.id, {
      phase: row.phase,
      voice: row.counts.voice,
      looks: row.counts.looks,
      keyframes: row.counts.keyframes,
      clips: row.counts.clips,
      belowBar: row.counts.belowBar,
      spendUsd: row.spendUsd,
    });
    const generateDir = join(dirOf(one), 'edit', GENERATE_FILES.dir);
    await mkdir(generateDir, { recursive: true });
    await writeFile(
      join(generateDir, 'history.jsonl'),
      `${row.history
        .map((event) => JSON.stringify({ ...event, at: new Date(tick(event.at)).toISOString() }))
        .join('\n')}\n`,
    );
    if (row.id === GENERATE_IDS.budget) {
      // Clip B kept its best take, below the bar: the sheet names it.
      const below = CLIPS.map((one) =>
        one.id === 'B' ? { ...one, shows: 'The pour and the tilt up', belowBar: true } : one,
      );
      await writeJson(join(generateDir, 'shots.json'), { shots: below });
    }
  }
  for (const [id, runs] of [
    [GENERATE_IDS.brief, BRIEF_ROW_RUNS],
    ...STATE_ROWS.map((row) => [row.id, row.runs] as const),
  ] as const) {
    for (const [step, start, length, kind] of runs as StateRow['runs']) {
      const startedAt = tick(minute(start));
      db.orm
        .insert(stepRuns)
        .values({
          jobId: id,
          step,
          startedAt,
          endedAt: length === null ? null : startedAt + length * 60_000,
          footageSeconds: 0,
          runKind: kind ?? 'edit',
        })
        .run();
    }
  }
  // The approved job has a file for each format: the first is written with the seed's other
  // exports; this is the second.
  const approved = byId.get(GENERATE_IDS.approved) as CanvasJobSpec;
  for (const file of approved.output?.outputs ?? []) {
    const path = join(exportsDir, file.fileName);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, Buffer.alloc(16 * 1024));
  }
}
