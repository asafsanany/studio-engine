import {
  type AnalyticsTypicalJob,
  analyticsTypicalJobSchema,
  TYPICAL_JOB_STAGES,
} from '@studio/shared';
import { describe, expect, it } from 'vitest';
import {
  headlineChange,
  MIN_JOBS_FOR_TYPICAL_JOB,
  rowChange,
  stepsTotals,
  TYPICAL_JOB_COLORS,
  timeAxis,
  typicalJobView,
} from './typical-job-view';

const MIN = 60;

/** Minutes of each stage in the order of the contract: wait, Brief ... Check, you, render. */
type Minutes = readonly (number | null)[];

/** The numbers of board J1: a 2 h 52 m job, 52 min of it the editor, Cut the slowest step. */
const NOW_MIN: Minutes = [4, 2, 3, 4, 6, 16, 13, 8, 112, 4];
const BEFORE_MIN: Minutes = [5, 3, 3, 6, 9, 22, 18, 8, 150, 5];

const seconds = (minutes: number | null | undefined): number | null =>
  minutes === null || minutes === undefined ? null : minutes * MIN;

function typicalJob(
  overrides: Partial<AnalyticsTypicalJob> = {},
  now: Minutes = NOW_MIN,
  before: Minutes = BEFORE_MIN,
) {
  const answer: AnalyticsTypicalJob = {
    stages: TYPICAL_JOB_STAGES.map((stage, index) => ({
      ...stage,
      medianSec: seconds(now[index]),
      beforeSec: seconds(before[index]),
    })),
    editorSec: 52 * MIN,
    editorBeforeSec: 69 * MIN,
    wholeSec: (4 + 52 + 112 + 4) * MIN,
    wholeBeforeSec: 197 * MIN,
    slowestStepKey: 'cut',
    jobsCounted: 9,
    jobsCountedBefore: 8,
    ...overrides,
  };
  return analyticsTypicalJobSchema.parse(answer);
}

describe('headlineChange', () => {
  it('says faster in green when the time went down', () => {
    expect(headlineChange(172 * MIN, 197 * MIN)).toEqual({
      text: '(25 min faster)',
      tone: 'better',
    });
  });

  it('says slower in red when it went up', () => {
    expect(headlineChange(52 * MIN, 40 * MIN)).toEqual({ text: '(12 min slower)', tone: 'worse' });
  });

  it('says a change of an hour or more in hours', () => {
    expect(headlineChange(112 * MIN, 190 * MIN)?.text).toBe('(1 h 18 m faster)');
  });

  it('says same when the minutes that are said are the same', () => {
    expect(headlineChange(52 * MIN, 52 * MIN + 20)).toEqual({
      text: '(same as before)',
      tone: 'same',
    });
  });

  it('says nothing without a time to compare with', () => {
    expect(headlineChange(52 * MIN, null)).toBeNull();
    expect(headlineChange(null, 52 * MIN)).toBeNull();
  });
});

describe('rowChange', () => {
  it('writes a drop with a minus sign (U+2212), in green', () => {
    expect(rowChange(2 * MIN, 3 * MIN)).toEqual({ text: '−1 min', tone: 'better' });
  });

  it('writes a rise with a plus, in red', () => {
    expect(rowChange(16 * MIN, 12 * MIN)).toEqual({ text: '+4 min', tone: 'worse' });
  });

  it('writes same, grey, for the same minutes', () => {
    expect(rowChange(3 * MIN, 3 * MIN)).toEqual({ text: 'same', tone: 'same' });
    expect(rowChange(3 * MIN + 10, 3 * MIN - 10)).toEqual({ text: 'same', tone: 'same' });
  });

  it('compares the minutes that are said, so "<1 min" against "4 min" is a drop of 4', () => {
    expect(rowChange(10, 4 * MIN)).toEqual({ text: '−4 min', tone: 'better' });
  });

  it('writes a dash for a step with nothing to compare with, and nothing for a step with no time', () => {
    expect(rowChange(3 * MIN, null)).toEqual({ text: '—', tone: 'none' });
    expect(rowChange(null, 3 * MIN)).toEqual({ text: '', tone: 'none' });
  });
});

describe('timeAxis', () => {
  it('labels every 10 minutes for 52 minutes and ends at 55, as on the board', () => {
    const { maxSec, ticks } = timeAxis(52 * MIN);
    expect(maxSec).toBe(55 * MIN);
    expect(ticks.map((tick) => tick.label)).toEqual(['0', '10', '20', '30', '40', '50']);
    expect(ticks.map((tick) => tick.left.toFixed(2))).toEqual([
      '0.00',
      '18.18',
      '36.36',
      '54.55',
      '72.73',
      '90.91',
    ]);
  });

  it('uses a smaller step for a short edit and a bigger one for a long edit', () => {
    expect(timeAxis(12 * MIN).ticks.map((tick) => tick.label)).toEqual(['0', '5', '10']);
    expect(timeAxis(95 * MIN).ticks.map((tick) => tick.label)).toEqual([
      '0',
      '20',
      '40',
      '60',
      '80',
      '100',
    ]);
    expect(timeAxis(5 * 3600).ticks.length).toBeLessThanOrEqual(6);
  });

  it('always ends past the total, and never has more than six labels', () => {
    for (const minutes of [0.3, 1, 3, 7, 24, 52, 60, 61, 119, 240, 600, 2000]) {
      const { maxSec, ticks } = timeAxis(minutes * MIN);
      expect(maxSec).toBeGreaterThanOrEqual(minutes * MIN);
      expect(ticks.length).toBeLessThanOrEqual(6);
      expect(ticks[0]?.left).toBe(0);
      expect(ticks.every((tick) => tick.left <= 100)).toBe(true);
    }
  });
});

describe('typicalJobView for the numbers of board J1', () => {
  const view = typicalJobView(typicalJob());

  it('says the whole job and how it changed', () => {
    expect(view?.whole.text).toBe('Whole job · 2 h 52 m');
    expect(view?.whole.change).toEqual({ text: '(25 min faster)', tone: 'better' });
  });

  it('cuts the whole job into the four parts, grey, blue, amber and green, in order', () => {
    expect(view?.strip.map((part) => [part.label, part.text, part.color])).toEqual([
      ['Waiting to start', '4 min', '#71717A'],
      ['The editor', '52 min', '#3987e5'],
      ['Waiting for you', '1 h 52 m', '#c98500'],
      ['Render', '4 min', '#199e70'],
    ]);
    expect(view?.strip.map((part) => part.percent.toFixed(3))).toEqual([
      '2.326',
      '30.233',
      '65.116',
      '2.326',
    ]);
    expect(TYPICAL_JOB_COLORS).toMatchObject({ slowest: '#d95926', editor: '#3987e5' });
  });

  it('says the editor total and its change', () => {
    expect(view?.editor.text).toBe('The editor’s 52 min, step by step');
    expect(view?.editor.change).toEqual({ text: '(17 min faster)', tone: 'better' });
  });

  it('has a row per editor step, Brief to Check, with the typical time', () => {
    expect(view?.rows.map((row) => [row.label, row.text])).toEqual([
      ['Brief', '2 min'],
      ['Transcribe', '3 min'],
      ['Scan', '4 min'],
      ['Plan', '6 min'],
      ['Cut', '16 min'],
      ['Preview', '13 min'],
      ['Check', '8 min'],
    ]);
  });

  it('places each bar where the step falls in time, on an axis that ends at 55 min', () => {
    expect(view?.rows.map((row) => [row.bar?.left.toFixed(2), row.bar?.width.toFixed(2)])).toEqual([
      ['0.00', '3.64'],
      ['3.64', '5.45'],
      ['9.09', '7.27'],
      ['16.36', '10.91'],
      ['27.27', '29.09'],
      ['56.36', '23.64'],
      ['80.00', '14.55'],
    ]);
    expect(view?.axis.map((tick) => tick.label)).toEqual(['0', '10', '20', '30', '40', '50']);
  });

  it('marks the slowest step only, and says each change against before', () => {
    expect(view?.rows.filter((row) => row.slowest).map((row) => row.label)).toEqual(['Cut']);
    expect(view?.rows.map((row) => row.change.text)).toEqual([
      '−1 min',
      'same',
      '−2 min',
      '−3 min',
      '−6 min',
      '−5 min',
      'same',
    ]);
  });

  it('says the footer of the board, word for word', () => {
    expect(view?.footer).toBe(
      'Orange is the slowest step: Cut, 16 min (was 22). Cut and Preview are 29 of the editor’s 52 min; the biggest wait is you.',
    );
  });
});

describe('typicalJobView when there is not much to show', () => {
  it('is null below two finished jobs', () => {
    expect(MIN_JOBS_FOR_TYPICAL_JOB).toBe(2);
    expect(typicalJobView(typicalJob({ jobsCounted: 1 }))).toBeNull();
    expect(typicalJobView(typicalJob({ jobsCounted: 0 }))).toBeNull();
    expect(typicalJobView(typicalJob({ jobsCounted: 2 }))).not.toBeNull();
  });

  it('is null when the whole job cannot be told', () => {
    expect(typicalJobView(typicalJob({ wholeSec: null }))).toBeNull();
  });

  it('says no change anywhere when no job finished in the 30 days before', () => {
    const none = Array.from({ length: 10 }, () => null);
    const view = typicalJobView(
      typicalJob(
        { editorBeforeSec: null, wholeBeforeSec: null, jobsCountedBefore: 0 },
        NOW_MIN,
        none,
      ),
    );
    expect(view?.whole.change).toBeNull();
    expect(view?.editor.change).toBeNull();
    expect(view?.rows.every((row) => row.change.text === '—')).toBe(true);
    expect(view?.footer).toBe(
      'Orange is the slowest step: Cut, 16 min. Cut and Preview are 29 of the editor’s 52 min; the biggest wait is you.',
    );
  });

  it('leaves a part out of the strip when no job had it', () => {
    const now: Minutes = [4, 2, 3, 4, 6, 16, 13, 8, null, null];
    const view = typicalJobView(typicalJob({}, now));
    expect(view?.strip.map((part) => part.label)).toEqual(['Waiting to start', 'The editor']);
    expect(view?.strip.reduce((sum, part) => sum + part.percent, 0)).toBeCloseTo(100);
  });

  it('draws no bar for a step no job had, and moves on from where the last one ended', () => {
    const now: Minutes = [4, 2, 3, null, 6, 16, 13, 8, 112, 4];
    const rows = typicalJobView(typicalJob({}, now))?.rows;
    const scan = rows?.find((row) => row.label === 'Scan');
    expect(scan).toMatchObject({ text: '—', bar: null, slowest: false });
    expect(scan?.change.text).toBe('');
    const plan = rows?.find((row) => row.label === 'Plan');
    // Plan comes straight after Transcribe, 2 + 3 = 5 minutes in, on an axis that ends at 50.
    expect(plan?.bar?.left).toBeCloseTo((5 / 50) * 100);
  });

  it('does not mark a step when the answer names none', () => {
    const view = typicalJobView(typicalJob({ slowestStepKey: null }));
    expect(view?.rows.some((row) => row.slowest)).toBe(false);
    expect(view?.footer).toBe(
      'Cut and Preview are 29 of the editor’s 52 min; the biggest wait is you.',
    );
  });

  it('says the queue when waiting to start is the biggest wait', () => {
    const now: Minutes = [90, 2, 3, 4, 6, 16, 13, 8, 12, 4];
    const view = typicalJobView(typicalJob({}, now));
    expect(view?.footer).toContain('the biggest wait is the queue.');
  });

  it('does not call a wait under a minute the biggest', () => {
    const now: Minutes = [0.5, 2, 3, 4, 6, 16, 13, 8, 0.2, 4];
    expect(typicalJobView(typicalJob({}, now))?.footer).not.toContain('biggest wait');
  });

  it('reads the share from the sum of the step bars, not from the median job', () => {
    // Thin data: the median job's editing time (20 min) is far under what the bars add up to.
    const view = typicalJobView(typicalJob({ editorSec: 20 * MIN }));
    expect(view?.footer).toBe(
      'Orange is the slowest step: Cut, 16 min (was 22). Cut and Preview are 29 of the editor’s 52 min; the biggest wait is you.',
    );
  });

  it('says no footer when it has nothing to say', () => {
    const empty = Array.from({ length: 10 }, () => null);
    const view = typicalJobView(
      typicalJob({ editorSec: null, slowestStepKey: null }, empty, empty),
    );
    expect(view?.footer).toBeNull();
    expect(view?.editor.text).toBe('The editor, step by step');
    expect(view?.axis).toEqual([]);
    expect(view?.rows.every((row) => row.bar === null)).toBe(true);
  });

  it('says hours when the numbers are long', () => {
    const now: Minutes = [30, 10, 10, 10, 20, 70, 40, 20, 3000, 10];
    const before: Minutes = [30, 10, 10, 10, 20, 90, 40, 20, 3000, 10];
    const view = typicalJobView(typicalJob({ editorSec: 180 * MIN }, now, before));
    expect(view?.footer).toBe(
      'Orange is the slowest step: Cut, 1 h 10 m (was 1 h 30 m). Cut and Preview are 1 h 50 m of the editor’s 3 h; the biggest wait is you.',
    );
    expect(view?.strip.find((part) => part.key === 'you')?.text).toBe('2 d 2 h');
  });
});

describe('the editor heading over the steps', () => {
  it('is the sum of the step medians it draws, whatever the median job took', () => {
    // Old step runs were never closed: the median job has 3 min of timed editing, the bars add up to 52.
    const view = typicalJobView(typicalJob({ editorSec: 3 * MIN, editorBeforeSec: 2 * MIN }));
    expect(view?.editor.text).toBe('The editor’s 52 min, step by step');
    expect(view?.editor.change).toEqual({ text: '(17 min faster)', tone: 'better' });
    // The whole-job strip keeps the median job's own editing time.
    expect(view?.strip.find((part) => part.key === 'editor')?.sec).toBe(3 * MIN);
  });

  it('says a step under a minute in seconds, like the tiles', () => {
    const now: Minutes = [4, 0.5, 3, 4, 6, 16, 13, 8, 112, 4];
    const view = typicalJobView(typicalJob({}, now));
    expect(view?.rows[0]?.text).toBe('30 s');
  });
});

describe('stepsTotals', () => {
  const stage = (medianSec: number | null, beforeSec: number | null) => ({
    key: 'brief',
    label: 'Brief',
    kind: 'editor' as const,
    medianSec,
    beforeSec,
  });
  const job = (stages: ReturnType<typeof stage>[]) =>
    ({ stages }) as unknown as Pick<AnalyticsTypicalJob, 'stages'>;

  it('adds up the steps that have a number, now and before', () => {
    expect(stepsTotals(job([stage(120, 180), stage(300, 360)]))).toEqual({
      now: 420,
      before: 540,
    });
  });

  it('ignores the waits and the render', () => {
    expect(stepsTotals(typicalJob())).toEqual({ now: 52 * MIN, before: 69 * MIN });
  });

  it('has no total for no step, and no before total unless the same steps are in both windows', () => {
    expect(stepsTotals(job([stage(null, null), stage(null, null)]))).toEqual({
      now: null,
      before: null,
    });
    expect(stepsTotals(job([stage(120, 180), stage(300, null)]))).toEqual({
      now: 420,
      before: null,
    });
    expect(stepsTotals(job([stage(120, 180), stage(null, 300)]))).toEqual({
      now: 120,
      before: null,
    });
  });
});
