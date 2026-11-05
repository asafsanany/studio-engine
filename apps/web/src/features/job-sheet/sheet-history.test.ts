import type { Job, JobStepRun, ReviewNote } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { makeJobDelivery, makeReviewNote } from '@/data/test-utils';
import { realJob, realNotes, realNow, realRuns } from './real-job-fixture';
import { type HistoryRow, historyRows } from './sheet-history';
import {
  JOB_SHEET_STATES,
  type JobSheetState,
  jobSheetJobs,
  jobSheetNotes,
  jobSheetNow,
  jobSheetRuns,
} from './test-fixtures';

// The fixtures keep UTC clock times, so every test pins UTC.
const UTC = 'UTC';

/** The history of a job of the boards, as the sheet builds it from the job, its runs and its notes. */
function historyOf(state: JobSheetState): string[] {
  const rows = historyRows(
    { job: jobSheetJobs[state], runs: jobSheetRuns[state], notes: jobSheetNotes[state] },
    jobSheetNow[state],
    UTC,
  );
  return rows.map((row) => `${row.time} ${row.text}`);
}

describe('historyRows, per state of the boards', () => {
  it('has only the folder for a job that has just arrived', () => {
    expect(historyOf('arriving')).toEqual(['15:02 Folder appeared']);
  });

  it('adds what settled for a queued job, and for a held one that was queued before', () => {
    expect(historyOf('queued')).toEqual([
      '14:47 Folder appeared',
      '14:48 Settled: 3 video clips, 2 images',
    ]);
    expect(historyOf('held')).toEqual([
      '11:02 Folder appeared',
      '11:03 Settled: 7 video clips, 1 audio file',
    ]);
  });

  it('adds the start, with the effort the job runs at, for a job that is editing', () => {
    expect(historyOf('editing')).toEqual([
      '14:29 Folder appeared',
      '14:30 Settled: 5 video clips, 1 audio file, 1 document',
      '14:30 Started · Extra high',
    ]);
  });

  it('says the first cut is ready when Check ended', () => {
    expect(historyOf('review')).toEqual([
      '13:01 Folder appeared',
      '13:02 Settled: 8 video clips, 1 audio file, 3 images',
      '13:02 Started · Extra high',
      '13:35 First cut ready for review',
    ]);
  });

  it('follows two review rounds: the notes sent, then the next cut', () => {
    expect(historyOf('reviewRound2')).toEqual([
      '11:20 Folder appeared',
      '11:21 Settled: 4 video clips, 1 audio file',
      '11:21 Started · High',
      '11:52 First cut ready for review',
      '12:10 You sent 3 notes · round 1',
      '12:22 Round 2 ready for review',
    ]);
  });

  it('has the approval and nothing more while the MP4 is made', () => {
    expect(historyOf('rendering')).toEqual([
      '14:01 Folder appeared',
      '14:02 Settled: 5 video clips, 1 audio file, 4 images',
      '14:02 Started · Extra high',
      '14:27 First cut ready for review',
      '15:10 Approved by you',
    ]);
  });

  it('ends a failed job with the step that failed', () => {
    expect(historyOf('failed')).toEqual([
      '12:09 Folder appeared',
      '12:10 Settled: 4 video clips, 1 audio file',
      '12:10 Started · High',
      '12:45 First cut ready for review',
      '12:50 Approved by you',
      '12:52 Render failed',
    ]);
  });

  it('ends a cancelled job with the step it was stopped in', () => {
    expect(historyOf('cancelled')).toEqual([
      '10:19 Folder appeared',
      '10:20 Settled: 6 video clips',
      '10:20 Started · Extra high',
      '10:41 Cancelled by you during Cut',
    ]);
  });

  it('has the MP4 for an approved job', () => {
    expect(historyOf('approved')).toEqual([
      '11:39 Folder appeared',
      '11:40 Settled: 6 video clips, 1 audio file, 2 images',
      '11:40 Started · Extra high',
      '12:07 First cut ready for review',
      '13:55 Approved by you',
      '13:57 MP4 ready in _Exports/RGM',
    ]);
  });

  it('has the delivery for a delivered job, with the day for every row of an earlier day', () => {
    expect(historyOf('delivered')).toEqual([
      '21 Oct Folder appeared',
      '21 Oct Settled: 9 video clips, 1 audio file',
      '21 Oct Started · Extra high',
      '21 Oct First cut ready for review',
      '21 Oct Approved by you',
      '21 Oct MP4 ready in _Exports/LAKESHORE',
      '21 Oct Marked delivered · ₪40',
    ]);
  });

  it('has the payment for a paid job, after one round of notes', () => {
    expect(historyOf('paid')).toEqual([
      '20 Oct Folder appeared',
      '20 Oct Settled: 5 video clips, 1 audio file',
      '20 Oct Started · Extra high',
      '20 Oct First cut ready for review',
      '20 Oct You sent 2 notes · round 1',
      '20 Oct Round 2 ready for review',
      '20 Oct Approved by you',
      '20 Oct MP4 ready in _Exports/עו״ד דוד לוי',
      '21 Oct Marked delivered · ₪40',
      '21 Oct Marked paid',
    ]);
  });

  it('has the archiving for an archived job, after two rounds of notes', () => {
    expect(historyOf('archived')).toEqual([
      '10 Sep Folder appeared',
      '10 Sep Settled: 7 video clips, 1 audio file',
      '10 Sep Started · High',
      '10 Sep First cut ready for review',
      '10 Sep You sent 2 notes · round 1',
      '10 Sep Round 2 ready for review',
      '11 Sep You sent 1 note · round 2',
      '11 Sep Round 3 ready for review',
      '12 Sep Approved by you',
      '12 Sep MP4 ready in _Exports/RGM',
      '12 Sep Marked delivered · ₪40',
      '28 Sep Marked paid',
      '30 Sep Archived',
    ]);
  });

  it('is oldest first for every job of the boards', () => {
    for (const state of JOB_SHEET_STATES) {
      const job = jobSheetJobs[state];
      const rows = historyRows(
        { job, runs: jobSheetRuns[state], notes: jobSheetNotes[state] },
        jobSheetNow[state],
        UTC,
      );
      expect(rows[0]?.text, state).toBe('Folder appeared');
      expect(new Set(rows.map((row) => row.id)).size, state).toBe(rows.length);
    }
  });
});

describe('historyRows, today and other days', () => {
  const run = (overrides: Partial<JobStepRun>): JobStepRun => ({
    step: 7,
    runKind: 'edit',
    round: 0,
    startedAt: '2026-10-21T22:00:00.000Z',
    endedAt: '2026-10-21T22:30:00.000Z',
    ...overrides,
  });

  const rows = (now: string, timeZone: string): HistoryRow[] =>
    historyRows(
      {
        job: { ...jobSheetJobs.review, addedAt: '2026-10-21T21:00:00.000Z' },
        runs: [run({})],
        notes: [],
      },
      now,
      timeZone,
    );

  it('shows HH:MM for today and D Mon before it', () => {
    const asRows = rows('2026-10-22T09:00:00.000Z', UTC);
    expect(asRows.map((row) => row.time)).toEqual(['21 Oct', '21 Oct', '21 Oct']);
    const sameDay = rows('2026-10-21T23:00:00.000Z', UTC);
    expect(sameDay.map((row) => row.time)).toEqual(['21:00', '22:00', '22:30']);
  });

  it('follows the calendar of the zone it is given', () => {
    // 21:00 and 22:30 UTC on the 21st are 00:00 and 01:30 on the 22nd in Jerusalem.
    const jerusalem = rows('2026-10-22T09:00:00.000Z', 'Asia/Jerusalem');
    expect(jerusalem.map((row) => row.time)).toEqual(['00:00', '01:00', '01:30']);
  });

  it('shows the day money came in as a day, even when it is today', () => {
    const job: Job = {
      ...jobSheetJobs.delivered,
      delivery: makeJobDelivery({ deliveredAt: '2026-10-22T09:00:00.000Z', paidOn: '2026-10-22' }),
    };
    const history = historyRows({ job, runs: [], notes: [] }, '2026-10-22T15:00:00.000Z', UTC);
    expect(history.slice(-2).map((row) => [row.time, row.text])).toEqual([
      ['09:00', 'Marked delivered · ₪40'],
      ['22 Oct', 'Marked paid'],
    ]);
  });
});

describe('historyRows, the order of the rows', () => {
  const now = '2026-10-22T15:00:00.000Z';

  it('puts "Uploaded · posted Tue 20 Oct" after the delivery, before the payment', () => {
    const job: Job = {
      ...jobSheetJobs.delivered,
      delivery: makeJobDelivery({
        deliveredAt: '2026-10-21T14:00:00.000Z',
        uploadedAt: '2026-10-22T08:00:00.000Z',
        paidOn: '2026-10-23',
      }),
    };
    const history = historyRows({ job, runs: [], notes: [] }, '2026-10-25T15:00:00.000Z', UTC);
    expect(history.slice(-3).map((row) => [row.time, row.text])).toEqual([
      ['21 Oct', 'Marked delivered · ₪40'],
      ['22 Oct', 'Uploaded · posted Thu 22 Oct'],
      ['23 Oct', 'Marked paid'],
    ]);
    expect(history.map((row) => row.id)).toContain('uploaded');
  });

  it('never puts the upload before the delivery, when the reel was posted before it was marked', () => {
    const job: Job = {
      ...jobSheetJobs.delivered,
      delivery: makeJobDelivery({
        deliveredAt: '2026-10-21T14:00:00.000Z',
        uploadedAt: '2026-10-20T09:30:00.000Z',
      }),
    };
    const history = historyRows({ job, runs: [], notes: [] }, now, UTC);
    expect(history.slice(-2).map((row) => row.text)).toEqual([
      'Marked delivered · ₪40',
      'Uploaded · posted Tue 20 Oct',
    ]);
  });

  it('has no upload row while no reel is linked', () => {
    const texts = historyRows({ job: jobSheetJobs.delivered, runs: [], notes: [] }, now, UTC).map(
      (row) => row.text,
    );
    expect(texts.some((text) => text.startsWith('Uploaded'))).toBe(false);
  });

  it('puts payment after the delivery it pays for, even when the day began earlier', () => {
    const job: Job = {
      ...jobSheetJobs.delivered,
      delivery: makeJobDelivery({ deliveredAt: '2026-10-21T14:00:00.000Z', paidOn: '2026-10-21' }),
    };
    const texts = historyRows({ job, runs: [], notes: [] }, now, UTC).map((row) => row.text);
    expect(texts.slice(-2)).toEqual(['Marked delivered · ₪40', 'Marked paid']);
  });

  it('puts payment before archiving on the same day', () => {
    const job: Job = {
      ...jobSheetJobs.archived,
      delivery: makeJobDelivery({ deliveredAt: '2026-09-12T14:00:00.000Z', paidOn: '2026-09-28' }),
      archivedAt: '2026-09-28T09:00:00.000Z',
    };
    const texts = historyRows({ job, runs: [], notes: [] }, now, UTC).map((row) => row.text);
    expect(texts.slice(-3)).toEqual(['Marked delivered · ₪40', 'Marked paid', 'Archived']);
  });

  it('keeps rows at the same moment in the order they happen: folder, settled, started', () => {
    const job: Job = { ...jobSheetJobs.editing, addedAt: jobSheetJobs.editing.settledAt as string };
    const history = historyRows({ job, runs: jobSheetRuns.editing, notes: [] }, now, UTC);
    expect(history.slice(0, 2).map((row) => row.text)).toEqual([
      'Folder appeared',
      'Settled: 5 video clips, 1 audio file, 1 document',
    ]);
  });

  it('is not thrown by a row whose time is wrong: it is left out', () => {
    const job: Job = { ...jobSheetJobs.review, approvedAt: 'nope' };
    const texts = historyRows({ job, runs: jobSheetRuns.review, notes: [] }, now, UTC).map(
      (row) => row.text,
    );
    expect(texts).not.toContain('Approved by you');
    expect(texts).toContain('Folder appeared');
  });
});

describe('historyRows, what is not there yet', () => {
  const now = jobSheetNow.reviewRound2;
  const job = jobSheetJobs.reviewRound2;

  it('shows what the job itself says while the step runs and the notes have not arrived', () => {
    const texts = historyRows({ job, runs: undefined, notes: undefined }, now, UTC).map(
      (row) => row.text,
    );
    expect(texts).toEqual(['Folder appeared', 'Settled: 4 video clips, 1 audio file']);
  });

  it('adds the rows of the step runs when they arrive, and the notes when they do', () => {
    // The sent notes are on their way: the round has no row yet, so its count never changes later.
    const withRuns = historyRows(
      { job, runs: jobSheetRuns.reviewRound2, notes: undefined },
      now,
      UTC,
    );
    expect(withRuns.map((row) => `${row.time} ${row.text}`)).toEqual([
      '11:20 Folder appeared',
      '11:21 Settled: 4 video clips, 1 audio file',
      '11:21 Started · High',
      '11:52 First cut ready for review',
      '12:22 Round 2 ready for review',
    ]);
    const withNotes = historyRows(
      { job, runs: jobSheetRuns.reviewRound2, notes: jobSheetNotes.reviewRound2 },
      now,
      UTC,
    );
    expect(withNotes.map((row) => `${row.time} ${row.text}`)).toContain(
      '12:10 You sent 3 notes · round 1',
    );
  });

  it('says "You sent notes · round N" at its revise run when the notes could not be loaded', () => {
    const history = historyRows(
      { job, runs: jobSheetRuns.reviewRound2, notes: undefined, notesFailed: true },
      now,
      UTC,
    );
    expect(history.map((row) => `${row.time} ${row.text}`)).toEqual([
      '11:20 Folder appeared',
      '11:21 Settled: 4 video clips, 1 audio file',
      '11:21 Started · High',
      '11:52 First cut ready for review',
      '12:11 You sent notes · round 1',
      '12:22 Round 2 ready for review',
    ]);
  });

  it('keeps that row for a round the loaded notes do not hold, and drops it once they do', () => {
    const rows = (notes: ReviewNote[]) =>
      historyRows({ job, runs: jobSheetRuns.reviewRound2, notes }, now, UTC)
        .filter((row) => row.text.startsWith('You sent'))
        .map((row) => `${row.time} ${row.text}`);
    expect(rows([])).toEqual(['12:11 You sent notes · round 1']);
    expect(rows(jobSheetNotes.reviewRound2)).toEqual(['12:10 You sent 3 notes · round 1']);
  });

  it('counts each round’s notes and puts the rounds in the order they were sent, whatever the notes’ order', () => {
    const archived = jobSheetJobs.archived;
    const history = historyRows(
      {
        job: archived,
        runs: jobSheetRuns.archived,
        notes: [...jobSheetNotes.archived].reverse(),
      },
      jobSheetNow.archived,
      UTC,
    );
    const sent = history.filter((row) => row.text.startsWith('You sent'));
    expect(sent.map((row) => `${row.time} ${row.text}`)).toEqual([
      '10 Sep You sent 2 notes · round 1',
      '11 Sep You sent 1 note · round 2',
    ]);
    // Each sits between its round's ready row and the next, as the boards draw it.
    const texts = history.map((row) => row.text);
    expect(texts.indexOf('You sent 2 notes · round 1')).toBeLessThan(
      texts.indexOf('Round 2 ready for review'),
    );
    expect(texts.indexOf('You sent 1 note · round 2')).toBeLessThan(
      texts.indexOf('Round 3 ready for review'),
    );
  });

  it('counts the notes of a round that was sent, and not the drafts', () => {
    const draft: ReviewNote = makeReviewNote({ id: 'draft', jobId: job.id, round: null });
    const history = historyRows(
      { job, runs: jobSheetRuns.reviewRound2, notes: [...jobSheetNotes.reviewRound2, draft] },
      now,
      UTC,
    );
    expect(history.find((row) => row.id === 'sent-1')?.text).toBe('You sent 3 notes · round 1');
    expect(history.filter((row) => row.text.startsWith('You sent'))).toHaveLength(1);
  });

  it('says nothing of notes for a job that has only drafts', () => {
    const draft = makeReviewNote({ id: 'draft', jobId: jobSheetJobs.review.id, round: null });
    const history = historyRows(
      { job: jobSheetJobs.review, runs: jobSheetRuns.review, notes: [draft] },
      jobSheetNow.review,
      UTC,
    );
    expect(history.some((row) => row.text.startsWith('You sent'))).toBe(false);
  });

  it('puts a round where its notes were sent, not where its revise run began', () => {
    const history = historyRows(
      { job, runs: jobSheetRuns.reviewRound2, notes: jobSheetNotes.reviewRound2 },
      now,
      UTC,
    );
    expect(history.find((row) => row.id === 'sent-1')?.time).toBe('12:10');
  });
});

describe('historyRows, runs that did not end well', () => {
  const now = '2026-10-22T15:00:00.000Z';
  const base = jobSheetJobs.review;
  const at = (time: string) => `2026-10-22T${time}:00.000Z`;
  const run = (step: JobStepRun['step'], start: string, end: string | null, extra = {}) =>
    ({
      step,
      runKind: 'edit',
      round: 0,
      startedAt: at(start),
      endedAt: end && at(end),
      ...extra,
    }) satisfies JobStepRun;

  it('does not say a cut is ready for a Check that was left open', () => {
    const job: Job = { ...base, state: 'failed', failedAt: 7, step: 7 };
    const texts = historyRows(
      { job, runs: [run(6, '10:00', '10:05'), run(7, '10:05', null)], notes: [] },
      now,
      UTC,
    ).map((row) => row.text);
    expect(texts).toContain('Check failed');
    expect(texts.some((text) => text.includes('ready for review'))).toBe(false);
  });

  it('reports a step that ran again in the same round by its last end', () => {
    const history = historyRows(
      {
        job: base,
        runs: [run(7, '10:00', '10:05'), run(7, '11:00', '11:03')],
        notes: [],
      },
      now,
      UTC,
    );
    expect(history.find((row) => row.id === 'ready-0')?.time).toBe('11:03');
  });

  it('leaves out the MP4 while the render has not ended, and shows the last render once it did', () => {
    const open = historyRows(
      { job: base, runs: [run(8, '10:00', null, { runKind: 'render' })], notes: [] },
      now,
      UTC,
    );
    expect(open.some((row) => row.id === 'mp4')).toBe(false);

    const done = historyRows(
      {
        job: base,
        runs: [
          run(8, '10:00', '10:02', { runKind: 'render' }),
          run(8, '12:00', '12:03', { runKind: 'render' }),
        ],
        notes: [],
      },
      now,
      UTC,
    );
    expect(done.find((row) => row.id === 'mp4')?.time).toBe('12:03');
  });

  it('does not call a retry the settling of the folder', () => {
    // Retried: the job joined the queue again at 13:00, after its first edit run began at 10:00.
    const job: Job = { ...base, settledAt: at('13:00') };
    const texts = historyRows({ job, runs: [run(1, '10:00', '10:01')], notes: [] }, now, UTC).map(
      (row) => row.text,
    );
    expect(texts.some((text) => text.startsWith('Settled'))).toBe(false);
  });

  it('starts at the first edit run, whatever order the runs come in', () => {
    const history = historyRows(
      { job: base, runs: [run(2, '10:05', '10:07'), run(1, '10:00', '10:05')], notes: [] },
      now,
      UTC,
    );
    expect(history.find((row) => row.id === 'started')?.time).toBe('10:00');
  });

  it('does not start a job that only ran a render or a revise round', () => {
    const history = historyRows(
      { job: base, runs: [run(8, '10:00', '10:02', { runKind: 'render' })], notes: [] },
      now,
      UTC,
    );
    expect(history.some((row) => row.id === 'started')).toBe(false);
  });
});

describe('historyRows, the words', () => {
  const now = '2026-10-22T15:00:00.000Z';

  it('says Default effort as the level it runs at', () => {
    const history = historyRows(
      { job: { ...jobSheetJobs.editing, effort: null }, runs: jobSheetRuns.editing, notes: [] },
      now,
      UTC,
    );
    expect(history.find((row) => row.id === 'started')?.text).toBe('Started · Extra high');
    const medium = historyRows(
      { job: { ...jobSheetJobs.editing, effort: 'medium' }, runs: jobSheetRuns.editing, notes: [] },
      now,
      UTC,
    );
    expect(medium.find((row) => row.id === 'started')?.text).toBe('Started · Medium');
  });

  it('names the step in a failure and a cancel, and still says it without one', () => {
    const text = (job: Job) => historyRows({ job, runs: [], notes: [] }, now, UTC).at(-1)?.text;
    expect(text({ ...jobSheetJobs.failed, failedAt: 3 })).toBe('Scan failed');
    expect(text({ ...jobSheetJobs.failed, failedAt: null })).toBe('Failed');
    expect(text({ ...jobSheetJobs.cancelled, stoppedAt: 4 })).toBe('Cancelled by you during Plan');
    expect(text({ ...jobSheetJobs.cancelled, stoppedAt: null })).toBe('Cancelled by you');
  });

  it('names the price that was frozen when the job was delivered', () => {
    const job: Job = {
      ...jobSheetJobs.delivered,
      delivery: makeJobDelivery({ price: 37.5, currency: 'USD' }),
    };
    const texts = historyRows({ job, runs: [], notes: [] }, now, UTC).map((row) => row.text);
    expect(texts).toContain('Marked delivered · $37.50');
  });

  it('says Settled alone for a folder that settled with no files', () => {
    const job: Job = { ...jobSheetJobs.queued, inputs: { video: 0, audio: 0, image: 0, doc: 0 } };
    const texts = historyRows({ job, runs: [], notes: [] }, now, UTC).map((row) => row.text);
    expect(texts).toEqual(['Folder appeared', 'Settled']);
  });

  it('has no Archived row once the job is unarchived, and no money before it is delivered', () => {
    const job: Job = { ...jobSheetJobs.archived, archivedAt: null, delivery: null };
    const texts = historyRows({ job, runs: [], notes: [] }, now, UTC).map((row) => row.text);
    expect(texts).not.toContain('Archived');
    expect(texts.some((text) => text.startsWith('Marked'))).toBe(false);
  });
});

// CVP-262: a round's Check run can stay open (an engine restart cut the run in two), and "ready for
// review" then falls back to the job's own state and the round's other runs (real-job-fixture.ts).
describe('historyRows, a round whose Check run has no end', () => {
  const run = (overrides: Partial<JobStepRun>): JobStepRun => ({
    step: 7,
    runKind: 'edit',
    round: 0,
    startedAt: '2026-10-22T10:00:00.000Z',
    endedAt: null,
    ...overrides,
  });
  const ready = (job: Job, runs: JobStepRun[], now = '2026-10-23T09:00:00.000Z') =>
    historyRows({ job, runs, notes: [] }, now, UTC)
      .filter((row) => row.id.startsWith('ready-'))
      .map((row) => `${row.time} ${row.text}`);

  it('says round 2 was ready for review at the real job’s Review moment, between the notes and now', () => {
    const rows = historyRows({ job: realJob, runs: realRuns, notes: realNotes }, realNow, UTC);
    expect(rows.map((row) => `${row.time} ${row.text}`)).toEqual([
      '21 Oct Folder appeared',
      '21 Oct Settled: 14 video clips, 1 audio file, 1 document',
      '21 Oct Started · Extra high',
      '21 Oct First cut ready for review',
      '21 Oct You sent 2 notes · round 1',
      '18:58 Round 2 ready for review',
    ]);
  });

  it('takes the moment the job reached Review for the round it is waiting in', () => {
    // The Check run started at 18:57:58 and never ended; the job has waited in Review since 18:58:40.
    const waiting = realRuns.filter((r) => r.round === 1);
    expect(ready({ ...realJob, round: 1 }, waiting, realNow)).toEqual([
      '18:58 Round 2 ready for review',
    ]);
  });

  it('takes the last moment of a round the job has left, not the start of the next round', () => {
    // Round 0's Check was left open at 10:30 and its notes went out the next morning at 09:00:
    // the first cut was ready around 10:30, not when the revise run started at 09:01.
    const runs = [
      run({ step: 6, startedAt: '2026-10-22T10:20:00.000Z', endedAt: '2026-10-22T10:30:00.000Z' }),
      run({ startedAt: '2026-10-22T10:30:00.000Z' }),
      run({ step: 4, runKind: 'revise', round: 1, startedAt: '2026-10-23T09:01:00.000Z' }),
    ];
    const job: Job = { ...jobSheetJobs.reviewRound2, round: 1, state: 'editing' };
    expect(ready(job, runs)).toEqual(['22 Oct First cut ready for review']);
  });

  it('uses the start of the open Check run when nothing in the round ended later', () => {
    const runs = [run({ startedAt: '2026-10-22T10:30:00.000Z' })];
    const job: Job = { ...jobSheetJobs.approved, round: 0, approvedAt: '2026-10-22T12:00:00.000Z' };
    expect(ready(job, runs)).toEqual(['22 Oct First cut ready for review']);
    expect(ready(job, runs, '2026-10-22T13:00:00.000Z')).toEqual([
      '10:30 First cut ready for review',
    ]);
  });

  it('does it for the round an approved job went through, and leaves its render out of it', () => {
    const runs = [
      run({ step: 6, startedAt: '2026-10-22T10:00:00.000Z', endedAt: '2026-10-22T10:05:00.000Z' }),
      run({ startedAt: '2026-10-22T10:05:00.000Z' }),
      run({ step: 8, runKind: 'render', startedAt: '2026-10-22T12:00:00.000Z' }),
    ];
    const job: Job = {
      ...jobSheetJobs.rendering,
      round: 0,
      approvedAt: '2026-10-22T11:59:00.000Z',
    };
    expect(ready(job, runs, '2026-10-22T13:00:00.000Z')).toEqual([
      '10:05 First cut ready for review',
    ]);
  });

  it('prefers the end of a Check run that ended', () => {
    const runs = [run({ endedAt: '2026-10-22T10:40:00.000Z' })];
    expect(ready({ ...jobSheetJobs.review, updatedAt: '2026-10-22T11:00:00.000Z' }, runs)).toEqual([
      '22 Oct First cut ready for review',
    ]);
    const rows = historyRows(
      { job: { ...jobSheetJobs.review, updatedAt: '2026-10-22T11:00:00.000Z' }, runs, notes: [] },
      '2026-10-22T13:00:00.000Z',
      UTC,
    );
    expect(rows.find((row) => row.id === 'ready-0')?.time).toBe('10:40');
  });

  it('says nothing for a round the job has not reached', () => {
    const runs = [run({ startedAt: '2026-10-22T10:30:00.000Z' })];
    const editing: Job = { ...jobSheetJobs.editing, round: 0 };
    expect(ready(editing, runs)).toEqual([]);
    const failed: Job = { ...jobSheetJobs.failed, round: 0, approvedAt: null, failedAt: 7 };
    expect(ready(failed, runs)).toEqual([]);
    const cancelled: Job = { ...jobSheetJobs.cancelled, round: 0, stoppedAt: 7 };
    expect(ready(cancelled, runs)).toEqual([]);
    const queued: Job = { ...jobSheetJobs.queued, round: 0 };
    expect(ready(queued, runs)).toEqual([]);
  });

  it('says nothing for a job that was never in review: a ready job with no approval', () => {
    const runs = [run({ startedAt: '2026-10-22T10:30:00.000Z' })];
    const ready0: Job = { ...jobSheetJobs.approved, round: 0, approvedAt: null };
    expect(ready(ready0, runs)).toEqual([]);
  });

  it('says nothing for a past round with no run of its own to read a time from', () => {
    const runs = [
      run({ step: 4, runKind: 'revise', round: 1, startedAt: '2026-10-23T09:01:00.000Z' }),
    ];
    const job: Job = { ...jobSheetJobs.reviewRound2, round: 1, state: 'editing' };
    expect(ready(job, runs)).toEqual([]);
  });

  it('keeps the round order: each ready row comes before the notes that follow it', () => {
    const runs = [
      run({ step: 4, startedAt: '2026-10-22T10:00:00.000Z', endedAt: '2026-10-22T10:10:00.000Z' }),
      run({ startedAt: '2026-10-22T10:10:00.000Z' }),
      run({
        step: 4,
        runKind: 'revise',
        round: 1,
        startedAt: '2026-10-23T09:01:00.000Z',
        endedAt: '2026-10-23T09:05:00.000Z',
      }),
      run({ runKind: 'revise', round: 1, startedAt: '2026-10-23T09:05:00.000Z' }),
    ];
    const job: Job = { ...jobSheetJobs.review, round: 1, updatedAt: '2026-10-23T09:07:00.000Z' };
    const notes = [makeReviewNote({ id: 'n', round: 1, sentAt: '2026-10-23T09:00:00.000Z' })];
    const rows = historyRows({ job, runs, notes }, '2026-10-23T10:00:00.000Z', UTC);
    expect(
      rows.filter((row) => row.id !== 'appeared' && row.id !== 'settled').map((row) => row.id),
    ).toEqual(['started', 'ready-0', 'sent-1', 'ready-1']);
  });
});
