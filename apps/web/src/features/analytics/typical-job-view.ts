import {
  type AnalyticsStage,
  type AnalyticsTypicalJob,
  spanText,
  type TypicalJobKind,
} from '@studio/shared';
import { CHART_BLUE, CHART_GREEN, CHART_ORANGE } from './charts/chart-colors';

// What "A typical job, step by step" says and draws, worked out from the numbers (design canvas,
// board ANTypical, option J1): the whole job as a strip of four parts, the editor's steps as bars
// placed where each step falls in time, and a sentence under them. Pure: the card only lays it out.
//
// Times are medians in seconds and are said the way the board does and the tiles do (`spanText`:
// "45 s", "4 min", "2 h 52 m"). A change against the 30 days before is the difference of the whole
// minutes that are said, so a row never shows "3 min" next to "3 min" and a change.

/** The card says this instead of a chart until this many jobs finished in the last 30 days. */
export const MIN_JOBS_FOR_TYPICAL_JOB = 2;
export const NOT_ENOUGH_FINISHED_JOBS = 'Not enough finished jobs yet';

/** The colours of the board: the editor's blue, the slowest step's orange, grey, amber and green. */
export const TYPICAL_JOB_COLORS = {
  wait: '#71717A',
  editor: CHART_BLUE,
  you: '#c98500',
  render: CHART_GREEN,
  slowest: CHART_ORANGE,
} as const satisfies Record<TypicalJobKind | 'slowest', string>;

const MINUS = '−';
const APOSTROPHE = '’';
/** A wait shorter than this is not worth calling the biggest. */
const MIN_BIGGEST_WAIT_SEC = 60;
/** The steps of the time axis, in minutes: the first that gives six labels or fewer is used. */
const TICK_STEPS_MIN = [1, 2, 5, 10, 15, 20, 30, 60, 120, 180, 240, 360, 480, 720, 1440];
const MAX_TICK_STEPS = 5;

// --- saying a time -----------------------------------------------------------------------------

const wholeMinutes = (sec: number): number => Math.round(sec / 60);

/** A count of whole minutes in the words of `spanText`: "52 min", "2 h 52 m", "2 d 2 h". */
const minutesText = (minutes: number): string => spanText(minutes * 60);

// --- saying a change ---------------------------------------------------------------------------

/** How a change reads: `better` is shorter (green), `worse` longer (red), `same` and `none` are grey. */
export type ChangeTone = 'better' | 'worse' | 'same' | 'none';

export interface Change {
  text: string;
  tone: ChangeTone;
}

/** Whole minutes gained (negative) or lost (positive), as said on the board; `null` without both. */
function minuteChange(sec: number | null, beforeSec: number | null): number | null {
  if (sec === null || beforeSec === null) return null;
  return wholeMinutes(sec) - wholeMinutes(beforeSec);
}

/** "(25 min faster)", "(1 h 5 m slower)", "(same as before)"; `null` when there is nothing to compare with. */
export function headlineChange(sec: number | null, beforeSec: number | null): Change | null {
  const delta = minuteChange(sec, beforeSec);
  if (delta === null) return null;
  if (delta === 0) return { text: '(same as before)', tone: 'same' };
  const amount = minutesText(Math.abs(delta));
  return delta < 0
    ? { text: `(${amount} faster)`, tone: 'better' }
    : { text: `(${amount} slower)`, tone: 'worse' };
}

/**
 * The "vs before" cell of a step: "−1 min" (green), "+3 min" (red), "same" (grey). Nothing for a
 * step with no number now, and a dash for one with nothing to compare with.
 */
export function rowChange(sec: number | null, beforeSec: number | null): Change {
  if (sec === null) return { text: '', tone: 'none' };
  const delta = minuteChange(sec, beforeSec);
  if (delta === null) return { text: '—', tone: 'none' };
  if (delta === 0) return { text: 'same', tone: 'same' };
  return delta < 0
    ? { text: `${MINUS}${minutesText(-delta)}`, tone: 'better' }
    : { text: `+${minutesText(delta)}`, tone: 'worse' };
}

// --- the strip ---------------------------------------------------------------------------------

export interface StripPart {
  key: 'wait' | 'editor' | 'you' | 'render';
  label: string;
  sec: number;
  /** "4 min" */
  text: string;
  color: string;
  /** This part's share of the strip, from 0 to 100. */
  percent: number;
}

const EDITOR_PART_LABEL = 'The editor';

/** The four parts of the whole job, in the order they happen, leaving out one no job had. */
function stripParts(job: AnalyticsTypicalJob): StripPart[] {
  const stageOf = (kind: TypicalJobKind): AnalyticsStage | undefined =>
    job.stages.find((stage) => stage.kind === kind);
  const wanted: { key: StripPart['key']; label: string; sec: number | null }[] = [
    { key: 'wait', label: stageOf('wait')?.label ?? '', sec: stageOf('wait')?.medianSec ?? null },
    { key: 'editor', label: EDITOR_PART_LABEL, sec: job.editorSec },
    { key: 'you', label: stageOf('you')?.label ?? '', sec: stageOf('you')?.medianSec ?? null },
    {
      key: 'render',
      label: stageOf('render')?.label ?? '',
      sec: stageOf('render')?.medianSec ?? null,
    },
  ];
  const present = wanted.flatMap(({ key, label, sec }) =>
    label === '' || sec === null ? [] : [{ key, label, sec }],
  );
  const total = present.reduce((sum, part) => sum + part.sec, 0);
  return present.map(({ key, label, sec }) => ({
    key,
    label,
    sec,
    text: spanText(sec),
    color: TYPICAL_JOB_COLORS[key],
    percent: total > 0 ? (sec / total) * 100 : 100 / present.length,
  }));
}

// --- the steps ---------------------------------------------------------------------------------

export interface StepRow {
  key: string;
  label: string;
  /** "16 min"; a dash when no finished job had the step. */
  text: string;
  /** Where the bar starts and how long it is, from 0 to 100 of the axis; `null` without a number. */
  bar: { left: number; width: number } | null;
  slowest: boolean;
  change: Change;
}

export interface AxisTick {
  /** The minutes it says: "10". */
  label: string;
  /** From 0 to 100 of the axis. */
  left: number;
}

/** Where an axis of labels every `step` minutes ends for `totalMin` of steps: a little past the total. */
function axisEnd(totalMin: number, step: number): number {
  const round = step / 2;
  return Math.max(round, Math.ceil(totalMin / round) * round);
}

/**
 * The time axis for `totalSec` of steps: a label every 5 or 10 minutes (or whatever gives at most
 * six labels), and an end a little past the total, so the last bar does not touch the edge ("55"
 * for 52).
 */
export function timeAxis(totalSec: number): { maxSec: number; ticks: AxisTick[] } {
  const totalMin = totalSec / 60;
  const step =
    TICK_STEPS_MIN.find(
      (candidate) => axisEnd(totalMin, candidate) / candidate < MAX_TICK_STEPS + 1,
    ) ??
    TICK_STEPS_MIN[TICK_STEPS_MIN.length - 1] ??
    1440;
  const maxMin = axisEnd(totalMin, step);
  const ticks: AxisTick[] = [];
  for (let minute = 0; minute <= maxMin; minute += step) {
    ticks.push({ label: String(minute), left: (minute / maxMin) * 100 });
  }
  return { maxSec: maxMin * 60, ticks };
}

/**
 * What the steps section says the editor took: the medians of the steps it draws, added up (`now`),
 * and the same steps' medians for the 30 days before (`before`).
 *
 * This is deliberately not `job.editorSec`, the median of each job's whole editing time that the
 * strip and the Editing time tile use. Medians do not add up: a step with no end time (an old run
 * the engine never closed) is left out of that job's total but is a sample for its own step, so on
 * thin data the bars can add up to far more than that median. The heading over the bars has to
 * match the bars, so it is their sum. `null` when no step has a number. `before` is `null`, and so
 * is the change, unless the same steps have a number in both windows, since a sum over other steps
 * says nothing about being faster or slower.
 */
export function stepsTotals(job: Pick<AnalyticsTypicalJob, 'stages'>): {
  now: number | null;
  before: number | null;
} {
  const steps = job.stages.filter((stage) => stage.kind === 'editor');
  const sum = (pick: (stage: AnalyticsStage) => number | null): number | null => {
    const values = steps.flatMap((stage) => pick(stage) ?? []);
    return values.length === 0 ? null : values.reduce((total, value) => total + value, 0);
  };
  const sameSteps = steps.every(
    (stage) => (stage.medianSec === null) === (stage.beforeSec === null),
  );
  return {
    now: sum((stage) => stage.medianSec),
    before: sameSteps ? sum((stage) => stage.beforeSec) : null,
  };
}

/** The editor's steps from Brief to Check, each bar starting where the steps before it end. */
function stepRows(job: AnalyticsTypicalJob): { rows: StepRow[]; axis: AxisTick[] } {
  const steps = job.stages.filter((stage) => stage.kind === 'editor');
  const total = steps.reduce((sum, stage) => sum + (stage.medianSec ?? 0), 0);
  const { maxSec, ticks } = timeAxis(total);
  let elapsed = 0;
  const rows = steps.map((stage): StepRow => {
    const sec = stage.medianSec;
    const bar =
      sec === null || total <= 0
        ? null
        : { left: (elapsed / maxSec) * 100, width: (sec / maxSec) * 100 };
    elapsed += sec ?? 0;
    return {
      key: stage.key,
      label: stage.label,
      text: sec === null ? '—' : spanText(sec),
      bar,
      slowest: stage.key === job.slowestStepKey && sec !== null,
      change: rowChange(sec, stage.beforeSec),
    };
  });
  return { rows, axis: total > 0 ? ticks : [] };
}

// --- the sentence under the steps ---------------------------------------------------------------

/** "(was 22)" when both are minutes, else "(was 1 h 5 m)". */
function wasText(sec: number, beforeSec: number): string {
  const now = spanText(sec);
  const before = spanText(beforeSec);
  const bothMinutes = /^\d+ min$/.test(now) && /^\d+ min$/.test(before);
  return `(was ${bothMinutes ? before.replace(' min', '') : before})`;
}

/** "29 of the editor’s 52 min" / "1 h 5 m of the editor’s 1 h 40 m". */
function shareText(sec: number, editorSec: number): string {
  const part = spanText(sec);
  const whole = spanText(editorSec);
  const bothMinutes = /^\d+ min$/.test(part) && /^\d+ min$/.test(whole);
  return `${bothMinutes ? part.replace(' min', '') : part} of the editor${APOSTROPHE}s ${whole}`;
}

/** "Cut and Preview" */
function andText(labels: readonly string[]): string {
  return labels.join(' and ');
}

/**
 * The footer of the board: which step is the slowest (and what it was), how much of the editor's
 * time the two longest steps are, and which wait is the biggest. Every part is left out when the
 * numbers do not say it; `null` when nothing is left to say.
 */
function footerText(job: AnalyticsTypicalJob, stepsSec: number | null): string | null {
  const steps = job.stages
    .filter((stage) => stage.kind === 'editor' && stage.medianSec !== null)
    .sort((a, b) => (b.medianSec ?? 0) - (a.medianSec ?? 0));
  const sentences: string[] = [];

  const slowest = steps.find((stage) => stage.key === job.slowestStepKey);
  if (slowest !== undefined && slowest.medianSec !== null) {
    const was =
      slowest.beforeSec === null ? '' : ` ${wasText(slowest.medianSec, slowest.beforeSec)}`;
    sentences.push(
      `Orange is the slowest step: ${slowest.label}, ${spanText(slowest.medianSec)}${was}.`,
    );
  }

  const clauses: string[] = [];
  const [first, second] = steps;
  if (
    first?.medianSec != null &&
    second?.medianSec != null &&
    stepsSec !== null &&
    first.medianSec + second.medianSec <= stepsSec
  ) {
    // "of the editor's N min" is the total the heading over the steps says (see stepsTotals).
    const together = shareText(first.medianSec + second.medianSec, stepsSec);
    clauses.push(`${andText([first.label, second.label])} are ${together}`);
  }
  const biggest = job.stages
    .filter((stage) => (stage.kind === 'wait' || stage.kind === 'you') && stage.medianSec !== null)
    .sort((a, b) => (b.medianSec ?? 0) - (a.medianSec ?? 0))[0];
  if (biggest?.medianSec != null && biggest.medianSec >= MIN_BIGGEST_WAIT_SEC) {
    clauses.push(`the biggest wait is ${biggest.kind === 'you' ? 'you' : 'the queue'}`);
  }
  if (clauses.length > 0) {
    const text = clauses.join('; ');
    sentences.push(`${text.charAt(0).toUpperCase()}${text.slice(1)}.`);
  }
  return sentences.length === 0 ? null : sentences.join(' ');
}

// --- the card ----------------------------------------------------------------------------------

export interface TypicalJobView {
  /** "Whole job · 2 h 52 m" */
  whole: { text: string; change: Change | null };
  strip: StripPart[];
  /** "The editor’s 52 min, step by step": the total is the sum of the step bars. */
  editor: { text: string; change: Change | null };
  axis: AxisTick[];
  rows: StepRow[];
  footer: string | null;
}

/**
 * What the card shows, or `null` when too few jobs finished in the last 30 days for a median job
 * to mean anything (the card says so instead).
 */
export function typicalJobView(job: AnalyticsTypicalJob): TypicalJobView | null {
  if (job.jobsCounted < MIN_JOBS_FOR_TYPICAL_JOB || job.wholeSec === null) return null;
  const { rows, axis } = stepRows(job);
  const steps = stepsTotals(job);
  return {
    whole: {
      text: `Whole job · ${spanText(job.wholeSec)}`,
      change: headlineChange(job.wholeSec, job.wholeBeforeSec),
    },
    strip: stripParts(job),
    // The heading over the step bars is the sum of the bars (see stepsTotals); the strip keeps the
    // median job's own editing time.
    editor: {
      text:
        steps.now === null
          ? 'The editor, step by step'
          : `The editor${APOSTROPHE}s ${spanText(steps.now)}, step by step`,
      change: headlineChange(steps.now, steps.before),
    },
    axis,
    rows,
    footer: footerText(job, steps.now),
  };
}
