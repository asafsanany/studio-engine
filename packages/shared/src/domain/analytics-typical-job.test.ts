import { describe, expect, it } from 'vitest';
import {
  ANALYTICS_SIZES,
  analyticsTypicalJobSchema,
  EDITOR_STAGE_KEYS,
  TYPICAL_JOB_STAGES,
} from './analytics.ts';
import type { AnalyticsJob, AnalyticsStepRun, ComputeAnalyticsInput } from './analytics-compute.ts';
import { computeTypicalJobSection } from './analytics-typical-job.ts';
import type { RunKind } from './run-kind.ts';
import type { StepId } from './steps.ts';
import { makeJob } from './test-fixtures.ts';

/** Thursday 22 October 2026, 09:00 in Israel. */
const NOW = Date.parse('2026-10-22T09:00:00+03:00');
const MIN = 60_000;
const DAY = 86_400_000;
/** A job added about ten days ago: inside "the last 30 days". */
const RECENT = NOW - 10 * DAY;
/** A job added about forty days ago: inside "the 30 days before". */
const EARLIER = NOW - 40 * DAY;

const iso = (ms: number): string => new Date(ms).toISOString();

function input(overrides: Partial<ComputeAnalyticsInput> = {}): ComputeAnalyticsInput {
  return {
    now: NOW,
    timeZone: 'Asia/Jerusalem',
    jobs: [],
    stepRuns: [],
    sentNotes: [],
    deliveries: [],
    usage: [],
    limits: [],
    noteTopics: {},
    ...overrides,
  };
}

/** What one job's story looks like, in minutes; the numbers of the J1 board are the defaults. */
interface Story {
  /** Added to the first step starting. */
  wait?: number;
  /** Brief, Transcribe, Scan, Plan, Cut, Preview, Check; `null` for a step that never ran. */
  steps?: readonly (number | null)[];
  /** One entry per round of notes: how long Plan, Preview and Check took in that round. */
  rounds?: readonly (readonly [number, number, number])[];
  /**
   * How long the owner waited, from the end of Check to the approval, not counting the editor's revise
   * time (so at least 10 minutes a round: they read each preview first); `null` if never approved.
   */
  review?: number | null;
  /** The render's step 8; `null` for a job without one. */
  render?: number | null;
  /** Put the render in the edit run, as a job with Review off does. */
  renderInEdit?: boolean;
}

interface Built {
  job: AnalyticsJob;
  runs: AnalyticsStepRun[];
}

/** A finished job and its timed steps, laid end to end the way the worker writes them. */
function finishedJob(id: string, addedMs: number, story: Story = {}): Built {
  const {
    wait = 4,
    steps = [2, 3, 4, 6, 16, 13, 8],
    rounds = [],
    review = 112,
    render = 4,
    renderInEdit = false,
  } = story;
  const runs: AnalyticsStepRun[] = [];
  let cursor = addedMs + wait * MIN;
  const run = (step: StepId, kind: RunKind, round: number, minutes: number | null) => {
    if (minutes === null) return;
    runs.push({
      jobId: id,
      step,
      runKind: kind,
      round,
      startedAt: iso(cursor),
      endedAt: iso(cursor + minutes * MIN),
    });
    cursor += minutes * MIN;
  };

  steps.forEach((minutes, index) => {
    run((index + 1) as StepId, 'edit', 0, minutes);
  });
  const checkEnd = cursor;
  let revising = 0;
  rounds.forEach(([plan, preview, check], index) => {
    cursor += 10 * MIN; // The owner reads the preview and writes their notes
    run(4, 'revise', index + 1, plan);
    run(6, 'revise', index + 1, preview);
    run(7, 'revise', index + 1, check);
    revising += plan + preview + check;
  });
  let approvedAt: number | null = null;
  if (review !== null) {
    approvedAt = checkEnd + (review + revising) * MIN;
    cursor = approvedAt;
  }
  if (renderInEdit) run(8, 'edit', 0, render);
  else run(8, 'render', rounds.length, render);

  const job = {
    ...makeJob({
      id,
      state: 'ready',
      addedAt: iso(addedMs),
      approvedAt: approvedAt === null ? null : iso(approvedAt),
      round: rounds.length,
      output: {
        fileName: `Client/${id}.mp4`,
        durationSec: 30,
        width: 1080,
        height: 1920,
        sizeBytes: 1_000_000,
      },
    }),
    startedAt: iso(addedMs + wait * MIN),
    finishedAt: iso(cursor),
    footageSec: 600,
  };
  return { job, runs };
}

function section(...built: Built[]) {
  return computeTypicalJobSection(
    input({ jobs: built.map((b) => b.job), stepRuns: built.flatMap((b) => b.runs) }),
  );
}

const stage = (answer: ReturnType<typeof section>, key: string) =>
  answer.stages.find((candidate) => candidate.key === key);

describe('computeTypicalJobSection with no finished job', () => {
  const answer = computeTypicalJobSection(input());

  it('lists every stretch in order, each without a number', () => {
    expect(answer.stages.map((s) => s.key)).toEqual(TYPICAL_JOB_STAGES.map((s) => s.key));
    expect(answer.stages.map((s) => s.label)).toEqual([
      'Waiting to start',
      'Brief',
      'Transcribe',
      'Scan',
      'Plan',
      'Cut',
      'Preview',
      'Check',
      'Waiting for you',
      'Render',
    ]);
    for (const s of answer.stages) {
      expect(s.medianSec).toBeNull();
      expect(s.beforeSec).toBeNull();
    }
  });

  it('has no totals, no slowest step and no jobs counted', () => {
    expect(answer).toMatchObject({
      editorSec: null,
      editorBeforeSec: null,
      wholeSec: null,
      wholeBeforeSec: null,
      slowestStepKey: null,
      jobsCounted: 0,
      jobsCountedBefore: 0,
    });
  });

  it('is a valid answer of the contract', () => {
    expect(analyticsTypicalJobSchema.parse(answer)).toEqual(answer);
  });
});

describe('computeTypicalJobSection for one finished job', () => {
  const answer = section(finishedJob('a', RECENT));

  it('measures every stretch of the job in seconds', () => {
    const seconds = Object.fromEntries(answer.stages.map((s) => [s.key, s.medianSec]));
    expect(seconds).toEqual({
      'waiting-to-start': 4 * 60,
      brief: 2 * 60,
      transcribe: 3 * 60,
      scan: 4 * 60,
      plan: 6 * 60,
      cut: 16 * 60,
      preview: 13 * 60,
      check: 8 * 60,
      'waiting-for-you': 112 * 60,
      render: 4 * 60,
    });
  });

  it('gives the editor total, the whole job and the slowest step', () => {
    expect(answer.editorSec).toBe(52 * 60);
    expect(answer.wholeSec).toBe((4 + 52 + 112 + 4) * 60);
    expect(answer.slowestStepKey).toBe('cut');
    expect(answer.jobsCounted).toBe(1);
  });

  it('has nothing to compare with when no job finished in the 30 days before', () => {
    expect(answer.jobsCountedBefore).toBe(0);
    expect(answer.editorBeforeSec).toBeNull();
    expect(answer.wholeBeforeSec).toBeNull();
    for (const s of answer.stages) expect(s.beforeSec).toBeNull();
  });

  it('is a valid answer of the contract, also after a trip through JSON', () => {
    expect(analyticsTypicalJobSchema.parse(JSON.parse(JSON.stringify(answer)))).toEqual(answer);
  });
});

describe('the medians', () => {
  it('take the middle job of three', () => {
    const answer = section(
      finishedJob('a', RECENT, { steps: [1, 1, 1, 1, 10, 1, 1] }),
      finishedJob('b', RECENT, { steps: [2, 2, 2, 2, 20, 2, 2] }),
      finishedJob('c', RECENT, { steps: [9, 9, 9, 9, 90, 9, 9] }),
    );
    expect(stage(answer, 'cut')?.medianSec).toBe(20 * 60);
    expect(stage(answer, 'brief')?.medianSec).toBe(2 * 60);
    expect(answer.jobsCounted).toBe(3);
  });

  it('take the mean of the two middle jobs of four, in whole seconds', () => {
    const answer = section(
      finishedJob('a', RECENT, { wait: 1 }),
      finishedJob('b', RECENT, { wait: 2 }),
      finishedJob('c', RECENT, { wait: 3 }),
      finishedJob('d', RECENT, { wait: 100 }),
    );
    expect(stage(answer, 'waiting-to-start')?.medianSec).toBe(150);
    const odd = section(finishedJob('a', RECENT, { wait: 1.2345 }), finishedJob('b', RECENT));
    expect(Number.isInteger(stage(odd, 'waiting-to-start')?.medianSec)).toBe(true);
  });

  it('skip a job that lacks a stretch for that stretch only', () => {
    const answer = section(
      finishedJob('a', RECENT, { steps: [2, 3, 4, 6, 10, 13, 8], review: null }),
      finishedJob('b', RECENT, { steps: [4, 3, 4, 6, 30, 13, 8], review: 60 }),
      finishedJob('c', RECENT, { steps: [2, 3, null, 6, 50, 13, 8], review: 100 }),
    );
    // Scan: a and b have it. Waiting for you: b and c. Cut: all three.
    expect(stage(answer, 'scan')?.medianSec).toBe(4 * 60);
    expect(stage(answer, 'waiting-for-you')?.medianSec).toBe(80 * 60);
    expect(stage(answer, 'cut')?.medianSec).toBe(30 * 60);
    expect(answer.jobsCounted).toBe(3);
  });

  it('leave a stretch no job has as null, not 0', () => {
    const answer = section(
      finishedJob('a', RECENT, { review: null, render: null }),
      finishedJob('b', RECENT, { review: null, render: null }),
    );
    expect(stage(answer, 'waiting-for-you')?.medianSec).toBeNull();
    expect(stage(answer, 'render')?.medianSec).toBeNull();
    expect(stage(answer, 'cut')?.medianSec).toBe(16 * 60);
  });
});

describe('the last 30 days and the 30 days before', () => {
  const answer = section(
    finishedJob('now-a', RECENT, { steps: [2, 3, 4, 6, 16, 13, 8], render: 4 }),
    finishedJob('now-b', RECENT + DAY, { steps: [2, 3, 4, 6, 20, 13, 8], render: 6 }),
    finishedJob('old-a', EARLIER, { steps: [3, 3, 6, 9, 22, 18, 8], render: 4 }),
    finishedJob('old-b', EARLIER, { steps: [3, 3, 6, 9, 24, 18, 8], render: 8 }),
    finishedJob('old-c', EARLIER, { steps: [3, 3, 6, 9, 26, 18, 8], render: 6 }),
  );

  it('count the jobs of each window', () => {
    expect(answer.jobsCounted).toBe(2);
    expect(answer.jobsCountedBefore).toBe(3);
  });

  it('give each stretch its median now and its median before', () => {
    expect(stage(answer, 'cut')).toMatchObject({ medianSec: 18 * 60, beforeSec: 24 * 60 });
    expect(stage(answer, 'brief')).toMatchObject({ medianSec: 2 * 60, beforeSec: 3 * 60 });
    expect(stage(answer, 'render')).toMatchObject({ medianSec: 5 * 60, beforeSec: 6 * 60 });
  });

  it('give the totals now and before', () => {
    expect(answer.editorSec).toBe(Math.round((52 + 56) / 2) * 60);
    expect(answer.editorBeforeSec).toBe((3 + 3 + 6 + 9 + 24 + 18 + 8) * 60);
    // Their wholes are 189, 195 and 195 minutes.
    expect(answer.wholeBeforeSec).toBe(195 * 60);
  });

  it('belong to the window the job finished in, not the one it was added in', () => {
    // Added 31 days ago, finished 5 days ago (it waited a long time for the owner).
    const slow = finishedJob('slow', NOW - 31 * DAY, { review: 26 * 24 * 60 });
    const answerSlow = section(slow);
    expect(answerSlow.jobsCounted).toBe(1);
    expect(answerSlow.jobsCountedBefore).toBe(0);
    expect(stage(answerSlow, 'waiting-for-you')?.medianSec).toBe(26 * 24 * 60 * 60);
  });

  it('end at now and at 30 days ago: a job finished exactly 30 days ago is in the window before', () => {
    const built = finishedJob('edge', NOW - 31 * DAY);
    const onTheLine = {
      ...built,
      job: { ...built.job, finishedAt: iso(NOW - ANALYTICS_SIZES.month.windowDays * DAY) },
    };
    // A window is "after, up to and including": the line belongs to the 30 days before.
    expect(section(onTheLine)).toMatchObject({ jobsCounted: 0, jobsCountedBefore: 1 });
    const justAfter = {
      ...built,
      job: { ...built.job, finishedAt: iso(NOW - ANALYTICS_SIZES.month.windowDays * DAY + 1) },
    };
    expect(section(justAfter)).toMatchObject({ jobsCounted: 1, jobsCountedBefore: 0 });
  });

  it('leave out jobs older than 60 days', () => {
    expect(section(finishedJob('ancient', NOW - 90 * DAY))).toMatchObject({
      jobsCounted: 0,
      jobsCountedBefore: 0,
      wholeSec: null,
    });
  });
});

describe('which jobs count', () => {
  it('only the ones with a video: a job without an output is not finished', () => {
    const built = finishedJob('a', RECENT);
    const unfinished = { ...built, job: { ...built.job, output: null, state: 'review' as const } };
    expect(section(unfinished).jobsCounted).toBe(0);
  });

  it('only the ones that have a finish time', () => {
    const built = finishedJob('a', RECENT);
    const noFinish = { ...built, job: { ...built.job, finishedAt: null } };
    expect(section(noFinish).jobsCounted).toBe(0);
  });

  it('a job that was archived still counts', () => {
    const built = finishedJob('a', RECENT);
    const archived = { ...built, job: { ...built.job, archivedAt: iso(NOW - DAY) } };
    expect(section(archived).jobsCounted).toBe(1);
  });

  it('a finished job without any timed step still counts, for the whole job only', () => {
    const built = finishedJob('a', RECENT);
    const answer = section({ job: built.job, runs: [] });
    expect(answer.jobsCounted).toBe(1);
    expect(answer.wholeSec).toBeGreaterThan(0);
    expect(answer.editorSec).toBeNull();
    for (const s of answer.stages) expect(s.medianSec).toBeNull();
  });
});

describe('waiting for you', () => {
  it('runs from the end of the first Check to the approval, minus the revise runs', () => {
    // Two rounds of notes: 3+4+2 min and 2+3+1 min of revising; the owner waited 40 min in all.
    const answer = section(
      finishedJob('a', RECENT, {
        rounds: [
          [3, 4, 2],
          [2, 3, 1],
        ],
        review: 40,
      }),
    );
    expect(stage(answer, 'waiting-for-you')?.medianSec).toBe(40 * 60);
  });

  it('is empty for a job that was never approved', () => {
    const answer = section(finishedJob('a', RECENT, { review: null }));
    expect(stage(answer, 'waiting-for-you')?.medianSec).toBeNull();
  });

  it('is empty when the first Check never finished', () => {
    const built = finishedJob('a', RECENT);
    const runs = built.runs.map((run) =>
      run.runKind === 'edit' && run.step === 7 ? { ...run, endedAt: null } : run,
    );
    expect(stage(section({ job: built.job, runs }), 'waiting-for-you')?.medianSec).toBeNull();
  });

  it('is empty rather than negative when the approval is older than the Check', () => {
    const built = finishedJob('a', RECENT);
    const job = { ...built.job, approvedAt: iso(RECENT) };
    expect(stage(section({ job, runs: built.runs }), 'waiting-for-you')?.medianSec).toBeNull();
  });
});

describe('the editor', () => {
  it('adds up the edit run and every revise round, steps 1 to 7', () => {
    const answer = section(
      finishedJob('a', RECENT, {
        rounds: [
          [3, 4, 2],
          [2, 3, 1],
        ],
      }),
    );
    expect(answer.editorSec).toBe((52 + 9 + 6) * 60);
  });

  it('keeps the revise rounds out of the step stretches, which are the round-0 run only', () => {
    const answer = section(finishedJob('a', RECENT, { rounds: [[30, 30, 30]] }));
    expect(stage(answer, 'plan')?.medianSec).toBe(6 * 60);
    expect(stage(answer, 'preview')?.medianSec).toBe(13 * 60);
    expect(stage(answer, 'check')?.medianSec).toBe(8 * 60);
  });

  it('does not count the render, whichever run it is in', () => {
    const answer = section(finishedJob('a', RECENT, { renderInEdit: true, review: null }));
    expect(answer.editorSec).toBe(52 * 60);
    expect(stage(answer, 'render')?.medianSec).toBe(4 * 60);
  });

  it('does not count a step that is still open or was left open', () => {
    const built = finishedJob('a', RECENT);
    const runs = built.runs.map((run) =>
      run.runKind === 'edit' && run.step === 3 ? { ...run, endedAt: null } : run,
    );
    const answer = section({ job: built.job, runs });
    expect(stage(answer, 'scan')?.medianSec).toBeNull();
    expect(answer.editorSec).toBe(48 * 60);
    // The step still tells when the editor began, so the wait before it is known.
    expect(stage(answer, 'waiting-to-start')?.medianSec).toBe(4 * 60);
  });

  it('adds the lengths of a step that ran twice in the edit run', () => {
    const built = finishedJob('a', RECENT);
    const cut = built.runs.find((run) => run.step === 5);
    if (cut === undefined) throw new Error('fixture has no Cut');
    const twice = [...built.runs, { ...cut }];
    expect(stage(section({ job: built.job, runs: twice }), 'cut')?.medianSec).toBe(32 * 60);
  });
});

describe('waiting to start and the whole job', () => {
  it('waits from the job being added to the first step starting', () => {
    expect(
      stage(section(finishedJob('a', RECENT, { wait: 25 })), 'waiting-to-start')?.medianSec,
    ).toBe(25 * 60);
  });

  it('is empty for a job whose first step started before it was added', () => {
    const built = finishedJob('a', RECENT, { wait: -5 });
    expect(stage(section(built), 'waiting-to-start')?.medianSec).toBeNull();
    expect(stage(section(built), 'brief')?.medianSec).toBe(2 * 60);
  });

  it('is files in to ready: finished minus added', () => {
    const built = finishedJob('a', RECENT, { wait: 10, review: 20 });
    const expectMs = Date.parse(built.job.finishedAt ?? '') - Date.parse(built.job.addedAt);
    expect(section(built).wholeSec).toBe(expectMs / 1000);
  });
});

describe('the slowest step', () => {
  it('is the editor step with the longest median', () => {
    const answer = section(
      finishedJob('a', RECENT, { steps: [2, 3, 4, 6, 10, 20, 8] }),
      finishedJob('b', RECENT, { steps: [2, 3, 4, 6, 12, 22, 8] }),
    );
    expect(answer.slowestStepKey).toBe('preview');
  });

  it('is the earlier step when two are alike', () => {
    const answer = section(finishedJob('a', RECENT, { steps: [2, 9, 4, 6, 9, 3, 8] }));
    expect(answer.slowestStepKey).toBe('transcribe');
  });

  it('is never a wait or the render, however long', () => {
    const answer = section(finishedJob('a', RECENT, { review: 5000, render: 300, wait: 400 }));
    expect(answer.slowestStepKey).toBe('cut');
    expect(EDITOR_STAGE_KEYS).toContain(answer.slowestStepKey);
  });

  it('is null when no step has a median', () => {
    const built = finishedJob('a', RECENT);
    expect(section({ job: built.job, runs: [] }).slowestStepKey).toBeNull();
  });
});

describe('the runs of different jobs', () => {
  it('are kept apart: each job reads its own', () => {
    const a = finishedJob('a', RECENT, { steps: [2, 3, 4, 6, 16, 13, 8] });
    const b = finishedJob('b', RECENT, { steps: [20, 3, 4, 6, 16, 13, 8] });
    // Each keeps its own Brief (2 and 20 minutes), so the median is their mean.
    expect(stage(section(a, b), 'brief')?.medianSec).toBe(11 * 60);
  });
});
