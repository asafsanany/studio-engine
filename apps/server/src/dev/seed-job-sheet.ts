// Dev fixture for the Job sheet boards (CVP-220): one job per state of JSStatesA and JSStatesB
// (thirteen), with the names, clients, inputs, times, notes, step runs and sent review notes each
// board shows, so `pnpm seed:canvas --sheet` opens the sheet on every state as drawn. It is the
// server-side twin of the web's `features/job-sheet/test-fixtures.ts`; keep the two alike.
//
// - Times are UTC clock times on Thu 22 Oct 2026, the day the boards call "Today" (a job added
//   earlier is on its own day). Open the page in UTC to read them as the boards do.
// - `Job.round` counts the rounds of notes sent: the board's "Ready to review · round 2" is
//   `round: 1`, with notes "from round 1". A step run's round is not stored: it follows from the
//   order the runs are written in (see `roundsOfRuns`), which is the order here.
// - A step left open (`null` minutes) is how the worker leaves the one a failed or cancelled job
//   stopped in, and the one an editing job is running.
// - The notes of the paid and archived jobs are made up: the boards only say how many rounds.
//
// Dev-only: nothing in apps/ imports it but the seed.

import type { ReviewNoteKind, RunKind, StepId, TranscriptStatus } from '@studio/shared';
import type { StudioDb } from '../db/index.js';
import { reviewNotes, stepRuns } from '../db/schema.js';
import type { CanvasJobSpec } from './seed-canvas.js';

/** The moment the first board is drawn at ("starts in 0:42"). */
export const SHEET_NOW = '2026-10-22T15:03:18.000Z';

const MB = 1_000_000;
const GB = 1_000_000_000;

/** The day the boards call "Today". */
const TODAY = '2026-10-22';

/** `15:03` or `15:03:18` on `day` (YYYY-MM-DD), as the ISO timestamp the database holds. */
function at(time: string, day: string = TODAY): string {
  return `${day}T${time.length === 5 ? `${time}:00` : time}.000Z`;
}

const LAKESHORE = 'LAKESHORE';
const RGM = 'RGM';
const LAW = 'עו״ד דוד לוי';

/** The ids the web fixtures give these jobs (sha1 of `Client/Job`, 12 hex characters). */
export const SHEET_IDS = {
  arriving: '10afe40b7085',
  queued: 'c41ae0c8a81a',
  held: 'a203704de6c2',
  editing: '6554b401d32d',
  failed: '86406f8f28d3',
  cancelled: 'e0c097576eec',
  review: 'fcb908323afd',
  reviewRound2: '3a1e02fbe1ef',
  rendering: 'a912d4e4956f',
  approved: '1e62273e8dba',
  delivered: 'b4e211bf6320',
  paid: '947ef344672b',
  archived: 'f73c96263b11',
} as const;

/** The lawyer's shows: "מיתוס או אמת" (episodes 5 and 6) and "שאלות נפוצות" (episode 5). */
export const SHEET_SERIES_JOBS = {
  myth: {
    formatJobId: SHEET_IDS.paid,
    episodes: [
      { jobId: SHEET_IDS.paid, episode: 5 },
      { jobId: SHEET_IDS.editing, episode: 6 },
    ],
  },
  faq: {
    formatJobId: SHEET_IDS.reviewRound2,
    episodes: [{ jobId: SHEET_IDS.reviewRound2, episode: 5 }],
  },
} as const;

const preview = (durationSec: number) => ({ durationSec, width: 1080, height: 1920 });

const output = (durationSec: number, megabytes: number) => ({
  durationSec,
  width: 1080,
  height: 1920,
  sizeBytes: Math.round(megabytes * MB),
});

/**
 * The thirteen jobs, in the order of the boards (JSStatesA, then JSStatesB). The id of the
 * lawyer's two series is made when they are seeded.
 */
export const SHEET_JOB_SPECS: readonly CanvasJobSpec[] = [
  {
    // "Files are still coming in": the 60-second wait ends at 15:04:00.
    id: SHEET_IDS.arriving,
    state: 'arriving',
    client: LAKESHORE,
    name: 'צילומי לקוחות – אוקטובר',
    inputs: [3, 0, 0, 0],
    sizeBytes: 1.9 * GB,
    addedAt: at('15:02'),
    lastChangeAt: at('15:03'),
    updatedAt: at('15:03'),
  },
  {
    // "#1 in line. It starts when מיתוס או אמת 6 is done."
    id: SHEET_IDS.queued,
    state: 'queued',
    client: RGM,
    name: 'טורניר בחירות – הכרזה',
    inputs: [3, 0, 2, 0],
    sizeBytes: 1.24 * GB,
    addedAt: at('14:47'),
    settledAt: at('14:48'),
    updatedAt: at('14:48'),
    note: 'Use the new logo, not the one from last year',
    effort: 'high',
  },
  {
    // "On hold since 11:20": it was queued at 11:03.
    id: SHEET_IDS.held,
    state: 'held',
    client: RGM,
    name: 'ריל השקה',
    inputs: [7, 1, 0, 0],
    sizeBytes: 2.65 * GB,
    addedAt: at('11:02'),
    heldSettledAt: at('11:03'),
    updatedAt: at('11:20'),
  },
  {
    // Episode 6 of the lawyer's show: "Cutting the video: adding graphic 2 of 5", about 4 min left.
    id: SHEET_IDS.editing,
    state: 'editing',
    client: LAW,
    name: 'מיתוס או אמת 6',
    inputs: [5, 1, 0, 1],
    sizeBytes: 2.31 * GB,
    addedAt: at('14:29'),
    settledAt: at('14:30'),
    updatedAt: at('14:55'),
    step: 5,
    subProgress: 'graphics 2/5',
    etaSec: 240,
    startedAt: at('14:30'),
  },
  {
    // "Render stopped at 12:52. Steps 1 to 7 are kept, so Retry only makes the MP4 again."
    id: SHEET_IDS.failed,
    state: 'failed',
    client: RGM,
    name: 'ראיון עם המייסד',
    inputs: [4, 1, 0, 0],
    sizeBytes: 1.48 * GB,
    addedAt: at('12:09'),
    settledAt: at('12:10'),
    updatedAt: at('12:52'),
    step: 8,
    failedAt: 8,
    error: 'ffmpeg exited with code 1:\nError writing trailer: No space left on device',
    runKind: 'render',
    preview: preview(47),
    approvedAt: at('12:50'),
    effort: 'high',
  },
  {
    // "You stopped it during Cut at 10:41. Resume picks it up again at Cut."
    id: SHEET_IDS.cancelled,
    state: 'cancelled',
    client: LAKESHORE,
    name: 'טיזר דירה לדוגמה',
    inputs: [6, 0, 0, 0],
    sizeBytes: 3.02 * GB,
    addedAt: at('10:19'),
    settledAt: at('10:20'),
    updatedAt: at('10:41'),
    step: 5,
    stoppedAt: 5,
    note: 'Only the kitchen and the balcony',
  },
  {
    // "The first cut is ready, 0:44. The MP4 is made after you approve it."
    id: SHEET_IDS.review,
    state: 'review',
    client: LAKESHORE,
    name: 'סיור בפרויקט',
    inputs: [8, 1, 3, 0],
    sizeBytes: 4.12 * GB,
    addedAt: at('13:01'),
    settledAt: at('13:02'),
    updatedAt: at('13:35'),
    step: 7,
    preview: preview(44),
    note: 'Start with the drone shot',
    sampleShape: 'portrait',
  },
  {
    // The second cut (one round of notes was sent): "It has your 3 notes from round 1."
    id: SHEET_IDS.reviewRound2,
    state: 'review',
    client: LAW,
    name: 'שאלות נפוצות 5',
    inputs: [4, 1, 0, 0],
    sizeBytes: 1.76 * GB,
    addedAt: at('11:20'),
    settledAt: at('11:21'),
    updatedAt: at('12:22'),
    step: 7,
    runKind: 'revise',
    round: 1,
    preview: preview(41),
    effort: 'high',
    sampleShape: 'portrait',
  },
  {
    // "You approved it at 15:10. Making the MP4 now." The job is editing, in its render run.
    id: SHEET_IDS.rendering,
    state: 'editing',
    client: RGM,
    name: 'חנוכה 2026',
    inputs: [5, 1, 4, 0],
    sizeBytes: 2.94 * GB,
    addedAt: at('14:01'),
    settledAt: at('14:02'),
    updatedAt: at('15:10'),
    step: 8,
    etaSec: 60,
    runKind: 'render',
    preview: preview(38),
    approvedAt: at('15:10'),
    startedAt: at('15:10'),
  },
  {
    // "The MP4 is ready: 0:30, 27 MB. It hasn't been sent to RGM yet."
    id: SHEET_IDS.approved,
    state: 'ready',
    client: RGM,
    name: 'טורניר בחירות שש בש',
    inputs: [6, 1, 2, 0],
    sizeBytes: 2.18 * GB,
    addedAt: at('11:39'),
    settledAt: at('11:40'),
    updatedAt: at('13:57'),
    step: 8,
    runKind: 'render',
    preview: preview(30),
    approvedAt: at('13:55'),
    output: output(30, 27),
  },
  {
    // "Sent to LAKESHORE on 21 Oct. ₪40 isn't paid yet."
    id: SHEET_IDS.delivered,
    state: 'ready',
    client: LAKESHORE,
    name: 'אדריכלות',
    inputs: [9, 1, 0, 0],
    sizeBytes: 3.34 * GB,
    addedAt: at('10:01', '2026-10-21'),
    settledAt: at('10:02', '2026-10-21'),
    updatedAt: at('14:00', '2026-10-21'),
    step: 8,
    runKind: 'render',
    preview: preview(52),
    approvedAt: at('12:46', '2026-10-21'),
    output: output(52, 31),
    delivery: { deliveredAt: at('14:00', '2026-10-21') },
  },
  {
    // Episode 5 of the lawyer's show, one round of notes: "Paid ₪40 on 21 Oct."
    id: SHEET_IDS.paid,
    state: 'ready',
    client: LAW,
    name: 'מיתוס או אמת 5',
    inputs: [5, 1, 0, 0],
    sizeBytes: 1.95 * GB,
    addedAt: at('16:19', '2026-10-20'),
    settledAt: at('16:20', '2026-10-20'),
    updatedAt: at('11:00', '2026-10-21'),
    step: 8,
    runKind: 'render',
    round: 1,
    preview: preview(36),
    approvedAt: at('17:38', '2026-10-20'),
    output: output(36, 26),
    delivery: { deliveredAt: at('09:00', '2026-10-21'), paidOn: at('09:30', '2026-10-21') },
  },
  {
    // "Archived on 30 Sep, so it only shows with Show archived on." Two rounds, paid 28 Sep.
    id: SHEET_IDS.archived,
    state: 'ready',
    client: RGM,
    name: 'קמפיין קיץ',
    inputs: [7, 1, 0, 0],
    sizeBytes: 2.72 * GB,
    addedAt: at('09:12', '2026-09-10'),
    settledAt: at('09:13', '2026-09-10'),
    updatedAt: at('10:00', '2026-09-28'),
    step: 8,
    runKind: 'render',
    round: 2,
    preview: preview(45),
    approvedAt: at('10:30', '2026-09-12'),
    output: output(45, 34),
    delivery: { deliveredAt: at('14:00', '2026-09-12'), paidOn: at('12:00', '2026-09-28') },
    effort: 'high',
    archivedAt: at('09:00', '2026-09-30'),
  },
];

// --- the step runs ------------------------------------------------------------------------------

/** `[step, clock time it started, minutes it took]`; `null` minutes is a run left open. */
type Timed = readonly [StepId, string, number | null];

/** One run of a job's steps: the kind of run, the day it happened on and its steps. */
interface RunSpec {
  jobId: string;
  runKind: RunKind;
  day: string;
  steps: readonly Timed[];
}

const run = (jobId: string, runKind: RunKind, day: string, steps: readonly Timed[]): RunSpec => ({
  jobId,
  runKind,
  day,
  steps,
});

/**
 * The step runs of each job in the order they were written, oldest first, with the lengths the
 * boards list per step. A job that has not started has none.
 */
export const SHEET_RUNS: readonly RunSpec[] = [
  // Cut is the running step.
  run(SHEET_IDS.editing, 'edit', TODAY, [
    [1, '14:30', 1],
    [2, '14:31', 3],
    [3, '14:34', 5],
    [4, '14:39', 2],
    [5, '14:41', null],
  ]),
  // Render was started on approval at 12:50 and failed at 12:52; the failed step stays open.
  run(SHEET_IDS.failed, 'edit', TODAY, [
    [1, '12:10', 1],
    [2, '12:11', 3],
    [3, '12:14', 5],
    [4, '12:19', 14],
    [5, '12:33', 8],
    [6, '12:41', 3],
    [7, '12:44', 1],
  ]),
  run(SHEET_IDS.failed, 'render', TODAY, [[8, '12:50', null]]),
  // Cut was stopped at 10:41; the step it stopped in stays open.
  run(SHEET_IDS.cancelled, 'edit', TODAY, [
    [1, '10:20', 1],
    [2, '10:21', 2],
    [3, '10:23', 4],
    [4, '10:27', 8],
    [5, '10:35', null],
  ]),
  // Check ended at 13:35: "Your review" has waited since then.
  run(SHEET_IDS.review, 'edit', TODAY, [
    [1, '13:02', 1],
    [2, '13:03', 3],
    [3, '13:06', 5],
    [4, '13:11', 13],
    [5, '13:24', 7],
    [6, '13:31', 3],
    [7, '13:34', 1],
  ]),
  // The first cut, then round 1's revise run from Plan ("Round 2 · from Plan").
  run(SHEET_IDS.reviewRound2, 'edit', TODAY, [
    [1, '11:21', 1],
    [2, '11:22', 3],
    [3, '11:25', 5],
    [4, '11:30', 10],
    [5, '11:40', 8],
    [6, '11:48', 3],
    [7, '11:51', 1],
  ]),
  run(SHEET_IDS.reviewRound2, 'revise', TODAY, [
    [4, '12:11', 2],
    [5, '12:13', 6],
    [6, '12:19', 2],
    [7, '12:21', 1],
  ]),
  // Approved at 15:10, Render is running.
  run(SHEET_IDS.rendering, 'edit', TODAY, [
    [1, '14:02', 1],
    [2, '14:03', 2],
    [3, '14:05', 4],
    [4, '14:09', 9],
    [5, '14:18', 6],
    [6, '14:24', 2],
    [7, '14:26', 1],
  ]),
  run(SHEET_IDS.rendering, 'render', TODAY, [[8, '15:10', null]]),
  run(SHEET_IDS.approved, 'edit', TODAY, [
    [1, '11:40', 1],
    [2, '11:41', 2],
    [3, '11:43', 4],
    [4, '11:47', 11],
    [5, '11:58', 6],
    [6, '12:04', 2],
    [7, '12:06', 1],
  ]),
  run(SHEET_IDS.approved, 'render', TODAY, [[8, '13:55', 2]]),
  run(SHEET_IDS.delivered, 'edit', '2026-10-21', [
    [1, '10:02', 1],
    [2, '10:03', 2],
    [3, '10:05', 5],
    [4, '10:10', 16],
    [5, '10:26', 7],
    [6, '10:33', 2],
    [7, '10:35', 1],
  ]),
  run(SHEET_IDS.delivered, 'render', '2026-10-21', [[8, '12:46', 2]]),
  // One round of notes: the first cut, round 1's revise run, then the render.
  run(SHEET_IDS.paid, 'edit', '2026-10-20', [
    [1, '16:20', 1],
    [2, '16:21', 3],
    [3, '16:24', 5],
    [4, '16:29', 15],
    [5, '16:44', 8],
    [6, '16:52', 2],
    [7, '16:54', 1],
  ]),
  run(SHEET_IDS.paid, 'revise', '2026-10-20', [
    [4, '17:11', 2],
    [5, '17:13', 6],
    [6, '17:19', 2],
    [7, '17:21', 1],
  ]),
  run(SHEET_IDS.paid, 'render', '2026-10-20', [[8, '17:38', 2]]),
  // Two rounds of notes, approved on a later day than the first cut.
  run(SHEET_IDS.archived, 'edit', '2026-09-10', [
    [1, '09:13', 1],
    [2, '09:14', 3],
    [3, '09:17', 6],
    [4, '09:23', 14],
    [5, '09:37', 9],
    [6, '09:46', 3],
    [7, '09:49', 1],
  ]),
  run(SHEET_IDS.archived, 'revise', '2026-09-10', [
    [4, '11:00', 2],
    [5, '11:02', 5],
    [6, '11:07', 2],
    [7, '11:09', 1],
  ]),
  run(SHEET_IDS.archived, 'revise', '2026-09-11', [
    [4, '10:00', 2],
    [5, '10:02', 4],
    [6, '10:06', 2],
    [7, '10:08', 1],
  ]),
  run(SHEET_IDS.archived, 'render', '2026-09-12', [[8, '10:30', 2]]),
];

// --- the notes that were sent -------------------------------------------------------------------

interface SentNoteSpec {
  id: string;
  jobId: string;
  /** The round the notes were sent in (`Job.round` after Send). */
  round: number;
  sentAt: string;
  atSec: number;
  text: string;
  kind?: ReviewNoteKind;
  audioSec?: number;
  addToStyle?: boolean;
  addToSeries?: boolean;
}

/**
 * The review notes each job had sent. The ones in "Ready to review · round 2" are the board's:
 * a Series mark, a recorded note that is also for the Style, and a plain one.
 */
export const SHEET_NOTES: readonly SentNoteSpec[] = [
  {
    id: 'rr2-n1',
    jobId: SHEET_IDS.reviewRound2,
    round: 1,
    sentAt: at('12:10'),
    atSec: 4,
    text: 'Make the WhatsApp question card come in faster',
    addToSeries: true,
  },
  {
    id: 'rr2-n2',
    jobId: SHEET_IDS.reviewRound2,
    round: 1,
    sentAt: at('12:10'),
    atSec: 19,
    kind: 'voice',
    audioSec: 7,
    text: 'תוריד פה את המוזיקה, היא חזקה מדי על הדיבור',
    addToStyle: true,
  },
  {
    id: 'rr2-n3',
    jobId: SHEET_IDS.reviewRound2,
    round: 1,
    sentAt: at('12:10'),
    atSec: 33,
    text: 'Cut the second “אממ”',
  },
  {
    id: 'paid-n1',
    jobId: SHEET_IDS.paid,
    round: 1,
    sentAt: at('17:10', '2026-10-20'),
    atSec: 6,
    text: 'The title can stay a bit longer',
  },
  {
    id: 'paid-n2',
    jobId: SHEET_IDS.paid,
    round: 1,
    sentAt: at('17:10', '2026-10-20'),
    atSec: 21,
    text: 'Lower the music under the answer',
    addToStyle: true,
  },
  {
    id: 'arc-n1',
    jobId: SHEET_IDS.archived,
    round: 1,
    sentAt: at('10:55', '2026-09-10'),
    atSec: 3,
    text: 'Start on the pool, not the lobby',
  },
  {
    id: 'arc-n2',
    jobId: SHEET_IDS.archived,
    round: 1,
    sentAt: at('10:55', '2026-09-10'),
    atSec: 28,
    text: 'The last shot is too dark',
  },
  {
    id: 'arc-n3',
    jobId: SHEET_IDS.archived,
    round: 2,
    sentAt: at('09:55', '2026-09-11'),
    atSec: 12,
    text: 'Keep the logo on screen until the end',
    addToStyle: true,
  },
];

/**
 * Writes the step runs and the sent notes of the thirteen jobs into a database that has the jobs.
 * Straight into the tables: the repositories only write them as a job runs. `shiftMs` moves every
 * time the way the jobs' were moved.
 */
export function seedJobSheetExtras(db: StudioDb, shiftMs = 0): void {
  const ms = (iso: string): number => Date.parse(iso) + shiftMs;
  for (const spec of SHEET_RUNS) {
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
  for (const note of SHEET_NOTES) {
    const voice = note.kind === 'voice';
    const transcriptStatus: TranscriptStatus | null = voice ? 'done' : null;
    db.orm
      .insert(reviewNotes)
      .values({
        id: note.id,
        jobId: note.jobId,
        round: note.round,
        atSec: note.atSec,
        kind: note.kind ?? 'text',
        text: note.text,
        audioFile: voice ? `edit/review/voice/${note.id}.webm` : null,
        audioSec: voice ? (note.audioSec ?? null) : null,
        transcriptStatus,
        addToStyle: note.addToStyle ?? false,
        addToSeries: note.addToSeries ?? false,
        createdAt: ms(note.sentAt) - 5 * 60_000,
        sentAt: ms(note.sentAt),
      })
      .run();
  }
}
