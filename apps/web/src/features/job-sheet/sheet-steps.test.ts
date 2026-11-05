import type { Job, JobStepRun, ReviewNote, StepId } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { realFirstCutRuns, realJob, realNotes, realNow, realRuns } from './real-job-fixture';
import {
  buildSteps,
  clockText,
  countText,
  minutesText,
  RECENT_MS,
  type StepsView,
  waitingText,
} from './sheet-steps';
import {
  type JobSheetState,
  jobSheetJobs,
  jobSheetNotes,
  jobSheetNow,
  jobSheetRuns,
} from './test-fixtures';

// The fixtures are written in UTC clock times, so the tests read them in UTC.
const UTC = 'UTC';

/** The Steps section of one of the boards' jobs, at the moment the board is drawn at. */
function board(state: JobSheetState, notes?: readonly ReviewNote[]): StepsView {
  return buildSteps(jobSheetJobs[state], jobSheetRuns[state], {
    now: Date.parse(jobSheetNow[state]),
    timeZone: UTC,
    notes,
  });
}

/** `[row index, sub-heading]` for each row that opens a later round. */
const headings = (view: StepsView) =>
  view.rows.flatMap((row, index) => (row.heading === null ? [] : [[index, row.heading]]));

/** `[name, kind, text]` per row: what a board lists. */
const listed = (view: StepsView) => view.rows.map((row) => [row.name, row.kind, row.text]);

const ALL_PENDING = [
  ['Brief', 'pending', ''],
  ['Transcribe', 'pending', ''],
  ['Scan', 'pending', ''],
  ['Plan', 'pending', ''],
  ['Cut', 'pending', ''],
  ['Preview', 'pending', ''],
  ['Check', 'pending', ''],
  ['Render', 'pending', ''],
];

describe('buildSteps: a job that has not started', () => {
  it.each(['arriving', 'queued', 'held'] as const)('%s: eight steps not started', (state) => {
    const view = board(state);
    expect(view.label).toBe('not started');
    expect(listed(view)).toEqual(ALL_PENDING);
    expect(view.summary).toBeNull();
  });
});

describe('buildSteps: editing', () => {
  it('lists the finished steps, the running one blue, and Render waiting for the approval', () => {
    const view = board('editing');
    expect(view.label).toBe('started 14:30');
    expect(listed(view)).toEqual([
      ['Brief', 'done', '14:30 · 1 min'],
      ['Transcribe', 'done', '14:31 · 3 min'],
      ['Scan', 'done', '14:34 · 5 min'],
      ['Plan', 'done', '14:39 · 2 min'],
      ['Cut', 'running', 'now · 2 of 5'],
      ['Preview', 'pending', ''],
      ['Check', 'pending', ''],
      ['Render', 'pending', 'after you approve'],
    ]);
    expect(view.summary).toBeNull();
  });

  it('says just "now" for a running step with no sub-progress', () => {
    const job: Job = { ...jobSheetJobs.editing, subProgress: null };
    const view = buildSteps(job, jobSheetRuns.editing, { now: Date.parse(jobSheetNow.editing) });
    expect(view.rows[4]).toMatchObject({ name: 'Cut', kind: 'running', text: 'now' });
  });

  it('shows the sub-progress on the job’s own step only', () => {
    // A stale open run of another step never gets the job's sub-progress.
    const runs: JobStepRun[] = [
      ...jobSheetRuns.editing.slice(0, 3),
      { ...(jobSheetRuns.editing[3] as JobStepRun), endedAt: null },
    ];
    const view = buildSteps(jobSheetJobs.editing, runs, { now: 0, timeZone: UTC });
    expect(view.rows[3]).toMatchObject({ name: 'Plan', kind: 'running', text: 'now' });
  });
});

describe('buildSteps: ready to review', () => {
  it('adds "Your review" between Check and Render, waiting, and the minutes of work', () => {
    const view = board('review');
    expect(view.label).toBe('33 min of work');
    expect(listed(view)).toEqual([
      ['Brief', 'done', '13:02 · 1 min'],
      ['Transcribe', 'done', '13:03 · 3 min'],
      ['Scan', 'done', '13:06 · 5 min'],
      ['Plan', 'done', '13:11 · 13 min'],
      ['Cut', 'done', '13:24 · 7 min'],
      ['Preview', 'done', '13:31 · 3 min'],
      ['Check', 'done', '13:34 · 1 min'],
      ['Your review', 'waiting', 'waiting 9 min'],
      ['Render', 'pending', ''],
    ]);
    expect(view.summary).toBeNull();
  });

  it('counts the wait from the end of the round’s last step, and ticks with the clock', () => {
    const at = (iso: string) =>
      buildSteps(jobSheetJobs.review, jobSheetRuns.review, { now: Date.parse(iso), timeZone: UTC })
        .rows[7]?.text;
    expect(at('2026-10-22T13:35:20.000Z')).toBe('waiting <1 min');
    expect(at('2026-10-22T13:36:00.000Z')).toBe('waiting 1 min');
    expect(at('2026-10-22T15:40:00.000Z')).toBe('waiting 2 h');
    expect(at('2026-10-25T13:40:00.000Z')).toBe('waiting 3 days');
  });

  it('never goes negative when the browser clock is behind the engine’s', () => {
    const view = buildSteps(jobSheetJobs.review, jobSheetRuns.review, {
      now: Date.parse('2026-10-22T13:00:00.000Z'),
      timeZone: UTC,
    });
    expect(view.rows[7]?.text).toBe('waiting <1 min');
  });
});

describe('buildSteps: review round 2', () => {
  it('shows only the round’s own steps, from Plan, and says so in the label', () => {
    const view = board('reviewRound2');
    expect(view.label).toBe('Round 2 · from Plan');
    expect(listed(view)).toEqual([
      ['Plan', 'done', '12:11 · 2 min'],
      ['Cut', 'done', '12:13 · 6 min'],
      ['Preview', 'done', '12:19 · 2 min'],
      ['Check', 'done', '12:21 · 1 min'],
      ['Your review', 'waiting', 'waiting 26 min'],
      ['Render', 'pending', ''],
    ]);
  });

  it('shows a revise run that is under way from Plan, with Render waiting for the approval', () => {
    const job: Job = { ...jobSheetJobs.reviewRound2, state: 'editing', step: 5, subProgress: null };
    // The first cut, the revise run's Plan, and its Cut still open.
    const done = jobSheetRuns.reviewRound2.slice(0, 9);
    const runs = [...done.slice(0, 8), { ...(done[8] as JobStepRun), endedAt: null }];
    const view = buildSteps(job, runs, {
      now: Date.parse('2026-10-22T12:15:00.000Z'),
      timeZone: UTC,
    });
    expect(view.label).toBe('Round 2 · from Plan');
    expect(listed(view)).toEqual([
      ['Plan', 'done', '12:11 · 2 min'],
      ['Cut', 'running', 'now'],
      ['Preview', 'pending', ''],
      ['Check', 'pending', ''],
      ['Render', 'pending', 'after you approve'],
    ]);
  });

  it('shows the round’s steps as not started while its revise run waits in the queue', () => {
    const job: Job = { ...jobSheetJobs.reviewRound2, state: 'queued', step: null, placeInLine: 1 };
    const view = buildSteps(job, jobSheetRuns.reviewRound2.slice(0, 7), { now: 0, timeZone: UTC });
    expect(view.label).toBe('Round 2 · from Plan');
    expect(listed(view)).toEqual(ALL_PENDING.slice(3));
  });
});

describe('buildSteps: rendering', () => {
  it('has the review approved and Render running', () => {
    const view = board('rendering');
    expect(view.label).toBe('25 min of work');
    expect(listed(view)).toEqual([
      ['Brief', 'done', '14:02 · 1 min'],
      ['Transcribe', 'done', '14:03 · 2 min'],
      ['Scan', 'done', '14:05 · 4 min'],
      ['Plan', 'done', '14:09 · 9 min'],
      ['Cut', 'done', '14:18 · 6 min'],
      ['Preview', 'done', '14:24 · 2 min'],
      ['Check', 'done', '14:26 · 1 min'],
      ['Your review', 'done', 'approved 15:10'],
      ['Render', 'running', 'now'],
    ]);
  });

  it('does not count the run that is still open as work done', () => {
    // 25, not 27 (the 2 minutes Render has been running at the board's moment).
    expect(board('rendering').label).toBe('25 min of work');
  });
});

describe('buildSteps: failed', () => {
  it('shows the failed step red with the time it failed, after an approved review', () => {
    const view = board('failed');
    expect(view.label).toBe('35 min of work');
    expect(listed(view)).toEqual([
      ['Brief', 'done', '12:10 · 1 min'],
      ['Transcribe', 'done', '12:11 · 3 min'],
      ['Scan', 'done', '12:14 · 5 min'],
      ['Plan', 'done', '12:19 · 14 min'],
      ['Cut', 'done', '12:33 · 8 min'],
      ['Preview', 'done', '12:41 · 3 min'],
      ['Check', 'done', '12:44 · 1 min'],
      ['Your review', 'done', 'approved 12:50'],
      ['Render', 'failed', 'failed 12:52'],
    ]);
  });

  it('marks the step the job failed at even when it never got a run row', () => {
    const job: Job = {
      ...jobSheetJobs.failed,
      failedAt: 4,
      step: 4,
      runKind: 'edit',
      approvedAt: null,
    };
    const runs = jobSheetRuns.failed.slice(0, 3);
    const view = buildSteps(job, runs, { now: Date.parse(jobSheetNow.failed), timeZone: UTC });
    expect(view.label).toBe('');
    expect(listed(view).slice(2, 5)).toEqual([
      ['Scan', 'done', '12:14 · 5 min'],
      ['Plan', 'failed', 'failed 12:52'],
      ['Cut', 'pending', ''],
    ]);
    expect(view.rows).toHaveLength(8);
  });

  it('shows Render not started again once the retry is queued', () => {
    const job: Job = { ...jobSheetJobs.failed, state: 'queued', failedAt: null, error: null };
    const view = buildSteps(job, jobSheetRuns.failed, {
      now: Date.parse(jobSheetNow.failed),
      timeZone: UTC,
    });
    expect(view.rows.at(-2)).toMatchObject({
      name: 'Your review',
      kind: 'done',
      text: 'approved 12:50',
    });
    expect(view.rows.at(-1)).toMatchObject({ name: 'Render', kind: 'pending', text: '' });
  });

  it('shows the new run of a retried step, not the one that failed', () => {
    const retried: JobStepRun[] = [
      ...jobSheetRuns.failed,
      {
        step: 8,
        runKind: 'render',
        round: 0,
        startedAt: '2026-10-22T12:55:00.000Z',
        endedAt: '2026-10-22T12:57:00.000Z',
      },
    ];
    const job: Job = { ...jobSheetJobs.failed, state: 'ready', failedAt: null, error: null };
    const view = buildSteps(job, retried, {
      now: Date.parse('2026-10-22T13:00:00.000Z'),
      timeZone: UTC,
    });
    expect(view.rows.at(-1)).toMatchObject({ name: 'Render', kind: 'done', text: '12:55 · 2 min' });
  });
});

describe('buildSteps: cancelled', () => {
  it('shows the step it was stopped in, grey, with the time, and the rest not started', () => {
    const view = board('cancelled');
    expect(view.label).toBe('');
    expect(listed(view)).toEqual([
      ['Brief', 'done', '10:20 · 1 min'],
      ['Transcribe', 'done', '10:21 · 2 min'],
      ['Scan', 'done', '10:23 · 4 min'],
      ['Plan', 'done', '10:27 · 8 min'],
      ['Cut', 'stopped', 'stopped 10:41'],
      ['Preview', 'pending', ''],
      ['Check', 'pending', ''],
      ['Render', 'pending', ''],
    ]);
  });
});

describe('buildSteps: a finished job', () => {
  it('folds an approved job into one line and keeps the rows for when it is opened', () => {
    const view = board('approved');
    // The board says 26; its own rows add up to 29.
    expect(view.summary).toBe('All 8 steps done · 29 min of work');
    expect(view.label).toBe('');
    expect(listed(view)).toEqual([
      ['Brief', 'done', '11:40 · 1 min'],
      ['Transcribe', 'done', '11:41 · 2 min'],
      ['Scan', 'done', '11:43 · 4 min'],
      ['Plan', 'done', '11:47 · 11 min'],
      ['Cut', 'done', '11:58 · 6 min'],
      ['Preview', 'done', '12:04 · 2 min'],
      ['Check', 'done', '12:06 · 1 min'],
      ['Your review', 'done', 'approved 13:55'],
      ['Render', 'done', '13:55 · 2 min'],
    ]);
  });

  it('folds a delivered job the same way, with the sum of its runs', () => {
    expect(board('delivered').summary).toBe('All 8 steps done · 36 min of work');
  });

  it('names the review rounds, one and many, and adds up every round’s work', () => {
    // paid: 35 + 11 + 2; archived: 37 + 10 + 9 + 2.
    expect(board('paid').summary).toBe('All 8 steps done · 1 review round · 48 min of work');
    expect(board('archived').summary).toBe('All 8 steps done · 2 review rounds · 58 min of work');
  });

  it('tells a one-round job’s whole story: the first cut, the notes, the second cut, then Render', () => {
    const view = board('paid');
    // The fold line names the rounds; the rows name each later round themselves.
    expect(view.label).toBe('');
    expect(listed(view)).toEqual([
      ['Brief', 'done', '16:20 · 1 min'],
      ['Transcribe', 'done', '16:21 · 3 min'],
      ['Scan', 'done', '16:24 · 5 min'],
      ['Plan', 'done', '16:29 · 15 min'],
      ['Cut', 'done', '16:44 · 8 min'],
      ['Preview', 'done', '16:52 · 2 min'],
      ['Check', 'done', '16:54 · 1 min'],
      // Without the sent notes there is no count, and the time is when the revise run started.
      ['Your review', 'done', 'notes sent 17:11'],
      ['Plan', 'done', '17:11 · 2 min'],
      ['Cut', 'done', '17:13 · 6 min'],
      ['Preview', 'done', '17:19 · 2 min'],
      ['Check', 'done', '17:21 · 1 min'],
      ['Your review', 'done', 'approved 17:38'],
      ['Render', 'done', '17:38 · 2 min'],
    ]);
    expect(headings(view)).toEqual([[8, 'Round 2 · from Plan']]);
    expect(view.rows.map((row) => row.round)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1]);
  });

  it('counts the notes of the round and gives the time they were sent, once they are loaded', () => {
    const view = board('paid', jobSheetNotes.paid);
    expect(view.rows.find((row) => row.round === 0 && row.key === 'review')?.text).toBe(
      '2 notes sent 17:10',
    );
    // The review of the last round is still the approval.
    expect(view.rows.find((row) => row.round === 1 && row.key === 'review')?.text).toBe(
      'approved 17:38',
    );
  });

  it('says "1 note" for one note, and keeps the run’s time for a round the notes do not hold', () => {
    const one = board('paid', jobSheetNotes.paid.slice(0, 1));
    expect(one.rows[7]).toMatchObject({ name: 'Your review', text: '1 note sent 17:10' });
    // Notes of another round do not count for this one.
    const elsewhere = board('paid', jobSheetNotes.archived.slice(2));
    expect(elsewhere.rows[7]).toMatchObject({ name: 'Your review', text: 'notes sent 17:11' });
    // Loaded and empty: no count either.
    expect(board('paid', []).rows[7]?.text).toBe('notes sent 17:11');
  });

  it('takes the earliest time the round’s notes were sent', () => {
    const [first, second] = jobSheetNotes.paid as [ReviewNote, ReviewNote];
    const notes = [{ ...first, sentAt: '2026-10-20T17:10:40.000Z' }, second];
    expect(board('paid', notes).rows[7]?.text).toBe('2 notes sent 17:10');
  });

  it('lists the first cut, each round under its sub-heading, and Render last, for a two-round job', () => {
    const view = board('archived', jobSheetNotes.archived);
    // A job from weeks ago has dates, not clock times, and no clock on the steps.
    expect(listed(view)).toEqual([
      ['Brief', 'done', '1 min'],
      ['Transcribe', 'done', '3 min'],
      ['Scan', 'done', '6 min'],
      ['Plan', 'done', '14 min'],
      ['Cut', 'done', '9 min'],
      ['Preview', 'done', '3 min'],
      ['Check', 'done', '1 min'],
      ['Your review', 'done', '2 notes sent 10 Sep'],
      ['Plan', 'done', '2 min'],
      ['Cut', 'done', '5 min'],
      ['Preview', 'done', '2 min'],
      ['Check', 'done', '1 min'],
      ['Your review', 'done', '1 note sent 11 Sep'],
      ['Plan', 'done', '2 min'],
      ['Cut', 'done', '4 min'],
      ['Preview', 'done', '2 min'],
      ['Check', 'done', '1 min'],
      ['Your review', 'done', 'approved 12 Sep'],
      ['Render', 'done', '2 min'],
    ]);
    expect(headings(view)).toEqual([
      [8, 'Round 2 · from Plan'],
      [13, 'Round 3 · from Plan'],
    ]);
    expect(view.label).toBe('');
    expect(view.summary).toBe('All 8 steps done · 2 review rounds · 58 min of work');
    // Every row has its own key within the list, whatever its round.
    const keys = view.rows.map((row) => `${row.round}-${row.key}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('adds up every round in the fold line, and counts all 8 step names once in the first cut', () => {
    const view = board('archived');
    expect(view.rows.filter((row) => row.round === 0 && row.step !== null)).toHaveLength(7);
    expect(view.rows.at(-1)).toMatchObject({ key: 8, round: 2, name: 'Render' });
    expect(view.rows.filter((row) => row.step === 8)).toHaveLength(1);
  });

  it('draws a job with no rounds as before: the 8 steps with "Your review" before Render', () => {
    const view = board('delivered');
    expect(view.rows).toHaveLength(9);
    expect(headings(view)).toEqual([]);
    expect(view.rows.every((row) => row.round === 0)).toBe(true);
    // The sent notes make no difference to it.
    expect(board('delivered', jobSheetNotes.paid).rows).toEqual(view.rows);
  });

  it('shows the rounds of a finished job whose runs are gone, empty and in order', () => {
    const job: Job = { ...jobSheetJobs.paid, approvedAt: null };
    const view = buildSteps(job, [], { now: 0, timeZone: UTC });
    expect(view.rows.map((row) => row.name)).toEqual([
      'Brief',
      'Transcribe',
      'Scan',
      'Plan',
      'Cut',
      'Preview',
      'Check',
      'Your review',
      'Plan',
      'Cut',
      'Preview',
      'Check',
      'Your review',
      'Render',
    ]);
    expect(view.rows[7]?.text).toBe('notes sent');
    expect(view.rows[12]?.text).toBe('approved');
  });

  it('leaves a job still in review or editing on its current round, with the label and no sub-heading', () => {
    const review = board('reviewRound2', jobSheetNotes.reviewRound2);
    expect(review.label).toBe('Round 2 · from Plan');
    expect(headings(review)).toEqual([]);
    const rendering: Job = { ...jobSheetJobs.paid, state: 'editing', step: 8 };
    const view = buildSteps(rendering, jobSheetRuns.paid, { now: 0, timeZone: UTC });
    expect(view.label).toBe('Round 2 · from Plan');
    expect(view.rows).toHaveLength(6);
    expect(headings(view)).toEqual([]);
  });

  it('does not fold a job that is not ready', () => {
    expect(board('rendering').summary).toBeNull();
    expect(board('review').summary).toBeNull();
    expect(board('failed').summary).toBeNull();
  });

  it('calls every step of a ready job done, even one with no runs on record', () => {
    const job: Job = { ...jobSheetJobs.approved, approvedAt: null };
    const view = buildSteps(job, [], { now: 0, timeZone: UTC });
    expect(view.summary).toBe('All 8 steps done');
    expect(view.rows).toHaveLength(9);
    expect(view.rows.map((row) => row.kind)).toEqual(Array(9).fill('done'));
    expect(view.rows[7]).toMatchObject({ name: 'Your review', text: 'approved' });
  });
});

// CVP-262: real runs are sparse (the worker times only the steps the editing agent reports) and some
// stay open for good, so the rows are read by where the job got to (real-job-fixture.ts).
describe('buildSteps: sparse and partly open runs', () => {
  const at = (day: string, time: string) => `2026-10-${day}T${time}.000Z`;
  const run = (
    step: StepId,
    start: string,
    end: string | null,
    runKind: JobStepRun['runKind'] = 'edit',
  ): JobStepRun => ({
    step,
    runKind,
    round: 0,
    startedAt: at('22', start),
    endedAt: end === null ? null : at('22', end),
  });
  const view = (job: Job, runs: readonly JobStepRun[], time = '15:00:00') =>
    buildSteps(job, runs, { now: Date.parse(at('22', time)), timeZone: UTC });
  const edit: Job = { ...jobSheetJobs.editing, step: 5, subProgress: null };

  it('reads the real job’s second round: Cut done and untimed, Plan and Check done with their start', () => {
    const result = buildSteps(realJob, realRuns, {
      now: Date.parse(realNow),
      timeZone: UTC,
      notes: realNotes,
    });
    expect(listed(result)).toEqual([
      ['Plan', 'done', '18:55'],
      ['Cut', 'done', ''],
      ['Preview', 'done', '18:57 · <1 min'],
      ['Check', 'done', '18:57'],
      ['Your review', 'waiting', 'waiting 12 min'],
      ['Render', 'pending', ''],
    ]);
    expect(result.label).toBe('Round 2 · from Plan');
  });

  it('reads the real job’s first cut: the four steps the agent never reported are done and untimed', () => {
    const first: Job = {
      ...realJob,
      round: 0,
      runKind: 'edit',
      updatedAt: '2026-10-21T18:41:17.000Z',
    };
    const result = buildSteps(first, realFirstCutRuns, {
      now: Date.parse('2026-10-21T19:00:00.000Z'),
      timeZone: UTC,
    });
    expect(listed(result)).toEqual([
      ['Brief', 'done', '18:38 · <1 min'],
      ['Transcribe', 'done', ''],
      ['Scan', 'done', ''],
      ['Plan', 'done', ''],
      ['Cut', 'done', ''],
      ['Preview', 'done', '18:40 · <1 min'],
      ['Check', 'done', '18:40 · <1 min'],
      ['Your review', 'waiting', 'waiting 18 min'],
      ['Render', 'pending', ''],
    ]);
  });

  it('keeps the step the job really is editing running, and the open one before it done', () => {
    const editing: Job = { ...realJob, state: 'editing', step: 7 };
    const result = buildSteps(editing, realRuns, { now: Date.parse(realNow), timeZone: UTC });
    expect(listed(result)).toEqual([
      ['Plan', 'done', '18:55'],
      ['Cut', 'done', ''],
      ['Preview', 'done', '18:57 · <1 min'],
      ['Check', 'running', 'now'],
      ['Render', 'pending', 'after you approve'],
    ]);
    expect(result.label).toBe('Round 2 · from Plan');
  });

  it('keeps every step of a round the job has moved past done while it renders, Render running', () => {
    const rendering: Job = {
      ...realJob,
      state: 'editing',
      runKind: 'render',
      step: 8,
      approvedAt: '2026-10-22T19:20:00.000Z',
    };
    const runs = [...realRuns, { ...run(8, '19:20:00', null, 'render'), round: 1 }];
    const result = buildSteps(rendering, runs, { now: Date.parse('2026-10-22T19:21:00.000Z') });
    expect(listed(result)).toEqual([
      ['Plan', 'done', expect.stringMatching(/^\d\d:\d\d$/)],
      ['Cut', 'done', ''],
      ['Preview', 'done', expect.stringMatching(/^\d\d:\d\d · <1 min$/)],
      ['Check', 'done', expect.stringMatching(/^\d\d:\d\d$/)],
      ['Your review', 'done', expect.stringMatching(/^approved \d\d:\d\d$/)],
      ['Render', 'running', 'now'],
    ]);
  });

  it('reads the steps of an approved job with no runs but the render as done, once it was in review', () => {
    const result = view({ ...jobSheetJobs.rendering }, [run(8, '15:10:00', null, 'render')]);
    expect(listed(result).map((row) => row.slice(0, 2))).toEqual([
      ['Brief', 'done'],
      ['Transcribe', 'done'],
      ['Scan', 'done'],
      ['Plan', 'done'],
      ['Cut', 'done'],
      ['Preview', 'done'],
      ['Check', 'done'],
      ['Your review', 'done'],
      ['Render', 'running'],
    ]);
  });

  it('reads a job waiting in Review with no runs at all as done up to Check', () => {
    const result = view(jobSheetJobs.review, []);
    expect(
      listed(result)
        .slice(0, 8)
        .map((row) => row[1]),
    ).toEqual([...Array(7).fill('done'), 'waiting']);
    expect(listed(result).at(-1)).toEqual(['Render', 'pending', '']);
  });

  it('reads a step with no run before one that ran as done, whatever the job is doing', () => {
    // Transcribe and Scan were never reported; the agent went from Brief to Plan.
    const runs = [
      run(1, '14:30:00', '14:31:00'),
      run(4, '14:39:00', '14:41:00'),
      run(5, '14:41:00', null),
    ];
    expect(listed(view(edit, runs)).map((row) => row.slice(0, 2))).toEqual([
      ['Brief', 'done'],
      ['Transcribe', 'done'],
      ['Scan', 'done'],
      ['Plan', 'done'],
      ['Cut', 'running'],
      ['Preview', 'pending'],
      ['Check', 'pending'],
      ['Render', 'pending'],
    ]);
    // A queued job after a retry too: the step it carries on from is not started again.
    const queued: Job = { ...edit, state: 'queued', step: null };
    expect(listed(view(queued, runs)).map((row) => row[1])).toEqual([
      'done',
      'done',
      'done',
      'done',
      'pending',
      'pending',
      'pending',
      'pending',
    ]);
  });

  it('leaves a step after the last one that ran not started', () => {
    const runs = [run(1, '14:30:00', '14:31:00'), run(2, '14:31:00', '14:34:00')];
    const result = view({ ...edit, step: 3 }, runs);
    expect(listed(result).map((row) => row[1])).toEqual([
      'done',
      'done',
      'pending',
      'pending',
      'pending',
      'pending',
      'pending',
      'pending',
    ]);
  });

  it('reads the steps before the one an editing job is at as done, though they were never reported', () => {
    const result = view({ ...edit, step: 5 }, [run(1, '14:30:00', '14:31:00')]);
    expect(listed(result).map((row) => row[1])).toEqual([
      'done',
      'done',
      'done',
      'done',
      'pending',
      'pending',
      'pending',
      'pending',
    ]);
  });

  it('reads an open run followed by a later step’s run as done, not running', () => {
    // A restart cut the run in two: Plan was left open, Cut is the step that is running now.
    const runs = [
      run(1, '14:30:00', '14:31:00'),
      run(4, '14:39:00', null),
      run(5, '14:41:00', null),
    ];
    const result = view(edit, runs);
    expect(result.rows[3]).toMatchObject({ name: 'Plan', kind: 'done', text: '14:39' });
    expect(result.rows[4]).toMatchObject({ name: 'Cut', kind: 'running', text: 'now' });
  });

  it('marks a failed job’s step failed, the steps before it done and the ones after not started', () => {
    const failed: Job = {
      ...jobSheetJobs.cancelled,
      state: 'failed',
      failedAt: 5,
      stoppedAt: null,
      step: 5,
      error: 'Cut failed',
    };
    // Brief ran; Transcribe's run was left open by a restart and Scan has none.
    const runs = [
      run(1, '10:20:00', '10:21:00'),
      run(2, '10:21:00', null),
      run(4, '10:27:00', '10:35:00'),
      run(5, '10:35:00', null),
    ];
    expect(listed(view(failed, runs)).map((row) => row.slice(0, 2))).toEqual([
      ['Brief', 'done'],
      ['Transcribe', 'done'],
      ['Scan', 'done'],
      ['Plan', 'done'],
      ['Cut', 'failed'],
      ['Preview', 'pending'],
      ['Check', 'pending'],
      ['Render', 'pending'],
    ]);
  });

  it('marks a stopped job’s step stopped even when only Brief has a run', () => {
    const result = view(jobSheetJobs.cancelled, [run(1, '10:20:00', '10:21:00')]);
    expect(listed(result).map((row) => row[1])).toEqual([
      'done',
      'done',
      'done',
      'done',
      'stopped',
      'pending',
      'pending',
      'pending',
    ]);
  });

  it('keeps a failed Render failed and the steps before it done (the review was reached)', () => {
    const result = view(jobSheetJobs.failed, [run(8, '12:50:00', null, 'render')], '13:00:00');
    expect(listed(result).map((row) => row.slice(0, 2))).toEqual([
      ['Brief', 'done'],
      ['Transcribe', 'done'],
      ['Scan', 'done'],
      ['Plan', 'done'],
      ['Cut', 'done'],
      ['Preview', 'done'],
      ['Check', 'done'],
      ['Your review', 'done'],
      ['Render', 'failed'],
    ]);
  });

  it('lists the real job’s whole story once it is ready, with the same reading in every round', () => {
    const ready: Job = {
      ...realJob,
      state: 'ready',
      runKind: 'render',
      step: 8,
      approvedAt: '2026-10-22T19:20:00.000Z',
    };
    const runs = [...realRuns, { ...run(8, '19:20:00', '19:22:00', 'render'), round: 1 }];
    const result = buildSteps(ready, runs, {
      now: Date.parse('2026-10-22T19:30:00.000Z'),
      timeZone: UTC,
      notes: realNotes,
    });
    expect(listed(result)).toEqual([
      ['Brief', 'done', '18:38 · <1 min'],
      ['Transcribe', 'done', ''],
      ['Scan', 'done', ''],
      ['Plan', 'done', ''],
      ['Cut', 'done', ''],
      ['Preview', 'done', '18:40 · <1 min'],
      ['Check', 'done', '18:40 · <1 min'],
      ['Your review', 'done', '2 notes sent 21:54'],
      ['Plan', 'done', '18:55'],
      ['Cut', 'done', ''],
      ['Preview', 'done', '18:57 · <1 min'],
      ['Check', 'done', '18:57'],
      ['Your review', 'done', 'approved 19:20'],
      ['Render', 'done', '19:20 · 2 min'],
    ]);
  });
});

describe('countText', () => {
  it('says a count the way the sentence does, and leaves the rest alone', () => {
    expect(countText('graphics 2/5')).toBe('2 of 5');
    expect(countText('6/14')).toBe('6 of 14');
    expect(countText('pass 2/3')).toBe('pass 2 of 3');
    expect(countText('reading 2 files')).toBe('reading 2 files');
    expect(countText('')).toBe('');
  });
});

describe('minutes', () => {
  const run = (step: StepId, start: string, seconds: number | null): JobStepRun => ({
    step,
    runKind: 'edit',
    round: 0,
    startedAt: `2026-10-22T${start}:00.000Z`,
    endedAt:
      seconds === null
        ? null
        : new Date(Date.parse(`2026-10-22T${start}:00.000Z`) + seconds * 1000).toISOString(),
  });

  it('reads a step under a minute as "<1 min"', () => {
    const view = buildSteps(jobSheetJobs.review, [run(1, '13:02', 40), run(2, '13:03', 59.9)], {
      now: Date.parse(jobSheetNow.review),
      timeZone: UTC,
    });
    expect(view.rows[0]?.text).toBe('13:02 · <1 min');
    expect(view.rows[1]?.text).toBe('13:03 · <1 min');
  });

  it('adds up the exact lengths, so short steps still count towards the total', () => {
    // Four steps of 40 s: each reads "<1 min", together they are 160 s, about 3 minutes.
    const runs = [
      run(1, '13:02', 40),
      run(2, '13:03', 40),
      run(3, '13:04', 40),
      run(4, '13:05', 40),
    ];
    const view = buildSteps(jobSheetJobs.review, runs, {
      now: Date.parse(jobSheetNow.review),
      timeZone: UTC,
    });
    expect(view.rows.slice(0, 4).map((row) => row.text.split(' · ')[1])).toEqual([
      '<1 min',
      '<1 min',
      '<1 min',
      '<1 min',
    ]);
    expect(view.label).toBe('3 min of work');
  });

  it('says "<1 min of work" when everything that finished took under a minute', () => {
    const view = buildSteps(jobSheetJobs.review, [run(1, '13:02', 20)], {
      now: Date.parse(jobSheetNow.review),
      timeZone: UTC,
    });
    expect(view.label).toBe('<1 min of work');
  });

  it('adds nothing for runs that are still open', () => {
    const view = buildSteps(jobSheetJobs.review, [run(1, '13:02', null)], {
      now: Date.parse(jobSheetNow.review),
      timeZone: UTC,
    });
    expect(view.label).toBe('');
  });

  it('rounds a step to the nearest minute', () => {
    expect(minutesText(0)).toBe('<1 min');
    expect(minutesText(59_999)).toBe('<1 min');
    expect(minutesText(60_000)).toBe('1 min');
    expect(minutesText(89_000)).toBe('1 min');
    expect(minutesText(90_000)).toBe('2 min');
    expect(minutesText(7_500_000)).toBe('125 min');
    expect(minutesText(Number.NaN)).toBe('<1 min');
    expect(minutesText(-5)).toBe('<1 min');
  });

  it('writes a long wait in hours and days', () => {
    expect(waitingText(0)).toBe('<1 min');
    expect(waitingText(-1000)).toBe('<1 min');
    expect(waitingText(59 * 60_000 + 59_000)).toBe('59 min');
    expect(waitingText(60 * 60_000)).toBe('1 h');
    expect(waitingText(23 * 3_600_000 + 59 * 60_000)).toBe('23 h');
    expect(waitingText(24 * 3_600_000)).toBe('1 day');
    expect(waitingText(49 * 3_600_000)).toBe('2 days');
  });
});

describe('which runs are shown', () => {
  const at = (time: string) => `2026-10-22T${time}:00.000Z`;
  const run = (step: StepId, start: string, end: string | null): JobStepRun => ({
    step,
    runKind: 'edit',
    round: 0,
    startedAt: at(start),
    endedAt: end === null ? null : at(end),
  });

  it('shows a step as not started again when the job restarted from an earlier step', () => {
    // Transcribe and Scan ran at 10:21 and 10:23; Brief ran again at 12:00 and is still going.
    const job: Job = { ...jobSheetJobs.editing, step: 1, subProgress: null };
    const runs = [
      run(1, '10:20', '10:21'),
      run(2, '10:21', '10:23'),
      run(3, '10:23', '10:27'),
      run(1, '12:00', null),
    ];
    const view = buildSteps(job, runs, { now: Date.parse(at('12:01')), timeZone: UTC });
    expect(listed(view).slice(0, 3)).toEqual([
      ['Brief', 'running', 'now'],
      ['Transcribe', 'pending', ''],
      ['Scan', 'pending', ''],
    ]);
  });

  it('ignores runs of other rounds', () => {
    const view = buildSteps(jobSheetJobs.reviewRound2, jobSheetRuns.reviewRound2, {
      now: 0,
      timeZone: UTC,
    });
    expect(view.rows.map((row) => row.step)).toEqual([4, 5, 6, 7, null, 8]);
    const first = buildSteps(
      { ...jobSheetJobs.reviewRound2, round: 0 },
      jobSheetRuns.reviewRound2,
      { now: 0, timeZone: UTC },
    );
    expect(first.rows.map((row) => row.text.slice(0, 5))).toContain('11:21');
  });

  it('is not fooled by a run left open when the job is waiting, ready or queued again', () => {
    const open = jobSheetRuns.cancelled; // Cut is open
    const queued: Job = { ...jobSheetJobs.cancelled, state: 'queued', step: null, stoppedAt: null };
    expect(buildSteps(queued, open, { now: 0, timeZone: UTC }).rows[4]).toMatchObject({
      kind: 'pending',
      text: '',
    });
  });
});

describe('times', () => {
  it('reads the clock in 24 hours, on the given zone', () => {
    expect(clockText('2026-10-22T14:30:00.000Z', 'UTC')).toBe('14:30');
    expect(clockText('2026-10-22T14:30:00.000Z', 'Asia/Kolkata')).toBe('20:00');
    expect(clockText('2026-10-22T09:05:00.000Z', 'UTC')).toBe('09:05');
  });

  it('writes midnight as 00:xx, never 24:xx', () => {
    expect(clockText('2026-10-21T21:05:00.000Z', 'Asia/Jerusalem')).toBe('00:05');
    expect(clockText('2026-10-22T00:00:00.000Z', 'UTC')).toBe('00:00');
  });

  it('gives "" for a time it cannot read', () => {
    expect(clockText('not a time', 'UTC')).toBe('');
  });

  it('uses the browser’s own zone when none is given', () => {
    const iso = '2026-10-22T14:30:00.000Z';
    const local = new Date(iso);
    const expected = `${String(local.getHours()).padStart(2, '0')}:${String(local.getMinutes()).padStart(2, '0')}`;
    expect(clockText(iso)).toBe(expected);
  });

  it('puts a step’s clock time on the browser’s clock in the rows', () => {
    const view = buildSteps(jobSheetJobs.review, jobSheetRuns.review, {
      now: Date.parse(jobSheetNow.review),
      timeZone: 'Asia/Kolkata',
    });
    expect(view.rows[0]?.text).toBe('18:32 · 1 min');
  });

  it('reads a time as a date once it is over a week old', () => {
    const run = jobSheetRuns.approved[0] as JobStepRun;
    const job: Job = { ...jobSheetJobs.approved, approvedAt: run.startedAt };
    const started = Date.parse(run.startedAt);
    const approvedText = (now: number) =>
      buildSteps(job, [run], { now, timeZone: UTC }).rows.find((row) => row.step === null)?.text;
    expect(approvedText(started + RECENT_MS)).toBe('approved 11:40');
    expect(approvedText(started + RECENT_MS + 1)).toBe('approved 22 Oct');
  });
});
