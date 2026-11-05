// Test data for the job sheet: one job per state of the design canvas's Job sheet boards (JSSheet,
// JSStatesA, JSStatesB), with the same names, clients, inputs, times and notes, and with the step
// runs and sent review notes each of them would have. The parts of the sheet (JS3 to JS6) and the
// sheet itself (JS2) all test against this, so they agree on what a "failed" or a "review round
// 2" job is. Not imported by the app.
//
// - Times are UTC clock times (`NOW` in test-jobs.ts does the same). The boards show "Today" as
//   Thu 22 Oct 2026, so a time without a date is on that day; `jobSheetNow` is the moment each
//   board is drawn at (it makes "starts in 0:42", "waiting 9 min" and "~4 min left" come out).
// - `Job.round` counts the rounds of notes that were sent, like the engine: 0 until the first
//   Send notes. So "Ready to review · round 2" (the second cut) is `round: 1`, and its notes are
//   "your notes in round 1". A step run's `round` is numbered the same way: the first edit is
//   round 0, the revise run that applies round N's notes is N, and so is the render after it.
// - A step left open is `endedAt: null`. As in the worker, a failed or cancelled job leaves the
//   step it stopped in open, so an open run does not by itself mean the step is running: that is
//   `job.state === 'editing'`.
// - The boards' "N min of work" summary lines (26, 31, 34, 41) do not add up from their own step
//   lists, so they are not reproduced: the runs here carry the per-step lengths the boards list
//   and add up to what they add up to. Work out totals from the runs.
// - The boards show review notes only for "Ready to review · round 2". The sent notes of the
//   paid and archived jobs (which the boards only mention as "1 review round" and "2 review
//   rounds") are made up to match.

import type {
  Job,
  JobStepRun,
  JobStepsResponse,
  ReviewNote,
  RunKind,
  StepId,
} from '@studio/shared';
import { makeJob, makeReviewNote } from '@/data/test-utils';

/** The states of the boards, in the order JSStatesA and JSStatesB draw them. */
export const JOB_SHEET_STATES = [
  'arriving',
  'queued',
  'held',
  'editing',
  'failed',
  'cancelled',
  'review',
  'reviewRound2',
  'rendering',
  'approved',
  'delivered',
  'paid',
  'archived',
] as const;

export type JobSheetState = (typeof JOB_SHEET_STATES)[number];

// --- small builders -----------------------------------------------------------------------------

/** The day the boards call "Today". */
const TODAY = '2026-10-22';

/** `15:03` or `15:03:18` on `day` (YYYY-MM-DD) as the ISO timestamp the server sends. */
function at(time: string, day: string = TODAY): string {
  return `${day}T${time.length === 5 ? `${time}:00` : time}.000Z`;
}

/** The timestamp `minutes` after `iso`. */
function plus(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}

/** `[step, clock time it started, minutes it took]`; `null` minutes is a run left open. */
type Timed = readonly [StepId, string, number | null];

/** The step runs of one run of the job, oldest first. */
function runs(runKind: RunKind, round: number, day: string, steps: readonly Timed[]): JobStepRun[] {
  return steps.map(([step, start, minutes]) => {
    const startedAt = at(start, day);
    return {
      step,
      runKind,
      round,
      startedAt,
      endedAt: minutes === null ? null : plus(startedAt, minutes),
    };
  });
}

// --- the people and series of the boards --------------------------------------------------------

/** The ids the server gives these client folders and series (sha1 of the NFC name, 12 hex characters). */
const LAKESHORE = { clientId: '784ef01dd585', client: 'LAKESHORE' } as const;
const RGM = { clientId: 'b0855a1d3947', client: 'RGM' } as const;
const LAWYER = { clientId: '4b16f268bd46', client: 'עו״ד דוד לוי' } as const;

/** The lawyer's two shows: "מיתוס או אמת" (episodes 5 and 6) and "שאלות נפוצות" (episode 5). */
const MYTH_SERIES_ID = '622212180eef';
const FAQ_SERIES_ID = '674b518394fd';

/** A job of the boards: the folder name, its id (sha1 of `Client/Job`) and the common defaults. */
function sheetJob(
  who: { clientId: string; client: string },
  id: string,
  name: string,
  overrides: Partial<Job> & Pick<Job, 'state' | 'addedAt' | 'updatedAt'>,
): Job {
  return makeJob({
    ...who,
    id,
    name,
    relPath: `${who.client}/${name}`,
    placeInLine: null,
    settledAt: null,
    lastChangeAt: overrides.addedAt,
    ...overrides,
  });
}

const inputs = (video: number, audio: number, image: number, doc: number) => ({
  video,
  audio,
  image,
  doc,
});

/** The export of a finished job: `Client/Job.mp4`, decimal megabytes like the rest of the app. */
function output(who: { client: string }, name: string, durationSec: number, megabytes: number) {
  return {
    fileName: `${who.client}/${name}.mp4`,
    durationSec,
    width: 1080,
    height: 1920,
    sizeBytes: Math.round(megabytes * 1_000_000),
  };
}

const preview = (durationSec: number) => ({ durationSec, width: 1080, height: 1920 });

/** A job's delivery: ₪40, delivered on `deliveredAt`, paid on the calendar day `paidOn` (or not). */
const delivery = (deliveredAt: string, paidOn: string | null) => ({
  deliveredAt,
  price: 40,
  currency: 'ILS',
  paidOn,
});

// --- the jobs -----------------------------------------------------------------------------------

/** One job per state of the boards, as the list sends it. */
export const jobSheetJobs = {
  // "Files are still coming in": the 60-second wait ends at 15:04:00, 42 seconds after the board.
  arriving: sheetJob(LAKESHORE, '10afe40b7085', 'צילומי לקוחות – אוקטובר', {
    state: 'arriving',
    settlesAt: at('15:04'),
    inputs: inputs(3, 0, 0, 0),
    sizeBytes: 1_900_000_000,
    addedAt: at('15:02'),
    lastChangeAt: at('15:03'),
    updatedAt: at('15:03'),
  }),

  // "#1 in line. It starts when מיתוס או אמת 6 is done."
  queued: sheetJob(RGM, 'c41ae0c8a81a', 'טורניר בחירות – הכרזה', {
    state: 'queued',
    placeInLine: 1,
    inputs: inputs(3, 0, 2, 0),
    sizeBytes: 1_240_000_000,
    addedAt: at('14:47'),
    settledAt: at('14:48'),
    updatedAt: at('14:48'),
    note: 'Use the new logo, not the one from last year',
    effort: 'high',
  }),

  // "On hold since 11:20": it was queued at 11:03, and Release can put it back in that place.
  held: sheetJob(RGM, 'a203704de6c2', 'ריל השקה', {
    state: 'held',
    inputs: inputs(7, 1, 0, 0),
    sizeBytes: 2_650_000_000,
    addedAt: at('11:02'),
    heldSettledAt: at('11:03'),
    updatedAt: at('11:20'),
  }),

  // Episode 6 of the lawyer's show: "Cutting the video: adding graphic 2 of 5", about 4 min left.
  editing: sheetJob(LAWYER, '6554b401d32d', 'מיתוס או אמת 6', {
    state: 'editing',
    step: 5,
    subProgress: 'graphics 2/5',
    etaSec: 240,
    inputs: inputs(5, 1, 0, 1),
    sizeBytes: 2_310_000_000,
    addedAt: at('14:29'),
    settledAt: at('14:30'),
    updatedAt: at('14:55'),
    seriesId: MYTH_SERIES_ID,
    episode: 6,
  }),

  // "Render stopped at 12:52. Steps 1 to 7 are kept, so Retry only makes the MP4 again."
  failed: sheetJob(RGM, '86406f8f28d3', 'ראיון עם המייסד', {
    state: 'failed',
    step: 8,
    failedAt: 8,
    error: 'ffmpeg exited with code 1:\nError writing trailer: No space left on device',
    inputs: inputs(4, 1, 0, 0),
    sizeBytes: 1_480_000_000,
    addedAt: at('12:09'),
    settledAt: at('12:10'),
    updatedAt: at('12:52'),
    runKind: 'render',
    preview: preview(47),
    approvedAt: at('12:50'),
    effort: 'high',
  }),

  // "You stopped it during Cut at 10:41. Resume picks it up again at Cut."
  cancelled: sheetJob(LAKESHORE, 'e0c097576eec', 'טיזר דירה לדוגמה', {
    state: 'cancelled',
    step: 5,
    stoppedAt: 5,
    inputs: inputs(6, 0, 0, 0),
    sizeBytes: 3_020_000_000,
    addedAt: at('10:19'),
    settledAt: at('10:20'),
    updatedAt: at('10:41'),
    note: 'Only the kitchen and the balcony',
  }),

  // "The first cut is ready, 0:44. The MP4 is made after you approve it."
  review: sheetJob(LAKESHORE, 'fcb908323afd', 'סיור בפרויקט', {
    state: 'review',
    step: 7,
    inputs: inputs(8, 1, 3, 0),
    sizeBytes: 4_120_000_000,
    addedAt: at('13:01'),
    settledAt: at('13:02'),
    updatedAt: at('13:35'),
    preview: preview(44),
    note: 'Start with the drone shot',
  }),

  // The second cut (`round: 1`: one round of notes was sent): "It has your 3 notes from round 1."
  reviewRound2: sheetJob(LAWYER, '3a1e02fbe1ef', 'שאלות נפוצות 5', {
    state: 'review',
    step: 7,
    inputs: inputs(4, 1, 0, 0),
    sizeBytes: 1_760_000_000,
    addedAt: at('11:20'),
    settledAt: at('11:21'),
    updatedAt: at('12:22'),
    runKind: 'revise',
    round: 1,
    preview: preview(41),
    effort: 'high',
    seriesId: FAQ_SERIES_ID,
    episode: 5,
  }),

  // "You approved it at 15:10. Making the MP4 now." The job is editing, in its render run.
  rendering: sheetJob(RGM, 'a912d4e4956f', 'חנוכה 2026', {
    state: 'editing',
    step: 8,
    etaSec: 60,
    inputs: inputs(5, 1, 4, 0),
    sizeBytes: 2_940_000_000,
    addedAt: at('14:01'),
    settledAt: at('14:02'),
    updatedAt: at('15:10'),
    runKind: 'render',
    preview: preview(38),
    approvedAt: at('15:10'),
  }),

  // "The MP4 is ready: 0:30, 27 MB. It hasn't been sent to RGM yet."
  approved: sheetJob(RGM, '1e62273e8dba', 'טורניר בחירות שש בש', {
    state: 'ready',
    step: 8,
    inputs: inputs(6, 1, 2, 0),
    sizeBytes: 2_180_000_000,
    addedAt: at('11:39'),
    settledAt: at('11:40'),
    updatedAt: at('13:57'),
    runKind: 'render',
    preview: preview(30),
    approvedAt: at('13:55'),
    output: output(RGM, 'טורניר בחירות שש בש', 30, 27),
  }),

  // "Sent to LAKESHORE on 21 Oct. ₪40 isn't paid yet."
  delivered: sheetJob(LAKESHORE, 'b4e211bf6320', 'אדריכלות', {
    state: 'ready',
    step: 8,
    inputs: inputs(9, 1, 0, 0),
    sizeBytes: 3_340_000_000,
    addedAt: at('10:01', '2026-10-21'),
    settledAt: at('10:02', '2026-10-21'),
    updatedAt: at('14:00', '2026-10-21'),
    runKind: 'render',
    preview: preview(52),
    approvedAt: at('12:46', '2026-10-21'),
    output: output(LAKESHORE, 'אדריכלות', 52, 31),
    delivery: delivery(at('14:00', '2026-10-21'), null),
  }),

  // Episode 5 of the lawyer's show, one round of notes: "Paid ₪40 on 21 Oct. Nothing left to do."
  paid: sheetJob(LAWYER, '947ef344672b', 'מיתוס או אמת 5', {
    state: 'ready',
    step: 8,
    inputs: inputs(5, 1, 0, 0),
    sizeBytes: 1_950_000_000,
    addedAt: at('16:19', '2026-10-20'),
    settledAt: at('16:20', '2026-10-20'),
    updatedAt: at('11:00', '2026-10-21'),
    runKind: 'render',
    round: 1,
    preview: preview(36),
    approvedAt: at('17:38', '2026-10-20'),
    output: output(LAWYER, 'מיתוס או אמת 5', 36, 26),
    delivery: delivery(at('09:00', '2026-10-21'), '2026-10-21'),
    seriesId: MYTH_SERIES_ID,
    episode: 5,
  }),

  // "Archived on 30 Sep, so it only shows with Show archived on." Two rounds of notes, paid 28 Sep.
  archived: sheetJob(RGM, 'f73c96263b11', 'קמפיין קיץ', {
    state: 'ready',
    step: 8,
    inputs: inputs(7, 1, 0, 0),
    sizeBytes: 2_720_000_000,
    addedAt: at('09:12', '2026-09-10'),
    settledAt: at('09:13', '2026-09-10'),
    updatedAt: at('10:00', '2026-09-28'),
    runKind: 'render',
    round: 2,
    preview: preview(45),
    approvedAt: at('10:30', '2026-09-12'),
    output: output(RGM, 'קמפיין קיץ', 45, 34),
    delivery: delivery(at('14:00', '2026-09-12'), '2026-09-28'),
    effort: 'high',
    archivedAt: at('09:00', '2026-09-30'),
  }),
} satisfies Record<JobSheetState, Job>;

// --- the step runs ------------------------------------------------------------------------------

/**
 * Each job's step runs as `GET /api/jobs/:id/steps` sends them, oldest first. The lengths are the
 * ones the boards list per step; a job that has not started has none.
 */
export const jobSheetRuns = {
  arriving: [],
  queued: [],
  held: [],

  // Cut is the running step (`endedAt: null`).
  editing: runs('edit', 0, TODAY, [
    [1, '14:30', 1],
    [2, '14:31', 3],
    [3, '14:34', 5],
    [4, '14:39', 2],
    [5, '14:41', null],
  ]),

  // Render was started on approval at 12:50 and failed at 12:52; the failed step stays open.
  failed: [
    ...runs('edit', 0, TODAY, [
      [1, '12:10', 1],
      [2, '12:11', 3],
      [3, '12:14', 5],
      [4, '12:19', 14],
      [5, '12:33', 8],
      [6, '12:41', 3],
      [7, '12:44', 1],
    ]),
    ...runs('render', 0, TODAY, [[8, '12:50', null]]),
  ],

  // Cut was stopped at 10:41; the step it stopped in stays open.
  cancelled: runs('edit', 0, TODAY, [
    [1, '10:20', 1],
    [2, '10:21', 2],
    [3, '10:23', 4],
    [4, '10:27', 8],
    [5, '10:35', null],
  ]),

  // Check ended at 13:35: "Your review" has waited since then.
  review: runs('edit', 0, TODAY, [
    [1, '13:02', 1],
    [2, '13:03', 3],
    [3, '13:06', 5],
    [4, '13:11', 13],
    [5, '13:24', 7],
    [6, '13:31', 3],
    [7, '13:34', 1],
  ]),

  // The first cut, then round 1's revise run from Plan ("Round 2 · from Plan").
  reviewRound2: [
    ...runs('edit', 0, TODAY, [
      [1, '11:21', 1],
      [2, '11:22', 3],
      [3, '11:25', 5],
      [4, '11:30', 10],
      [5, '11:40', 8],
      [6, '11:48', 3],
      [7, '11:51', 1],
    ]),
    ...runs('revise', 1, TODAY, [
      [4, '12:11', 2],
      [5, '12:13', 6],
      [6, '12:19', 2],
      [7, '12:21', 1],
    ]),
  ],

  // Approved at 15:10, Render is running.
  rendering: [
    ...runs('edit', 0, TODAY, [
      [1, '14:02', 1],
      [2, '14:03', 2],
      [3, '14:05', 4],
      [4, '14:09', 9],
      [5, '14:18', 6],
      [6, '14:24', 2],
      [7, '14:26', 1],
    ]),
    ...runs('render', 0, TODAY, [[8, '15:10', null]]),
  ],

  approved: [
    ...runs('edit', 0, TODAY, [
      [1, '11:40', 1],
      [2, '11:41', 2],
      [3, '11:43', 4],
      [4, '11:47', 11],
      [5, '11:58', 6],
      [6, '12:04', 2],
      [7, '12:06', 1],
    ]),
    ...runs('render', 0, TODAY, [[8, '13:55', 2]]),
  ],

  delivered: [
    ...runs('edit', 0, '2026-10-21', [
      [1, '10:02', 1],
      [2, '10:03', 2],
      [3, '10:05', 5],
      [4, '10:10', 16],
      [5, '10:26', 7],
      [6, '10:33', 2],
      [7, '10:35', 1],
    ]),
    ...runs('render', 0, '2026-10-21', [[8, '12:46', 2]]),
  ],

  // One round of notes: the first cut, round 1's revise run, then the render.
  paid: [
    ...runs('edit', 0, '2026-10-20', [
      [1, '16:20', 1],
      [2, '16:21', 3],
      [3, '16:24', 5],
      [4, '16:29', 15],
      [5, '16:44', 8],
      [6, '16:52', 2],
      [7, '16:54', 1],
    ]),
    ...runs('revise', 1, '2026-10-20', [
      [4, '17:11', 2],
      [5, '17:13', 6],
      [6, '17:19', 2],
      [7, '17:21', 1],
    ]),
    ...runs('render', 1, '2026-10-20', [[8, '17:38', 2]]),
  ],

  // Two rounds of notes, approved on a later day than the first cut.
  archived: [
    ...runs('edit', 0, '2026-09-10', [
      [1, '09:13', 1],
      [2, '09:14', 3],
      [3, '09:17', 6],
      [4, '09:23', 14],
      [5, '09:37', 9],
      [6, '09:46', 3],
      [7, '09:49', 1],
    ]),
    ...runs('revise', 1, '2026-09-10', [
      [4, '11:00', 2],
      [5, '11:02', 5],
      [6, '11:07', 2],
      [7, '11:09', 1],
    ]),
    ...runs('revise', 2, '2026-09-11', [
      [4, '10:00', 2],
      [5, '10:02', 4],
      [6, '10:06', 2],
      [7, '10:08', 1],
    ]),
    ...runs('render', 2, '2026-09-12', [[8, '10:30', 2]]),
  ],
} satisfies Record<JobSheetState, JobStepRun[]>;

// --- the notes that were sent -------------------------------------------------------------------

/** A text note sent in `round` at `sentAt`, pinned at `atSec`. */
function sentNote(
  id: string,
  job: Job,
  round: number,
  sentAt: string,
  overrides: Partial<ReviewNote> & Pick<ReviewNote, 'atSec' | 'text'>,
): ReviewNote {
  return makeReviewNote({
    id,
    jobId: job.id,
    round,
    createdAt: plus(sentAt, -5),
    sentAt,
    ...overrides,
  });
}

/**
 * The review notes each job had sent (their `round` is set), oldest round first, in the order the
 * server lists them (by `atSec`). The ones in "Ready to review · round 2" are the board's; the
 * others are made up.
 */
export const jobSheetNotes = {
  arriving: [],
  queued: [],
  held: [],
  editing: [],
  failed: [],
  cancelled: [],
  review: [],

  // Round 1, sent 12:10: a Series mark, a recorded note that is also for the Style, and a plain one.
  reviewRound2: [
    sentNote('rr2-n1', jobSheetJobs.reviewRound2, 1, at('12:10'), {
      atSec: 4,
      text: 'Make the WhatsApp question card come in faster',
      addToSeries: true,
    }),
    sentNote('rr2-n2', jobSheetJobs.reviewRound2, 1, at('12:10'), {
      atSec: 19,
      kind: 'voice',
      text: 'תוריד פה את המוזיקה, היא חזקה מדי על הדיבור',
      audioFile: 'edit/review/voice/rr2-n2.webm',
      audioSec: 7,
      transcriptStatus: 'done',
      addToStyle: true,
    }),
    sentNote('rr2-n3', jobSheetJobs.reviewRound2, 1, at('12:10'), {
      atSec: 33,
      text: 'Cut the second “אממ”',
    }),
  ],

  rendering: [],
  approved: [],
  delivered: [],

  paid: [
    sentNote('paid-n1', jobSheetJobs.paid, 1, at('17:10', '2026-10-20'), {
      atSec: 6,
      text: 'The title can stay a bit longer',
    }),
    sentNote('paid-n2', jobSheetJobs.paid, 1, at('17:10', '2026-10-20'), {
      atSec: 21,
      text: 'Lower the music under the answer',
      addToStyle: true,
    }),
  ],

  archived: [
    sentNote('arc-n1', jobSheetJobs.archived, 1, at('10:55', '2026-09-10'), {
      atSec: 3,
      text: 'Start on the pool, not the lobby',
    }),
    sentNote('arc-n2', jobSheetJobs.archived, 1, at('10:55', '2026-09-10'), {
      atSec: 28,
      text: 'The last shot is too dark',
    }),
    sentNote('arc-n3', jobSheetJobs.archived, 2, at('09:55', '2026-09-11'), {
      atSec: 12,
      text: 'Keep the logo on screen until the end',
      addToStyle: true,
    }),
  ],
} satisfies Record<JobSheetState, ReviewNote[]>;

// --- the moment of each board -------------------------------------------------------------------

/** The moment each board is drawn at, so "starts in 0:42", "waiting 9 min" and "~4 min left" come out. */
export const jobSheetNow = {
  arriving: at('15:03:18'),
  queued: at('14:55'),
  held: at('15:12'),
  editing: at('14:55'),
  failed: at('13:00'),
  cancelled: at('11:00'),
  review: at('13:44'),
  reviewRound2: at('12:48'),
  rendering: at('15:12'),
  approved: at('14:00'),
  delivered: at('15:00'),
  paid: at('15:00'),
  archived: at('15:00'),
} satisfies Record<JobSheetState, string>;

/** `GET /api/jobs/:id/steps` for a job of the boards, as a mock server answers it. */
export function jobSheetStepsResponse(state: JobSheetState): JobStepsResponse {
  return { jobId: jobSheetJobs[state].id, runs: jobSheetRuns[state] };
}

/** Every job of the boards in the order of {@link JOB_SHEET_STATES}: a job list to open sheets from. */
export const jobSheetList: readonly Job[] = JOB_SHEET_STATES.map((state) => jobSheetJobs[state]);
