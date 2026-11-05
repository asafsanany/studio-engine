import {
  type Job,
  type JobEvent,
  type JobOutput,
  type RunKind,
  type ServerEvent,
  STEP_IDS,
  type StepId,
} from '@studio/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type FinishedRun,
  JobRepository,
  type StepDuration,
  StepRunRepository,
  type StudioDb,
} from '../db/index.js';
import { fakeClock, makeScan, memoryDb, SAMPLE_PREVIEW } from '../db/test-utils.js';
import { createEventBus } from '../events/bus.js';
import { makeJob } from '../events/test-utils.js';
import {
  createEtaEstimator,
  createEtaTicker,
  createStepFallback,
  ETA_MIN_SAMPLES,
  ETA_SAMPLE_LIMIT,
  ETA_TICK_MS,
  etaSecFrom,
  skippedSteps,
  stepRate,
  usableRates,
  wholeRunRate,
} from './eta.js';
import { FakeIntervals } from './test-utils.js';

// All figures here use 10 minutes of footage and 60 s per step for the past jobs, which is
// 6 s of work per footage minute; a 5-minute job then needs 30 s per step.

/** Every step of an edit: Brief (1) to Render (8). */
const ALL_STEPS: readonly StepId[] = STEP_IDS;
/**
 * The seven steps a job had before Brief existed (CVP-99): a database migrated to eight steps
 * holds history for these and none for Brief.
 */
const BEFORE_BRIEF: readonly StepId[] = [2, 3, 4, 5, 6, 7, 8];

function sample(durationSec: number, footageSec = 600, jobId = 'past') {
  return { jobId, durationSec, footageSec };
}

/** A finished run: `runSec` over 10 minutes of footage unless said otherwise. */
function finished(steps: readonly StepId[], runSec = 420, footageSec = 600): FinishedRun {
  return { jobId: 'done', runSec, footageSec, steps: [...steps] };
}

describe('stepRate', () => {
  it('is null without history and below three usable samples', () => {
    expect(ETA_MIN_SAMPLES).toBe(3);
    expect(stepRate([])).toBeNull();
    expect(stepRate([sample(60)])).toBeNull();
    expect(stepRate([sample(60), sample(60)])).toBeNull();
  });

  it('is the median seconds per footage minute from three samples on', () => {
    // 10 min of footage: 30 s, 60 s and 90 s are 3, 6 and 9 s per minute.
    expect(stepRate([sample(90), sample(30), sample(60)])).toBe(6);
  });

  it('scales each sample by its own footage', () => {
    // 60 s over 10 min, 30 s over 5 min and 12 s over 2 min are all 6 s per minute.
    expect(stepRate([sample(60, 600), sample(30, 300), sample(12, 120)])).toBe(6);
  });

  it('averages the two middle samples when their number is even', () => {
    expect(stepRate([sample(10), sample(20), sample(40), sample(1000)])).toBe((2 + 4) / 2);
  });

  it('is not thrown off by one slow run', () => {
    expect(stepRate([sample(60), sample(61), sample(59), sample(3600)])).toBe(6.05);
  });

  it('ignores samples with no footage: they have no rate, and do not count towards the three', () => {
    expect(stepRate([sample(60, 0), sample(60), sample(60)])).toBeNull();
    expect(stepRate([sample(60, 0), sample(60), sample(60), sample(60)])).toBe(6);
    expect(stepRate([sample(60, Number.NaN), sample(60), sample(60), sample(60)])).toBe(6);
  });

  it('keeps a zero-length run: a step that really took no time is a sample', () => {
    expect(stepRate([sample(0), sample(0), sample(60)])).toBe(0);
  });
});

describe('usableRates', () => {
  it('is the seconds per footage minute of each usable sample, in order', () => {
    expect(usableRates([sample(60), sample(30, 300), sample(12, 120)])).toEqual([6, 6, 6]);
    expect(usableRates([sample(60, 0), sample(120), sample(60, Number.NaN)])).toEqual([12]);
    expect(usableRates([])).toEqual([]);
  });
});

describe('wholeRunRate', () => {
  it('is the median run seconds per footage minute, from three finished jobs on', () => {
    expect(wholeRunRate([])).toBeNull();
    expect(wholeRunRate([finished([1], 600), finished([1], 600)])).toBeNull();
    // 10 min of footage: 300 s, 600 s and 3600 s are 30, 60 and 360 s per minute.
    expect(wholeRunRate([finished([1], 3600), finished([1], 300), finished([1], 600)])).toBe(60);
  });

  it('ignores jobs with no known footage: they have no rate and do not count towards the three', () => {
    const noFootage = finished([1], 600, 0);
    expect(wholeRunRate([noFootage, finished([1], 600), finished([1], 600)])).toBeNull();
    expect(
      wholeRunRate([noFootage, finished([1], 600), finished([1], 600), finished([1], 600)]),
    ).toBe(60);
  });
});

describe('skippedSteps', () => {
  const all: readonly StepId[] = ALL_STEPS;
  const without = (...skipped: StepId[]) => all.filter((id) => !skipped.includes(id));

  it('says nothing until three jobs have finished', () => {
    expect(skippedSteps([]).size).toBe(0);
    expect(skippedSteps([finished(without(7)), finished(without(7))]).size).toBe(0);
  });

  it('lists the steps none of the newest three finished jobs ran', () => {
    const edits = [finished(without(5, 7)), finished(without(7)), finished(without(7, 6))];
    expect([...skippedSteps(edits)]).toEqual([7]);
  });

  it('counts a step that only has an interrupted run as run, as the repository lists it', () => {
    // Its run was left open, so it is in `steps` although it has no finished sample.
    const edits = [finished(all), finished(without(5)), finished(without(5))];
    expect(skippedSteps(edits).size).toBe(0);
  });

  it('looks at the newest three only: an older job that ran the step does not matter', () => {
    const edits = [finished(without(7)), finished(without(7)), finished(without(7)), finished(all)];
    expect([...skippedSteps(edits)]).toEqual([7]);
    // And a step the newest job ran again is no longer skipped.
    expect(skippedSteps([finished(all), ...edits.slice(1)]).size).toBe(0);
  });
});

describe('skippedSteps on history that predates Brief', () => {
  it('lists Brief: no finished job ran it, so it counts as nothing', () => {
    const edits = [1, 2, 3].map(() => finished(BEFORE_BRIEF));
    expect([...skippedSteps(edits)]).toEqual([1]);
  });
});

describe('createStepFallback', () => {
  const threeJobs = (runSec: number, steps: readonly StepId[] = ALL_STEPS) => [
    finished(steps, runSec),
    finished(steps, runSec),
    finished(steps, runSec),
  ];

  it('is an even share of the whole-run rate', () => {
    // 800 s over 10 minutes is 80 s per minute for eight steps: 10 each.
    expect(createStepFallback(threeJobs(800))(6, [])).toBe(10);
  });

  it('shares it among the steps that were not skipped', () => {
    // Check skipped: 70 s per minute over seven steps is 10 each, and Check itself is 0.
    const fallback = createStepFallback(threeJobs(700, [1, 2, 3, 4, 5, 6, 8]));
    expect(fallback(6, [])).toBe(10);
    expect(fallback(7, [])).toBe(0);
  });

  it('uses the slowest run the step has of its own when it is above the share', () => {
    const fallback = createStepFallback(threeJobs(800));
    expect(fallback(8, [4, 8])).toBe(10);
    expect(fallback(8, [4, 12])).toBe(12);
  });

  it('has nothing for a step that is not skipped before three finished jobs of known footage', () => {
    expect(createStepFallback([])(6, [9])).toBeNull();
    expect(createStepFallback(threeJobs(800).slice(0, 2))(6, [9])).toBeNull();
  });

  it('still counts a skipped step as 0 when there is no whole-run rate', () => {
    // Three finished jobs that skipped Check but have no footage length to scale by.
    const edits = [1, 2, 3].map(() => finished([1, 2, 3, 4, 5, 6, 8], 700, 0));
    const fallback = createStepFallback(edits);
    expect(fallback(7, [])).toBe(0);
    expect(fallback(6, [])).toBeNull();
  });

  it('on history that predates Brief, counts Brief as 0 and shares the edit over the other seven', () => {
    // 700 s over 10 minutes is 70 s per minute for the seven steps that ran: 10 each, as it was.
    const fallback = createStepFallback(threeJobs(700, BEFORE_BRIEF));
    expect(fallback(1, [])).toBe(0);
    expect(fallback(2, [])).toBe(10);
    expect(fallback(8, [])).toBe(10);
  });
});

describe('etaSecFrom', () => {
  const rateOf = (rates: Partial<Record<StepId, number | null>>) => (step: StepId) =>
    rates[step] ?? null;
  const uniform = rateOf(Object.fromEntries(ALL_STEPS.map((step) => [step, 6])));

  it('adds the rest of the current step and every later step, scaled by the job footage', () => {
    // 5 min of footage: 30 s per step. At step 4 after 10 s: 20 + 4 later steps of 30.
    expect(etaSecFrom({ step: 4, footageSec: 300, elapsedSec: 10, rateOf: uniform })).toBe(140);
    expect(etaSecFrom({ step: 1, footageSec: 300, elapsedSec: 0, rateOf: uniform })).toBe(240);
    expect(etaSecFrom({ step: 8, footageSec: 300, elapsedSec: 5, rateOf: uniform })).toBe(25);
  });

  it('never counts less than nothing for the current step', () => {
    expect(etaSecFrom({ step: 7, footageSec: 300, elapsedSec: 100, rateOf: uniform })).toBe(30);
    expect(etaSecFrom({ step: 8, footageSec: 300, elapsedSec: 100, rateOf: uniform })).toBe(0);
    expect(etaSecFrom({ step: 8, footageSec: 300, elapsedSec: -5, rateOf: uniform })).toBe(30);
  });

  it('is null when any step still to do has too little history', () => {
    const missing6 = rateOf({ 1: 6, 2: 6, 3: 6, 4: 6, 5: 6, 6: null, 7: 6, 8: 6 });
    expect(etaSecFrom({ step: 5, footageSec: 300, elapsedSec: 0, rateOf: missing6 })).toBeNull();
    expect(etaSecFrom({ step: 6, footageSec: 300, elapsedSec: 0, rateOf: missing6 })).toBeNull();
  });

  it('does not need history for steps already behind the job', () => {
    const fromStep6 = rateOf({ 6: 6, 7: 6, 8: 6 });
    expect(etaSecFrom({ step: 6, footageSec: 300, elapsedSec: 0, rateOf: fromStep6 })).toBe(90);
    expect(etaSecFrom({ step: 5, footageSec: 300, elapsedSec: 0, rateOf: fromStep6 })).toBeNull();
  });

  it('counts the fallback for a step that has no rate of its own, and only for those', () => {
    const missing6 = rateOf({ 1: 6, 2: 6, 3: 6, 4: 6, 5: 6, 6: null, 7: 6, 8: 6 });
    const fallbackOf = vi.fn(() => 10);

    // 5 min of footage: seven steps of 30 s and one of 50 s.
    expect(
      etaSecFrom({ step: 1, footageSec: 300, elapsedSec: 0, rateOf: missing6, fallbackOf }),
    ).toBe(260);
    expect(fallbackOf).toHaveBeenCalledTimes(1);
    expect(fallbackOf).toHaveBeenCalledWith(6);
  });

  it('counts down the current step from its fallback too, never below 0', () => {
    const none = rateOf({ 8: null });
    const fallbackOf = () => 10;
    expect(etaSecFrom({ step: 8, footageSec: 300, elapsedSec: 20, rateOf: none, fallbackOf })).toBe(
      30,
    );
    expect(etaSecFrom({ step: 8, footageSec: 300, elapsedSec: 90, rateOf: none, fallbackOf })).toBe(
      0,
    );
  });

  it('is still null when the fallback has nothing either', () => {
    const missing6 = rateOf({ 1: 6, 2: 6, 3: 6, 4: 6, 5: 6, 6: null, 7: 6, 8: 6 });
    expect(
      etaSecFrom({
        step: 1,
        footageSec: 300,
        elapsedSec: 0,
        rateOf: missing6,
        fallbackOf: () => null,
      }),
    ).toBeNull();
  });

  it('is null when the footage is unknown', () => {
    for (const footageSec of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(etaSecFrom({ step: 1, footageSec, elapsedSec: 0, rateOf: uniform })).toBeNull();
    }
  });

  it('stops at the last step of a run that ends in a preview, even without a rate for the rest', () => {
    // Up to Check: step 8 is never asked for, so having no rate for it does not make it null.
    const toCheck = rateOf({ 4: 6, 5: 6, 6: 6, 7: 6 });
    const fallbackOf = vi.fn(() => null);
    expect(
      etaSecFrom({
        step: 4,
        lastStep: 7,
        footageSec: 300,
        elapsedSec: 0,
        rateOf: toCheck,
        fallbackOf,
      }),
    ).toBe(4 * 30);
    expect(fallbackOf).not.toHaveBeenCalled();
    // Without lastStep it runs to Render and has no rate for it.
    expect(etaSecFrom({ step: 4, footageSec: 300, elapsedSec: 0, rateOf: toCheck })).toBeNull();
    expect(
      etaSecFrom({ step: 4, lastStep: 8, footageSec: 300, elapsedSec: 0, rateOf: uniform }),
    ).toBe(5 * 30);
  });

  it('still counts the step the job is in when that is past the last step', () => {
    // An edit that failed at Render, retried with the Review switch on: step 8, last step 7.
    expect(
      etaSecFrom({ step: 8, lastStep: 7, footageSec: 300, elapsedSec: 10, rateOf: uniform }),
    ).toBe(20);
  });
});

describe('createEtaEstimator', () => {
  type PerStep = Partial<Record<StepId, number | StepDuration[]>>;

  /**
   * A stand-in for the step_runs repository: samples per step (for the edit runs, and per kind in
   * `kinds`), open runs by `job:step`, and the finished runs per kind.
   */
  function history(
    perStep: PerStep = {},
    startedAt: Record<string, Date> = {},
    finishedEdits: FinishedRun[] = [],
    kinds: Partial<
      Record<'revise' | 'render', { perStep?: PerStep; finished?: FinishedRun[] }>
    > = {},
  ) {
    const samplesFor = (own: number | StepDuration[] | undefined) =>
      typeof own === 'number' || own === undefined
        ? Array.from({ length: own ?? 0 }, () => sample(60))
        : own;
    const recentDurations = vi.fn((step: StepId, _limit: number, kind: RunKind) =>
      samplesFor(kind === 'edit' ? perStep[step] : kinds[kind]?.perStep?.[step]),
    );
    const openRunStartedAt = vi.fn(
      (jobId: string, step: StepId) => startedAt[`${jobId}:${step}`] ?? null,
    );
    const recentFinishedRuns = vi.fn((kind: RunKind, _limit: number) =>
      kind === 'edit' ? finishedEdits : (kinds[kind]?.finished ?? []),
    );
    return { recentDurations, openRunStartedAt, recentFinishedRuns };
  }
  const everyStep = (count: number) =>
    Object.fromEntries(ALL_STEPS.map((step) => [step, count])) as Record<StepId, number>;
  const T0 = Date.parse('2026-10-20T10:00:00.000Z');
  const secondsAfterT0 = (sec: number) => new Date(T0 + sec * 1000);
  const editing = (overrides: Partial<Job> = {}) =>
    makeJob({ state: 'editing', step: 1, etaSec: null, ...overrides });

  it('has no estimate without history', () => {
    const estimate = createEtaEstimator({ stepRuns: history(), clock: () => secondsAfterT0(0) });
    expect(estimate(editing(), 300)).toBeNull();
  });

  it('has no estimate with only two samples of a step still to do', () => {
    const runs = history({ ...everyStep(5), 6: 2 });
    const estimate = createEtaEstimator({ stepRuns: runs, clock: () => secondsAfterT0(0) });
    expect(estimate(editing({ step: 1 }), 300)).toBeNull();
    // Step 6 is behind a job in step 7: it no longer matters.
    expect(estimate(editing({ step: 7 }), 300)).toBe(60);
  });

  it('gives the expected seconds from three samples per step', () => {
    expect(ETA_SAMPLE_LIMIT).toBe(10);
    const runs = history(everyStep(3), { [`${editing().id}:4`]: secondsAfterT0(0) });
    const estimate = createEtaEstimator({ stepRuns: runs, clock: () => secondsAfterT0(10) });

    // 5 min of footage, 30 s per step, 10 s into step 4: 20 + 4 x 30.
    expect(estimate(editing({ step: 4 }), 300)).toBe(140);
    expect(runs.recentDurations).toHaveBeenCalledWith(4, ETA_SAMPLE_LIMIT, 'edit');
  });

  it('counts the time in the step from its open run, so the estimate shrinks as time passes', () => {
    let now = 0;
    const job = editing({ step: 3 });
    const runs = history(everyStep(4), { [`${job.id}:3`]: secondsAfterT0(0) });
    const estimate = createEtaEstimator({ stepRuns: runs, clock: () => secondsAfterT0(now) });

    expect(estimate(job, 300)).toBe(180);
    now = 15;
    expect(estimate(job, 300)).toBe(165);
    now = 45;
    expect(estimate(job, 300)).toBe(150);
    now = 600;
    expect(estimate(job, 300)).toBe(150);
  });

  it('is null for a job that is not editing, queued ones included', () => {
    const estimate = createEtaEstimator({
      stepRuns: history(everyStep(5)),
      clock: () => secondsAfterT0(0),
    });
    for (const state of ['queued', 'arriving', 'held', 'failed', 'cancelled', 'ready'] as const) {
      expect(
        estimate(editing({ state, step: state === 'queued' ? null : 1 }), 300),
        state,
      ).toBeNull();
    }
  });

  it('is null when the job has no known footage', () => {
    const estimate = createEtaEstimator({
      stepRuns: history(everyStep(5)),
      clock: () => secondsAfterT0(0),
    });
    expect(estimate(editing(), 0)).toBeNull();
  });

  it('treats an editing job without a step as being at the first step', () => {
    const estimate = createEtaEstimator({
      stepRuns: history(everyStep(3)),
      clock: () => secondsAfterT0(0),
    });
    expect(estimate(editing({ step: null }), 300)).toBe(240);
  });

  it('counts a resumed job from when it was first seen in its step, as it has no open run', () => {
    let now = 0;
    const job = editing({ step: 5 });
    const estimate = createEtaEstimator({
      stepRuns: history(everyStep(3)),
      clock: () => secondsAfterT0(now),
    });

    // 4 steps of 30 s; no run is open, so the clock starts at the first look.
    expect(estimate(job, 300)).toBe(120);
    now = 20;
    expect(estimate(job, 300)).toBe(100);
    // Next step: the count starts again; the same job queued again does too.
    now = 30;
    expect(estimate({ ...job, step: 6 }, 300)).toBe(90);
    now = 40;
    expect(estimate({ ...job, step: 6 }, 300)).toBe(80);
    now = 50;
    expect(estimate({ ...job, state: 'queued', step: 6 }, 300)).toBeNull();
    now = 60;
    expect(estimate({ ...job, step: 6 }, 300)).toBe(90);
  });

  it('reads the history afresh each time', () => {
    const job = editing({ step: 8 });
    const counts = { ...everyStep(3), 8: 2 };
    const runs = history(counts);
    const estimate = createEtaEstimator({ stepRuns: runs, clock: () => secondsAfterT0(0) });

    expect(estimate(job, 300)).toBeNull();
    counts[8] = 3;
    expect(estimate(job, 300)).toBe(30);
  });

  it('on history that predates Brief, counts Brief as nothing: the estimate is the same from Brief', () => {
    // Three finished jobs with the seven old steps, 60 s each, and no Brief run anywhere.
    const edits = [1, 2, 3].map(() => finished(BEFORE_BRIEF, 420));
    const runs = history({ ...everyStep(3), 1: 0 }, {}, edits);
    const estimate = createEtaEstimator({ stepRuns: runs, clock: () => secondsAfterT0(0) });

    // 5 min of footage, seven steps of 30 s: 210 from Brief, and from Transcribe.
    expect(estimate(editing({ step: 1 }), 300)).toBe(210);
    expect(estimate(editing({ step: 2 }), 300)).toBe(210);
  });

  describe('when a step has too few runs of its own', () => {
    // Seven steps at 6 s per footage minute; three finished jobs of 80 s per footage minute, which
    // is a share of 10 s per minute for each of the eight steps. A 5-minute job: 30 s and 50 s.
    const threeFinished = [
      finished(ALL_STEPS, 800),
      finished(ALL_STEPS, 800),
      finished(ALL_STEPS, 800),
    ];
    const estimateFor = (
      perStep: Partial<Record<StepId, number | StepDuration[]>>,
      edits: FinishedRun[] = threeFinished,
    ) => {
      const runs = history(perStep, {}, edits);
      return {
        runs,
        estimate: createEtaEstimator({ stepRuns: runs, clock: () => secondsAfterT0(0) }),
      };
    };

    it('counts an even share of a whole edit instead of switching off', () => {
      const { estimate } = estimateFor({ ...everyStep(3), 6: 1 });
      // Step 6's one run is 6 s per minute: below the share of 10, so the share counts.
      expect(estimate(editing(), 300)).toBe(7 * 30 + 50);
    });

    it('counts the slowest run the step has when that is above the share', () => {
      const { estimate } = estimateFor({ ...everyStep(3), 6: [sample(60), sample(120)] });
      // 120 s over 10 minutes is 12 per minute, 60 s for 5 minutes.
      expect(estimate(editing(), 300)).toBe(7 * 30 + 60);
    });

    it('counts a step that has no run at all, closed or not', () => {
      const { estimate } = estimateFor({ ...everyStep(3), 6: 0, 7: 0 });
      expect(estimate(editing(), 300)).toBe(6 * 30 + 2 * 50);
    });

    it('counts the step the job is in down from its share', () => {
      const { estimate } = estimateFor({ ...everyStep(3), 6: 0 });
      const job = editing({ step: 6 });
      // Step 6 is current, no run is open: counted from the first look, so 50 s, then 50 - 0.
      expect(estimate(job, 300)).toBe(50 + 30 + 30);
    });

    it('counts a step the three newest finished jobs never ran as nothing', () => {
      const withoutCheck: readonly StepId[] = [1, 2, 3, 4, 5, 6, 8];
      const edits = [
        finished(withoutCheck, 700),
        finished(withoutCheck, 700),
        finished(withoutCheck, 700),
      ];
      // 70 s per minute over seven steps: 10 each; Check (7) has no run and is skipped.
      const { estimate } = estimateFor({ ...everyStep(3), 5: 0, 7: 0 }, edits);
      expect(estimate(editing(), 300)).toBe(6 * 30 + 50);
    });

    it('does not count a step as skipped on the word of fewer than three finished jobs', () => {
      const withoutCheck: readonly StepId[] = [1, 2, 3, 4, 5, 6, 8];
      const { estimate } = estimateFor({ ...everyStep(3), 7: 0 }, [
        finished(withoutCheck, 700),
        finished(withoutCheck, 700),
      ]);
      expect(estimate(editing(), 300)).toBeNull();
    });

    it('keeps counting a step with enough runs of its own, even when the newest jobs skipped it', () => {
      const withoutCheck: readonly StepId[] = [1, 2, 3, 4, 5, 6, 8];
      const edits = [finished(withoutCheck), finished(withoutCheck), finished(withoutCheck)];
      const { estimate } = estimateFor(everyStep(3), edits);
      expect(estimate(editing(), 300)).toBe(8 * 30);
    });

    it('stays off before three finished jobs: the first jobs still show nothing', () => {
      const { estimate } = estimateFor({ ...everyStep(3), 6: 1 }, threeFinished.slice(0, 2));
      expect(estimate(editing(), 300)).toBeNull();
    });

    it('does not count a finished job with no known footage towards the three', () => {
      const { estimate } = estimateFor({ ...everyStep(3), 6: 1 }, [
        finished(ALL_STEPS, 800, 0),
        finished(ALL_STEPS, 800),
        finished(ALL_STEPS, 800),
      ]);
      expect(estimate(editing(), 300)).toBeNull();
    });

    it('only asks for the finished jobs when a step needs them', () => {
      const trusted = estimateFor(everyStep(3));
      trusted.estimate(editing(), 300);
      expect(trusted.runs.recentFinishedRuns).not.toHaveBeenCalled();

      const thin = estimateFor({ ...everyStep(3), 6: 1 });
      thin.estimate(editing(), 300);
      expect(thin.runs.recentFinishedRuns).toHaveBeenCalledTimes(1);
      expect(thin.runs.recentFinishedRuns).toHaveBeenCalledWith('edit', ETA_SAMPLE_LIMIT);
    });

    it('has no fallback for a step behind the job: only steps still to do need one', () => {
      const { estimate } = estimateFor({ ...everyStep(3), 1: 0, 2: 0, 3: 1 });
      expect(estimate(editing({ step: 4 }), 300)).toBe(5 * 30);
    });
  });

  // Phase 3: the three runs of a job are different work, estimated from their own history.
  describe('run kinds', () => {
    const revising = (overrides: Partial<Job> = {}) =>
      editing({ runKind: 'revise', round: 1, step: 4, ...overrides });
    const rendering = (overrides: Partial<Job> = {}) =>
      editing({ runKind: 'render', round: 1, step: 8, ...overrides });
    /** Three samples of 60 s over 10 minutes of footage, i.e. 6 s per footage minute. */
    const slowEdit = { ...everyStep(3) };

    it('estimates an edit run up to Check with the Review switch on, up to Render without', () => {
      // No run of Render has ever been timed, and nothing finished: Render has no figure.
      const perStep: PerStep = { ...everyStep(3), 8: 0 };
      const withSwitch = createEtaEstimator({
        stepRuns: history(perStep),
        clock: () => secondsAfterT0(0),
        review: true,
      });
      const without = createEtaEstimator({
        stepRuns: history(perStep),
        clock: () => secondsAfterT0(0),
      });

      // 5 minutes of footage, 30 s per step: Transcribe to Check is six steps.
      expect(withSwitch(editing({ step: 2 }), 300)).toBe(6 * 30);
      expect(without(editing({ step: 2 }), 300)).toBeNull();
    });

    it('never asks for Render when the run ends in a preview', () => {
      const runs = history({ ...everyStep(3), 8: 0 });
      const estimate = createEtaEstimator({
        stepRuns: runs,
        clock: () => secondsAfterT0(0),
        review: true,
      });
      estimate(editing({ step: 2 }), 300);
      expect(runs.recentDurations).not.toHaveBeenCalledWith(
        8,
        expect.anything(),
        expect.anything(),
      );
    });

    describe('a revise run', () => {
      it('asks for the samples of its own kind, for steps 4 to 7 only', () => {
        const runs = history({}, {}, [], {
          revise: { perStep: { 4: 3, 5: 3, 6: 3, 7: 3 } },
        });
        const estimate = createEtaEstimator({ stepRuns: runs, clock: () => secondsAfterT0(0) });

        expect(estimate(revising(), 300)).toBe(4 * 30);
        const asked = runs.recentDurations.mock.calls.map(([step, limit, kind]) => [
          step,
          limit,
          kind,
        ]);
        expect(asked).toEqual([4, 5, 6, 7].map((step) => [step, ETA_SAMPLE_LIMIT, 'revise']));
        // Trusted, so no finished runs were read either.
        expect(runs.recentFinishedRuns).not.toHaveBeenCalled();
      });

      it('gives the medians of three revise samples per step', () => {
        // Per footage minute (10 min): 3, 6, 9 and 12 s; a 5-minute job: 15, 30, 45 and 60 s.
        const runs = history({}, {}, [], {
          revise: {
            perStep: {
              4: [sample(30), sample(30), sample(30)],
              5: [sample(60), sample(60), sample(60)],
              6: [sample(90), sample(90), sample(90)],
              7: [sample(120), sample(120), sample(120)],
            },
          },
        });
        const estimate = createEtaEstimator({ stepRuns: runs, clock: () => secondsAfterT0(0) });
        expect(estimate(revising(), 300)).toBe(15 + 30 + 45 + 60);
      });

      it('uses the edit run’s trusted rates when it has no history of its own', () => {
        const runs = history(slowEdit);
        const estimate = createEtaEstimator({ stepRuns: runs, clock: () => secondsAfterT0(0) });
        expect(estimate(revising(), 300)).toBe(4 * 30);
      });

      it('uses the slowest of the revise runs a step has when it has one or two', () => {
        // Step 4: 3 and 9 s per minute, so 45 s for 5 minutes; the rest from the edit.
        const runs = history(slowEdit, {}, [], {
          revise: { perStep: { 4: [sample(30), sample(90)] } },
        });
        const estimate = createEtaEstimator({ stepRuns: runs, clock: () => secondsAfterT0(0) });
        expect(estimate(revising(), 300)).toBe(45 + 3 * 30);
      });

      it('counts an even share of its own finished runs for a step with too few samples', () => {
        // Three finished revise runs of 400 s over 10 minutes: 40 s per minute over the four
        // steps that ran, 10 each, so 50 s per step for a 5-minute job.
        const runs = history({}, {}, [], {
          revise: {
            finished: [
              finished([4, 5, 6, 7], 400),
              finished([4, 5, 6, 7], 400),
              finished([4, 5, 6, 7], 400),
            ],
          },
        });
        const estimate = createEtaEstimator({ stepRuns: runs, clock: () => secondsAfterT0(0) });
        expect(estimate(revising(), 300)).toBe(4 * 50);
        expect(runs.recentFinishedRuns).toHaveBeenCalledWith('revise', ETA_SAMPLE_LIMIT);
        expect(runs.recentFinishedRuns).not.toHaveBeenCalledWith('edit', expect.anything());
      });

      it('counts a step the three newest revise runs skipped as nothing', () => {
        // They ran Plan, Preview and Check but never Cut (graphics are rarely touched).
        const runs = history({}, {}, [], {
          revise: {
            perStep: { 4: 3, 6: 3, 7: 3 },
            finished: [
              finished([4, 6, 7], 180),
              finished([4, 6, 7], 180),
              finished([4, 6, 7], 180),
            ],
          },
        });
        const estimate = createEtaEstimator({ stepRuns: runs, clock: () => secondsAfterT0(0) });
        expect(estimate(revising(), 300)).toBe(3 * 30);
      });

      it('has no figure rather than a guess when neither kind has anything', () => {
        const estimate = createEtaEstimator({
          stepRuns: history(),
          clock: () => secondsAfterT0(0),
        });
        expect(estimate(revising(), 300)).toBeNull();
      });

      it('counts down its current step from the open run', () => {
        const job = revising();
        const runs = history(slowEdit, { [`${job.id}:4`]: secondsAfterT0(0) });
        const estimate = createEtaEstimator({ stepRuns: runs, clock: () => secondsAfterT0(10) });
        expect(estimate(job, 300)).toBe(20 + 3 * 30);
      });
    });

    describe('a render run', () => {
      it('uses its own three samples of Render', () => {
        const runs = history({ 8: [sample(120), sample(120), sample(120)] }, {}, [], {
          render: { perStep: { 8: 3 } },
        });
        const estimate = createEtaEstimator({ stepRuns: runs, clock: () => secondsAfterT0(0) });
        // Its own 6 s per minute, not the edit's 12.
        expect(estimate(rendering(), 300)).toBe(30);
        expect(runs.recentDurations).toHaveBeenCalledWith(8, ETA_SAMPLE_LIMIT, 'render');
      });

      it('else the edit run’s trusted rate for Render', () => {
        const estimate = createEtaEstimator({
          stepRuns: history({ 8: 3 }),
          clock: () => secondsAfterT0(0),
        });
        expect(estimate(rendering(), 300)).toBe(30);
      });

      it('else the slowest Render run the edit has', () => {
        const estimate = createEtaEstimator({
          stepRuns: history({ 8: [sample(60), sample(120)] }),
          clock: () => secondsAfterT0(0),
        });
        // 12 s per minute: 60 s for 5 minutes.
        expect(estimate(rendering(), 300)).toBe(60);
      });

      it('else nothing: a first render shows no figure', () => {
        const estimate = createEtaEstimator({
          stepRuns: history(),
          clock: () => secondsAfterT0(0),
        });
        expect(estimate(rendering(), 300)).toBeNull();
      });

      it('is not made 0 by an edit history whose newest jobs skipped Render', () => {
        // Review-era edits end at Check: none of the newest three ran step 8, so the edit's
        // fallback would call Render "skipped" and count it as nothing. A render run never does.
        const withoutRender: readonly StepId[] = [1, 2, 3, 4, 5, 6, 7];
        const estimate = createEtaEstimator({
          stepRuns: history({ ...everyStep(3), 8: 0 }, {}, [
            finished(withoutRender),
            finished(withoutRender),
            finished(withoutRender),
          ]),
          clock: () => secondsAfterT0(0),
          review: true,
        });
        expect(estimate(rendering(), 300)).toBeNull();
      });

      it('counts an even share of its own finished renders for too few samples', () => {
        // Three finished renders of 100 s over 10 minutes: 10 s per minute, all on step 8.
        const runs = history({}, {}, [], {
          render: {
            perStep: { 8: [sample(60)] },
            finished: [finished([8], 100), finished([8], 100), finished([8], 100)],
          },
        });
        const estimate = createEtaEstimator({ stepRuns: runs, clock: () => secondsAfterT0(0) });
        expect(estimate(rendering(), 300)).toBe(50);
      });

      it('ends at Render whatever the switch says', () => {
        const estimate = createEtaEstimator({
          stepRuns: history({ 8: 3 }),
          clock: () => secondsAfterT0(0),
          review: true,
        });
        expect(estimate(rendering(), 300)).toBe(30);
      });
    });

    it('asks for the finished runs of the job’s own kind, and only when a step needs them', () => {
      const trusted = history({}, {}, [], { revise: { perStep: { 4: 3, 5: 3, 6: 3, 7: 3 } } });
      createEtaEstimator({ stepRuns: trusted, clock: () => secondsAfterT0(0) })(revising(), 300);
      expect(trusted.recentFinishedRuns).not.toHaveBeenCalled();

      const thin = history({ ...slowEdit, 6: 1 });
      createEtaEstimator({ stepRuns: thin, clock: () => secondsAfterT0(0) })(editing(), 300);
      expect(thin.recentFinishedRuns.mock.calls).toEqual([['edit', ETA_SAMPLE_LIMIT]]);

      const thinRender = history({}, {}, [], { render: { perStep: { 8: 1 } } });
      createEtaEstimator({ stepRuns: thinRender, clock: () => secondsAfterT0(0) })(
        rendering(),
        300,
      );
      expect(thinRender.recentFinishedRuns.mock.calls).toEqual([['render', ETA_SAMPLE_LIMIT]]);
    });
  });
});

describe('the estimator on the job read model', () => {
  const opened: StudioDb[] = [];
  afterEach(() => {
    for (const db of opened.splice(0)) db.close();
  });

  /** `review` is the Review switch: on, an edit run ends at Check and only a render run is ready. */
  function setup({ review = false } = {}) {
    const clock = fakeClock();
    const db = memoryDb();
    opened.push(db);
    const runs = new StepRunRepository(db, { clock });
    const jobs = new JobRepository(db, {
      clock,
      estimateEtaSec: createEtaEstimator({ stepRuns: runs, clock, review }),
      review,
    });
    return { clock, db, runs, jobs };
  }

  /** Three finished jobs of 10 minutes of footage, 60 s in each of `steps`. */
  function pastJobs(
    { clock, runs, jobs }: ReturnType<typeof setup>,
    steps: readonly StepId[] = ALL_STEPS,
    count = 3,
  ) {
    for (let n = 0; n < count; n++) {
      const { job } = jobs.upsertFromScan(makeScan('Past', `Job ${n}`, { footageSec: 600 }));
      for (const step of steps) {
        runs.start(job.id, step);
        clock.tick(60_000);
        runs.end(job.id, step);
      }
    }
  }

  function startEditing(ctx: ReturnType<typeof setup>, step: StepId = 1) {
    const { job } = ctx.jobs.upsertFromScan(makeScan('Arc Fitness', 'Launch', { footageSec: 300 }));
    ctx.jobs.applyTransition(job.id, { type: 'SETTLED' });
    ctx.jobs.applyTransition(job.id, { type: 'START' });
    if (step !== 1) ctx.jobs.applyTransition(job.id, { type: 'PROGRESS', step, sub: null });
    ctx.runs.start(job.id, step);
    return job.id;
  }

  it('shows no ETA with no history, or with two runs of a step', () => {
    const ctx = setup();
    const id = startEditing(ctx);
    expect(ctx.jobs.get(id)?.etaSec).toBeNull();

    pastJobs(ctx, ALL_STEPS, 2);
    expect(ctx.jobs.get(id)?.etaSec).toBeNull();
  });

  it('shows the seconds left once every step has three runs, without touching updatedAt', () => {
    const ctx = setup();
    pastJobs(ctx);
    const id = startEditing(ctx, 4);
    const before = ctx.jobs.get(id);

    // 5 min of footage: 30 s per step; the open run of step 4 has not ticked yet.
    expect(before?.etaSec).toBe(150);
    ctx.clock.tick(10_000);
    const after = ctx.jobs.get(id);
    expect(after?.etaSec).toBe(140);
    expect(after?.updatedAt).toBe(before?.updatedAt);
    expect(ctx.jobs.getEditing().map((job) => job.etaSec)).toEqual([140]);
    expect(ctx.jobs.getAll().find((job) => job.id === id)?.etaSec).toBe(140);
  });

  it('shows nothing for a queued job', () => {
    const ctx = setup();
    pastJobs(ctx);
    const { job } = ctx.jobs.upsertFromScan(makeScan('Arc Fitness', 'Queued', { footageSec: 300 }));
    const queued = ctx.jobs.applyTransition(job.id, { type: 'SETTLED' });

    expect(queued.state).toBe('queued');
    expect(queued.etaSec).toBeNull();
  });

  it('ignores steps already done: the history of earlier ones is not needed', () => {
    const ctx = setup();
    pastJobs(ctx, [6, 7, 8]);
    const id = startEditing(ctx, 6);

    expect(ctx.jobs.get(id)?.etaSec).toBe(90);
  });

  it('shows nothing when the job has no footage', () => {
    const ctx = setup();
    pastJobs(ctx);
    const { job } = ctx.jobs.upsertFromScan(makeScan('Arc Fitness', 'Silent', { footageSec: 0 }));
    ctx.jobs.applyTransition(job.id, { type: 'SETTLED' });
    ctx.jobs.applyTransition(job.id, { type: 'START' });

    expect(ctx.jobs.get(job.id)?.etaSec).toBeNull();
  });

  /**
   * A job that edited through `timeline` ([step, seconds, 'closed' | 'open'] in order, an 'open'
   * run being one an interruption left without an end) and ended ready, on 10 minutes of footage.
   */
  function finishedJob(
    { clock, runs, jobs }: ReturnType<typeof setup>,
    name: string,
    timeline: readonly (readonly [StepId, number, 'closed' | 'open'])[],
  ) {
    const { job } = jobs.upsertFromScan(makeScan('Past', name, { footageSec: 600 }));
    jobs.applyTransition(job.id, { type: 'SETTLED' });
    jobs.applyTransition(job.id, { type: 'START' });
    for (const [step, seconds, kind] of timeline) {
      runs.start(job.id, step);
      clock.tick(seconds * 1000);
      if (kind === 'closed') runs.end(job.id, step);
    }
    jobs.applyTransition(job.id, { type: 'SUCCEED', output: OUTPUT });
    clock.tick(1000);
  }

  const OUTPUT: JobOutput = {
    fileName: 'Past/Job.mp4',
    durationSec: 30,
    width: 1920,
    height: 1080,
    sizeBytes: 1_000_000,
  };

  // The shape of the V4 acceptance run (CVP-79), as a migrated database holds it (CVP-99: the ids
  // moved up by one and there is no Brief run): three finished jobs whose restarts, Cancel and
  // failed export left runs open, so the closed samples per step were
  // Transcribe 2, Scan 3, Plan 3, Cut 1, Preview 3, Check 3, Render 2.
  // Per footage minute (10 min of footage): Scan 6, Plan 2 (median of 20, 10, 30 s), Preview 6,
  // Check 3 are trusted. Transcribe (30 s, 20 s) and Render (40 s, 80 s) have two runs and Cut one
  // (5 s): too few. A whole run is the sum of its closed steps (an open one is not timed, and
  // neither are the waits): 240, 260 and 185 s, so 24, 26 and 18.5 s per footage minute. The
  // median, 24, is shared among the seven steps that ran (Brief never did): 24 / 7 each.
  function v4History(ctx: ReturnType<typeof setup>) {
    finishedJob(ctx, 'Restarted mid-cut', [
      [2, 30, 'closed'],
      [3, 60, 'closed'],
      [4, 20, 'closed'],
      [5, 110, 'open'],
      [6, 60, 'closed'],
      [7, 30, 'closed'],
      [8, 40, 'closed'],
    ]);
    finishedJob(ctx, 'Killed mid-cut', [
      [2, 20, 'closed'],
      [3, 60, 'closed'],
      [4, 10, 'closed'],
      [5, 80, 'open'],
      [6, 60, 'closed'],
      [7, 30, 'closed'],
      [8, 80, 'closed'],
    ]);
    finishedJob(ctx, 'Cancelled, then export failed', [
      [2, 60, 'open'],
      [3, 60, 'closed'],
      [4, 30, 'closed'],
      [5, 5, 'closed'],
      [6, 60, 'closed'],
      [7, 30, 'closed'],
      [8, 115, 'open'],
    ]);
  }

  it('shows an ETA on the V4 history, where every step but one is short of runs or sparse', () => {
    const ctx = setup();
    v4History(ctx);
    expect(ctx.runs.recentDurations(2, 10, 'edit')).toHaveLength(2);
    expect(ctx.runs.recentDurations(5, 10, 'edit')).toHaveLength(1);
    expect(ctx.runs.recentDurations(8, 10, 'edit')).toHaveLength(2);

    const id = startEditing(ctx, 2);
    // 5 minutes of footage. Per minute: Transcribe 24/7 (share; its own best is 3), Scan 6,
    // Plan 2, Cut 24/7 (share), Preview 6, Check 3, Render 8 (its slowest run, above the share):
    // (48/7 + 25) x 5.
    const full = (48 / 7 + 25) * 5;
    expect(ctx.jobs.get(id)?.etaSec).toBeCloseTo(full, 6);

    // The count-down carries on through the fallback steps: 10 s into Transcribe.
    ctx.clock.tick(10_000);
    expect(ctx.jobs.get(id)?.etaSec).toBeCloseTo(full - 10, 6);
  });

  it('counts Brief as nothing on that history: the same estimate from Brief as from Transcribe', () => {
    const ctx = setup();
    v4History(ctx);
    expect(ctx.runs.recentDurations(1, 10, 'edit')).toEqual([]);

    const id = startEditing(ctx);
    expect(ctx.jobs.get(id)?.step).toBe(1);
    const full = (48 / 7 + 25) * 5;
    expect(ctx.jobs.get(id)?.etaSec).toBeCloseTo(full, 6);
    // Time spent in Brief takes nothing off: it was never part of the estimate.
    ctx.clock.tick(10_000);
    expect(ctx.jobs.get(id)?.etaSec).toBeCloseTo(full, 6);
  });

  it('shows an ETA on the V4 history when one step is skipped by every finished job', () => {
    const ctx = setup();
    // The V4 shape without Check (Check 0 runs). The whole runs are the sums of the closed
    // steps: 210, 230 and 155 s, so 21, 23 and 15.5 per footage minute. The median, 21, is shared
    // among the six steps that ran (Brief and Check did not): 3.5 each.
    finishedJob(ctx, 'A', [
      [2, 30, 'closed'],
      [3, 60, 'closed'],
      [4, 20, 'closed'],
      [5, 150, 'open'],
      [6, 60, 'closed'],
      [8, 40, 'closed'],
    ]);
    finishedJob(ctx, 'B', [
      [2, 20, 'closed'],
      [3, 60, 'closed'],
      [4, 10, 'closed'],
      [5, 120, 'open'],
      [6, 60, 'closed'],
      [8, 80, 'closed'],
    ]);
    finishedJob(ctx, 'C', [
      [2, 60, 'open'],
      [3, 60, 'closed'],
      [4, 30, 'closed'],
      [5, 5, 'closed'],
      [6, 60, 'closed'],
      [8, 155, 'open'],
    ]);
    expect(ctx.runs.recentDurations(7, 10, 'edit')).toEqual([]);

    const id = startEditing(ctx, 2);
    // Per minute: Transcribe 3.5, Scan 6, Plan 2, Cut 3.5, Preview 6, Check 0, Render 8: 29 x 5.
    expect(ctx.jobs.get(id)?.etaSec).toBe(145);
  });

  it('still shows nothing before three jobs have finished', () => {
    const ctx = setup();
    finishedJob(ctx, 'A', [[2, 30, 'closed']]);
    finishedJob(ctx, 'B', [[2, 30, 'closed']]);
    const id = startEditing(ctx);

    expect(ctx.jobs.get(id)?.etaSec).toBeNull();
  });

  it('does not use the open run of the job itself as a sample', () => {
    const ctx = setup();
    pastJobs(ctx, ALL_STEPS, 2);
    const id = startEditing(ctx);
    ctx.clock.tick(60_000);

    // Two finished runs of every step plus the job's own open run of step 1: still two.
    expect(ctx.jobs.get(id)?.etaSec).toBeNull();
  });

  // Phase 3: a ready job is a finished edit, a set of revise rounds and a render at once, and it
  // waited hours in Review between them. The estimate of the next job leaves those hours out.
  describe('jobs that went through Review', () => {
    const preview: JobEvent = { type: 'PREVIEW_READY', preview: SAMPLE_PREVIEW };
    const HOUR_MS = 3_600_000;

    function apply(ctx: ReturnType<typeof setup>, id: string, ...events: JobEvent[]) {
      for (const event of events) {
        ctx.clock.tick(1_000);
        ctx.jobs.applyTransition(id, event);
      }
    }

    function time(
      ctx: ReturnType<typeof setup>,
      id: string,
      kind: RunKind,
      step: StepId,
      seconds: number,
      { open = false } = {},
    ) {
      ctx.runs.start(id, step, kind);
      ctx.clock.tick(seconds * 1000);
      if (!open) ctx.runs.end(id, step);
    }

    /**
     * An edit of 10 minutes of footage (60 s a step; Scan was interrupted and left open), five
     * hours in Review, one revise round (30 s a step), three hours in Review, and the render.
     */
    function reviewedJob(ctx: ReturnType<typeof setup>, name: string) {
      const { job } = ctx.jobs.upsertFromScan(makeScan('Past', name, { footageSec: 600 }));
      apply(ctx, job.id, { type: 'SETTLED' }, { type: 'START' });
      for (const step of [1, 2, 4, 5, 6, 7] as const) time(ctx, job.id, 'edit', step, 60);
      time(ctx, job.id, 'edit', 3, 60, { open: true });
      apply(ctx, job.id, preview);
      ctx.clock.tick(5 * HOUR_MS);
      apply(ctx, job.id, { type: 'SEND_NOTES' }, { type: 'START' });
      for (const step of [4, 5, 6, 7] as const) time(ctx, job.id, 'revise', step, 30);
      apply(ctx, job.id, preview);
      ctx.clock.tick(3 * HOUR_MS);
      apply(ctx, job.id, { type: 'APPROVE' }, { type: 'START' });
      time(ctx, job.id, 'render', 8, 40);
      apply(ctx, job.id, { type: 'SUCCEED', output: OUTPUT });
    }

    it('does not make the next edit slow: the hours in Review are not in the fallback', () => {
      const ctx = setup({ review: true });
      for (const name of ['A', 'B', 'C']) reviewedJob(ctx, name);
      const id = startEditing(ctx, 2);

      // 5 minutes of footage, to Check. Steps 2, 4, 5, 6 and 7 are trusted (30 s each). Scan has
      // no closed run, so it is a share of the three edits' own time: 360 s over 10 minutes is 36
      // per minute, over the seven steps that ran (Render never did): 36 / 7 x 5.
      expect(ctx.jobs.get(id)?.etaSec).toBeCloseTo(5 * 30 + (36 / 7) * 5, 6);
    });

    it('estimates a revise run from the revise runs, step by step', () => {
      const ctx = setup({ review: true });
      for (const name of ['A', 'B', 'C']) reviewedJob(ctx, name);
      const id = startEditing(ctx);
      apply(ctx, id, preview, { type: 'SEND_NOTES' }, { type: 'START' });
      ctx.runs.start(id, 4, 'revise');

      expect(ctx.jobs.get(id)).toMatchObject({ state: 'editing', runKind: 'revise', step: 4 });
      // 5 minutes of footage. Plan to Check at 3 s per footage minute (30 s over 10 minutes): 15 s
      // each. The edit's 6 s per minute and its Render step are not part of it.
      expect(ctx.jobs.get(id)?.etaSec).toBe(4 * 15);
      ctx.clock.tick(10_000);
      expect(ctx.jobs.get(id)?.etaSec).toBe(4 * 15 - 10);
    });

    it('estimates a render run from the edit run’s Render until it has runs of its own', () => {
      const ctx = setup({ review: true });
      pastJobs(ctx);
      const id = startEditing(ctx);
      apply(ctx, id, preview, { type: 'APPROVE' }, { type: 'START' });
      ctx.runs.start(id, 8, 'render');

      expect(ctx.jobs.get(id)).toMatchObject({ state: 'editing', runKind: 'render', step: 8 });
      // The edit's Render took 60 s over 10 minutes: 30 s for 5 minutes.
      expect(ctx.jobs.get(id)?.etaSec).toBe(30);
    });

    it('estimates a render run from the renders of earlier jobs first', () => {
      const ctx = setup({ review: true });
      for (const name of ['A', 'B', 'C']) reviewedJob(ctx, name);
      const id = startEditing(ctx);
      apply(ctx, id, preview, { type: 'APPROVE' }, { type: 'START' });
      ctx.runs.start(id, 8, 'render');

      // The three earlier renders took 40 s over 10 minutes: 20 s for 5 minutes.
      expect(ctx.jobs.get(id)?.etaSec).toBe(20);
    });
  });
});

describe('createEtaTicker', () => {
  function setup(initial: Job[] = []) {
    const bus = createEventBus();
    const timers = new FakeIntervals();
    const state: { editing: Job[]; failure: Error | null } = { editing: initial, failure: null };
    const published: ServerEvent[] = [];
    bus.subscribe((event) => published.push(event));
    const onError = vi.fn();
    const ticker = createEtaTicker({
      bus,
      jobs: {
        getEditing: () => {
          if (state.failure !== null) throw state.failure;
          return state.editing;
        },
      },
      timers,
      onError,
    });
    return { bus, timers, state, published, onError, ticker };
  }
  const job = (overrides: Partial<Job> = {}) => makeJob({ state: 'editing', ...overrides });
  const upserts = (events: ServerEvent[]) =>
    events.flatMap((event) => (event.type === 'job.upsert' ? [event.job.etaSec] : []));

  it('ticks every 15 s once started, and not after it is stopped', () => {
    const { ticker, timers } = setup();
    expect(ETA_TICK_MS).toBe(15_000);
    expect(timers.active).toEqual([]);

    ticker.start();
    ticker.start();
    expect(timers.active).toEqual([15_000]);

    ticker.stop();
    ticker.stop();
    expect(timers.active).toEqual([]);
  });

  it('can be stopped without having been started', () => {
    const { ticker } = setup();
    expect(() => ticker.stop()).not.toThrow();
  });

  it('publishes an editing job whose ETA changed, and keeps quiet while it has not', () => {
    const { ticker, timers, state, published } = setup([job({ etaSec: 120 })]);
    ticker.start();

    timers.fire();
    expect(upserts(published)).toEqual([120]);
    timers.fire();
    expect(upserts(published)).toEqual([120]);

    state.editing = [job({ etaSec: 105 })];
    timers.fire();
    timers.fire();
    expect(upserts(published)).toEqual([120, 105]);
  });

  it('publishes the job as it was read, with its updatedAt untouched', () => {
    const current = job({ etaSec: 90, updatedAt: '2026-10-20T13:45:00.000Z' });
    const { ticker, timers, published } = setup([current]);
    ticker.start();

    timers.fire();

    expect(published).toEqual([{ type: 'job.upsert', job: current }]);
  });

  it('does not announce a job that has no estimate', () => {
    const { ticker, timers, state, published } = setup([job({ etaSec: null })]);
    ticker.start();
    timers.fire();
    expect(published).toEqual([]);

    // The estimate appears, then goes away again: both are news.
    state.editing = [job({ etaSec: 60 })];
    timers.fire();
    state.editing = [job({ etaSec: null })];
    timers.fire();
    expect(upserts(published)).toEqual([60, null]);
  });

  it('counts what the bus said about the job (a PROGRESS) as announced', () => {
    const { ticker, timers, state, published, bus } = setup([job({ etaSec: 200 })]);
    ticker.start();
    bus.publish({ type: 'job.upsert', job: job({ etaSec: 200 }) });
    published.length = 0;

    timers.fire();
    expect(published).toEqual([]);

    // The next PROGRESS moves the estimate; the tick that finds the same value stays quiet.
    state.editing = [job({ etaSec: 150 })];
    bus.publish({ type: 'job.upsert', job: job({ etaSec: 150 }) });
    published.length = 0;
    timers.fire();
    expect(published).toEqual([]);
  });

  it('forgets a job that stopped editing: when it edits again, its figure is news again', () => {
    const { ticker, timers, state, published, bus } = setup([job({ etaSec: 100 })]);
    ticker.start();
    timers.fire();
    expect(upserts(published)).toEqual([100]);

    // Cancelled, then retried and editing again with the same figure.
    state.editing = [];
    bus.publish({ type: 'job.upsert', job: job({ state: 'cancelled', etaSec: null }) });
    state.editing = [job({ etaSec: 100 })];
    published.length = 0;
    timers.fire();

    expect(upserts(published)).toEqual([100]);
  });

  it('forgets a removed job', () => {
    const { ticker, timers, published, bus } = setup([job({ etaSec: 100 })]);
    ticker.start();
    timers.fire();

    bus.publish({ type: 'job.remove', id: job().id });
    published.length = 0;
    timers.fire();

    expect(upserts(published)).toEqual([100]);
  });

  it('handles several editing jobs one by one', () => {
    const a = job({ id: 'aaaaaaaaaaaa', etaSec: 10 });
    const b = job({ id: 'bbbbbbbbbbbb', etaSec: 20 });
    const { ticker, timers, state, published } = setup([a, b]);
    ticker.start();

    timers.fire();
    state.editing = [a, { ...b, etaSec: 5 }];
    timers.fire();

    expect(
      published.map((event) =>
        event.type === 'job.upsert' ? [event.job.id, event.job.etaSec] : [],
      ),
    ).toEqual([
      ['aaaaaaaaaaaa', 10],
      ['bbbbbbbbbbbb', 20],
      ['bbbbbbbbbbbb', 5],
    ]);
  });

  it('reports a failing read and keeps ticking', () => {
    const { ticker, timers, state, published, onError } = setup([job({ etaSec: 30 })]);
    const boom = new Error('database is closed');
    state.failure = boom;
    ticker.start();

    expect(() => timers.fire()).not.toThrow();
    expect(onError).toHaveBeenCalledWith(boom);
    expect(published).toEqual([]);

    state.failure = null;
    timers.fire();
    expect(upserts(published)).toEqual([30]);
  });

  it('forgets everything when stopped: after a restart the current figure is announced once', () => {
    const { ticker, timers, published } = setup([job({ etaSec: 100 })]);
    ticker.start();
    timers.fire();
    ticker.stop();
    ticker.start();
    published.length = 0;

    timers.fire();
    timers.fire();

    expect(upserts(published)).toEqual([100]);
  });
});
