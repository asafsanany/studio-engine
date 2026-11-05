import {
  CHECK_STEP,
  firstStepOf,
  GENERATE_STEP_NAME,
  generateFailureOf,
  generateStageMark,
  generateStepText,
  generateStopPlace,
  type Job,
  type JobStepRun,
  RENDER_STEP,
  type ReviewNote,
  STEP_IDS,
  STEP_LABELS,
  type StepId,
} from '@studio/shared';

// What the job sheet's Steps section says, worked out from the job and its step runs (JS4). Pure:
// the clock and the time zone are parameters, so a test can fix them. Design: canvas page "Job
// sheet", boards JSSheet, JSStatesA and JSStatesB.

/** The words of the section. */
export const STEPS_TEXT = {
  heading: 'Steps',
  loadFailed: 'Couldn’t load the steps.',
  /** The ninth row, between Check and Render: the person's own part. */
  review: 'Your review',
  notStarted: 'not started',
  /** Render's text while an edit or a revise run is still working towards the review. */
  renderWaits: 'after you approve',
} as const;

/** What a row shows: its icon and its colours. */
export type StepRowKind =
  | 'done'
  | 'running'
  | 'failed'
  | 'stopped'
  | 'pending'
  /** "Your review" while the job waits for the person. */
  | 'waiting';

export interface StepRow {
  /**
   * The step number, `review` for "Your review" and `generate` for a generated job's Generate stage
   * (the two rows that are not steps).
   */
  key: StepId | 'review' | 'generate';
  /** The step's number; `null` for "Your review" and for Generate. */
  step: StepId | null;
  /**
   * The cut the row belongs to, numbered like a step run's `round`: 0 for the first cut, 1 for the
   * cut made from the first round of notes. Only a finished job lists more than one.
   */
  round: number;
  /**
   * A small sub-heading drawn above this row ("Round 2 · from Plan"): set on the first row of
   * each later round in a finished job's list, `null` everywhere else.
   */
  heading: string | null;
  kind: StepRowKind;
  name: string;
  /** The muted text on the right: "13:02 · 1 min", "now · 2 of 5", "failed 12:52", or "". */
  text: string;
}

export interface StepsView {
  /**
   * The muted label on the right of the heading: "not started", "started 14:30", "33 min of work",
   * "Round 2 · from Plan", or "". A finished job has none: its folded line says the rest, and its
   * rows name each later round themselves.
   */
  label: string;
  /**
   * The rows in order: the job's current round, or for a finished job its whole story (the first
   * cut, then each round of notes, with Render last).
   */
  rows: readonly StepRow[];
  /** A finished job's folded line ("All 8 steps done · 26 min of work"); `null` for any other job. */
  summary: string | null;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** A time older than this reads as a date ("12 Sep") rather than a clock time. */
export const RECENT_MS = 7 * DAY_MS;

// --- time ---------------------------------------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The wall-clock fields of an instant, in `timeZone` or the browser's zone. */
function fieldsOf(ms: number, timeZone: string | undefined) {
  const cacheKey = timeZone ?? '';
  let formatter = formatters.get(cacheKey);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23',
    });
    formatters.set(cacheKey, formatter);
  }
  const fields = { day: '', month: '', hour: 0, minute: 0 };
  for (const part of formatter.formatToParts(ms)) {
    if (part.type === 'day' || part.type === 'month') fields[part.type] = part.value;
    if (part.type === 'hour' || part.type === 'minute') fields[part.type] = Number(part.value);
  }
  return fields;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** "14:30" on the 24-hour clock; "" for a time that cannot be read. */
export function clockText(iso: string, timeZone?: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const { hour, minute } = fieldsOf(ms, timeZone);
  // Some engines report midnight as 24 even with hourCycle h23.
  return `${pad2(hour % 24)}:${pad2(minute)}`;
}

/** "12 Sep"; "" for a time that cannot be read. */
function dateText(iso: string, timeZone?: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const { day, month } = fieldsOf(ms, timeZone);
  return `${day} ${month}`;
}

/** A time the way a row says it: "14:30", or the date ("12 Sep") once it is over a week old. */
function whenText(iso: string, now: number, timeZone?: string): string {
  const ms = Date.parse(iso);
  if (Number.isFinite(ms) && now - ms > RECENT_MS) return dateText(iso, timeZone);
  return clockText(iso, timeZone);
}

/**
 * How long a step took: whole minutes, "<1 min" under a minute (also for a length that cannot be
 * worked out). Rounded to the nearest minute.
 */
export function minutesText(ms: number): string {
  if (!(ms >= MINUTE_MS)) return '<1 min';
  return `${Math.round(ms / MINUTE_MS)} min`;
}

/**
 * How long the job has waited for the person: "<1 min", "9 min", then "2 h" and "3 days" once it
 * is long. Rounded down, like the lists' "12 min ago".
 */
export function waitingText(ms: number): string {
  const minutes = Math.floor(ms / MINUTE_MS);
  if (!(minutes >= 1)) return '<1 min';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  const days = Math.floor(hours / 24);
  return days === 1 ? '1 day' : `${days} days`;
}

/** How long a finished run took, in ms. A run still open, or with unreadable times, counts 0. */
function lengthOf(run: JobStepRun): number {
  if (run.endedAt === null) return 0;
  const ms = Date.parse(run.endedAt) - Date.parse(run.startedAt);
  return ms > 0 ? ms : 0;
}

/** The latest end among the runs that ended; `undefined` when none did. */
function lastEnd(runs: readonly JobStepRun[]): string | undefined {
  let latest: string | undefined;
  for (const run of runs) {
    if (run.endedAt === null) continue;
    if (latest === undefined || Date.parse(run.endedAt) > Date.parse(latest)) latest = run.endedAt;
  }
  return latest;
}

/** The finished runs' lengths added up, exactly (rounded once, when it is written). */
function workMs(runs: readonly JobStepRun[]): number {
  return runs.reduce((total, run) => total + lengthOf(run), 0);
}

/** "33 min of work"; "" when nothing has finished yet. */
function workText(runs: readonly JobStepRun[]): string {
  const ms = workMs(runs);
  return ms > 0 ? `${minutesText(ms)} of work` : '';
}

// --- which runs ---------------------------------------------------------------------------------

/** The steps a round shows: all eight for the first, from Plan for a revise round. */
function stepsOfRound(round: number): readonly StepId[] {
  if (round === 0) return STEP_IDS;
  const first = firstStepOf('revise');
  return STEP_IDS.filter((step) => step >= first);
}

/**
 * The run each step is shown from: its latest one in the round. A step that was run again (a
 * retry) shows the new run, and a run that started before the previous step's own latest run is an
 * older attempt that a restart from an earlier step has left behind, so the step reads as not
 * started again.
 */
function currentRuns(roundRuns: readonly JobStepRun[], steps: readonly StepId[]) {
  const byStep = new Map<StepId, JobStepRun>();
  let floor = Number.NEGATIVE_INFINITY;
  for (const step of steps) {
    let latest: JobStepRun | undefined;
    for (const run of roundRuns) {
      if (run.step !== step) continue;
      const started = Date.parse(run.startedAt);
      if (started < floor) continue;
      if (latest === undefined || started >= Date.parse(latest.startedAt)) latest = run;
    }
    if (latest !== undefined) {
      byStep.set(step, latest);
      floor = Date.parse(latest.startedAt);
    }
  }
  return byStep;
}

// --- the section -------------------------------------------------------------------------------

export interface StepsOptions {
  /** The current time, as epoch milliseconds: for "waiting 9 min" and for which times read as dates. */
  now: number;
  /** An IANA zone for the clock times; the browser's own when omitted. */
  timeZone?: string;
  /**
   * The review notes that were sent (`useSentNotes`), for a finished job's "3 notes sent 17:10"
   * rows; `undefined` while they are not known, and those rows then say "notes sent" with the time
   * of the round's revise run.
   */
  notes?: readonly ReviewNote[];
}

/** "Round 2 · from Plan": a run's `round` counts the rounds of notes sent, so round 1 is the second cut. */
function roundLabel(round: number): string {
  return `Round ${round + 1} · from ${STEP_LABELS[firstStepOf('revise')]}`;
}

/** "All 8 steps done · 1 review round · 34 min of work": the whole job, every round. */
function summaryOf(
  job: Pick<Job, 'round'>,
  runs: readonly JobStepRun[],
  generated: boolean,
): string {
  // A generated job has the Generate stage among its rows: it counts in the line that folds them.
  const parts: string[] = [`All ${STEP_IDS.length + (generated ? 1 : 0)} steps done`];
  if (job.round > 0) parts.push(`${job.round} review ${job.round === 1 ? 'round' : 'rounds'}`);
  const work = workText(runs);
  if (work !== '') parts.push(work);
  return parts.join(' · ');
}

const join = (...parts: readonly string[]): string =>
  parts.filter((part) => part !== '').join(' · ');

/**
 * The count inside a running step as the boards say it: "graphics 2/5" is "2 of 5" ("Cut" already
 * says what is being counted), "6/14" is "6 of 14". Anything that is not a count is left as it is.
 */
export function countText(sub: string): string {
  return sub.replace(/(\d+)\s*\/\s*(\d+)/, '$1 of $2').replace(/^graphics /, '');
}

/** "1 note", "3 notes". */
const notesText = (count: number): string => `${count} ${count === 1 ? 'note' : 'notes'}`;

/**
 * The Steps section of a job: a heading label, the rows of the job's current round and, for a
 * finished job, the one line they fold into.
 *
 * - Round 0 lists Brief to Render; a revise round (`job.round` above 0) only its own runs, from
 *   Plan. "Your review" sits between Check and Render once the job has reached its review.
 * - A finished job tells the whole story in time order: the first cut (Brief to Check), "Your
 *   review" ("3 notes sent 17:10" when notes were sent, "approved 17:38" for the last round), then
 *   each later round under a sub-heading ("Round 2 · from Plan") with its own steps and "Your
 *   review", and Render last. A job with no rounds is the first cut and Render.
 * - Done: "14:30 · 1 min" (the clock only for a run in the last week). Running: "now · 2 of 5".
 *   Failed and stopped: "failed 12:52", "stopped 10:41". Not started: nothing, except that
 *   Render says "after you approve" while an edit or a revise run is working towards the review.
 * - An open run (`endedAt: null`) is running only while the job is `editing`: the worker leaves
 *   the step open when a job fails or is cancelled, and a crash can leave it open for good.
 * - The runs are sparse (the worker times only the steps the editing agent reports) and some stay
 *   open for good (an engine restart mid-run), so the rows are read by where the job got to, not by
 *   whether each step has a run (CVP-262):
 *   - a step with no run, before a step that did run in its round (or before the step the job is
 *     at, failed in or was stopped in), is done and untimed (a check, no time): the agent went
 *     past it without reporting it;
 *   - so is every step up to Check once the job has reached its review (waiting, approved or
 *     rendering): the round has been moved past;
 *   - an open run that is not the job's running step reads done with its start time and no length:
 *     one that a later step's run follows, or one in a round the job has moved past.
 *   Only the step the job really is editing (an open run with nothing after it) reads running.
 * - A failed or stopped step has no end time of its own, so "failed 12:52" is the job's last update.
 * - The minutes are the finished runs' exact lengths added up, so they can differ by a minute from
 *   the rows' rounded ones.
 */
export function buildSteps(
  job: Job,
  runs: readonly JobStepRun[],
  { now, timeZone, notes }: StepsOptions,
): StepsView {
  const roundRuns = runs.filter((run) => run.round === job.round);

  const finished = job.state === 'ready';
  const awaitingReview = job.state === 'review';
  // The job has been approved once it is on its render run (or past it): that run follows Approve.
  const approved =
    finished || job.runKind === 'render' || roundRuns.some((run) => run.runKind === 'render');
  const reachedReview = awaitingReview || approved;

  const when = (iso: string) => whenText(iso, now, timeZone);
  // Generated videos (GN9): the Generate stage sits between Brief and Transcribe of the first cut.
  const generateMark = generateStageMark(job);

  /** A clock time is worth showing for a run in the last week; an older one only has its length. */
  function recent(iso: string): boolean {
    const ms = Date.parse(iso);
    return !Number.isFinite(ms) || now - ms <= RECENT_MS;
  }

  function doneRow(step: StepId, round: number, run: JobStepRun | undefined): StepRow {
    // Only a run that ended has a length; a ready job's step with no run says nothing.
    const text =
      run === undefined
        ? ''
        : run.endedAt === null
          ? when(run.startedAt)
          : join(recent(run.startedAt) ? when(run.startedAt) : '', minutesText(lengthOf(run)));
    return { key: step, step, round, heading: null, kind: 'done', name: STEP_LABELS[step], text };
  }

  function stepRow(step: StepId, round: number, byStep: ReadonlyMap<StepId, JobStepRun>): StepRow {
    const run = byStep.get(step);
    const name = STEP_LABELS[step];
    const row = (kind: StepRowKind, text: string): StepRow => ({
      key: step,
      step,
      round,
      heading: null,
      kind,
      name,
      text,
    });
    const stoppedAt = `stopped ${when(job.updatedAt)}`;
    const failedAt = `failed ${when(job.updatedAt)}`;
    // The agent got past this step: a later step of the round has a run of its own.
    let gotPast = false;
    for (const other of byStep.keys()) if (other > step) gotPast = true;
    // The round is over for the steps up to Check once the job reached its review.
    const movedPast = reachedReview && step < RENDER_STEP;
    // The step the job is at, failed in or was stopped in has come after this one, even with no
    // run of its own to show it (the agent never reported it, or the run was cut by a restart).
    const stepOfJob =
      round !== job.round
        ? null
        : job.state === 'editing'
          ? job.step
          : job.state === 'failed'
            ? job.failedAt
            : job.state === 'cancelled'
              ? job.stoppedAt
              : null;
    const jobIsPast = stepOfJob !== null && stepOfJob > step;

    if (run !== undefined && run.endedAt !== null) return doneRow(step, round, run);

    if (run !== undefined) {
      // The step was left open, and nothing is running in it when the job is past the step.
      if (gotPast || movedPast) return doneRow(step, round, run);
      switch (job.state) {
        case 'editing': {
          const sub = job.step === step && job.subProgress !== null ? job.subProgress : '';
          return row('running', join('now', countText(sub)));
        }
        case 'failed':
          return row('failed', failedAt);
        case 'cancelled':
          return row('stopped', stoppedAt);
        case 'review':
        case 'ready':
          return doneRow(step, round, run);
        default:
          // Arriving, queued or held again: the run is the one a failure or a stop left behind.
          return row('pending', '');
      }
    }

    // A step with no run (yet).
    if (job.state === 'failed' && job.failedAt === step) return row('failed', failedAt);
    if (job.state === 'cancelled' && job.stoppedAt === step) return row('stopped', stoppedAt);
    if (finished || gotPast || movedPast || jobIsPast) return doneRow(step, round, undefined);
    const waitsForApproval =
      step === RENDER_STEP && job.state === 'editing' && job.runKind !== 'render';
    return row('pending', waitsForApproval ? STEPS_TEXT.renderWaits : '');
  }

  /**
   * "3 notes sent 17:10": the round's review ended with the notes that started the next round (a
   * run's `round` is the round of the notes it applies). The time is when the notes were sent, or
   * until they are known when the round's revise run started; without a count when the notes are
   * not known.
   */
  function sentRow(round: number): StepRow {
    const next = round + 1;
    const sent = (notes ?? []).filter((note) => note.round === next);
    const sentAts = sent.map((note) => note.sentAt).filter((at): at is string => at !== null);
    const starts = runs
      .filter((run) => run.runKind === 'revise' && run.round === next)
      .map((run) => run.startedAt);
    const earliest = (times: readonly string[]) =>
      times.reduce<string | undefined>(
        (first, time) =>
          first === undefined || Date.parse(time) < Date.parse(first) ? time : first,
        undefined,
      );
    const at = earliest(sentAts) ?? earliest(starts);
    const sentText = sent.length > 0 ? `${notesText(sent.length)} sent` : 'notes sent';
    const time = at === undefined ? '' : when(at);
    return {
      key: 'review',
      step: null,
      round,
      heading: null,
      kind: 'done',
      name: STEPS_TEXT.review,
      text: time === '' ? sentText : `${sentText} ${time}`,
    };
  }

  function reviewRow(round: number, thisRoundRuns: readonly JobStepRun[]): StepRow {
    // A finished job's earlier rounds ended in the notes that started the next one.
    if (finished && round < job.round) return sentRow(round);
    const row = (kind: StepRowKind, text: string): StepRow => ({
      key: 'review',
      step: null,
      round,
      heading: null,
      kind,
      name: STEPS_TEXT.review,
      text,
    });
    if (awaitingReview) {
      // It has waited since the round's last step ended.
      const ends = thisRoundRuns
        .map((run) => (run.endedAt === null ? Number.NaN : Date.parse(run.endedAt)))
        .filter(Number.isFinite);
      const since = ends.length > 0 ? Math.max(...ends) : Date.parse(job.updatedAt);
      return row('waiting', `waiting ${waitingText(now - since)}`);
    }
    const approvedAt =
      job.approvedAt ?? thisRoundRuns.find((run) => run.runKind === 'render')?.startedAt ?? null;
    return row('done', approvedAt === null ? 'approved' : `approved ${when(approvedAt)}`);
  }

  /**
   * The Generate stage's row (a generated job's first cut). The stage is not timed as a step: it
   * starts when the Brief ends and the edit's first run (Transcribe) ends it. So "14:01 · 31 min" is
   * read from those two; while it works "now · voice 3/7" (the voice) or "now · 18 min so far";
   * a stop says when and where: "stopped 14:21 · clips 4/6", "stopped 14:04 · before any clip".
   */
  function generateRow(mark: NonNullable<typeof generateMark>): StepRow {
    const row = (kind: StepRowKind, text: string): StepRow => ({
      key: 'generate',
      step: null,
      round: 0,
      heading: null,
      kind,
      name: GENERATE_STEP_NAME,
      text,
    });
    const first = runs.filter((run) => run.round === 0);
    const briefEnd = lastEnd(first.filter((run) => run.step === 1));
    const state = job.generate ?? null;
    switch (mark) {
      case 'running': {
        if (state === null) return row('running', 'now');
        const minutes =
          briefEnd === undefined ? 0 : Math.round((now - Date.parse(briefEnd)) / MINUTE_MS);
        return row('running', generateStepText(state, minutes >= 1 ? minutes : undefined));
      }
      case 'done': {
        if (briefEnd === undefined) return row('done', '');
        const next = first
          .filter((run) => run.step > 1 && Date.parse(run.startedAt) >= Date.parse(briefEnd))
          .map((run) => run.startedAt)
          .sort((a, b) => Date.parse(a) - Date.parse(b))[0];
        const length =
          next === undefined ? '' : minutesText(Date.parse(next) - Date.parse(briefEnd));
        return row('done', join(recent(briefEnd) ? when(briefEnd) : '', length));
      }
      case 'failed':
      case 'stopped': {
        const code = generateFailureOf(job)?.error?.code;
        const place = state === null ? '' : generateStopPlace(state, code);
        return row(
          mark === 'failed' ? 'failed' : 'stopped',
          join(`stopped ${when(job.updatedAt)}`, place),
        );
      }
      case 'pending':
        return row('pending', '');
    }
  }

  // A finished job lists every round, oldest first; any other job only the one it is on.
  const rounds = finished
    ? Array.from({ length: job.round + 1 }, (_, round) => round)
    : [job.round];
  const rows: StepRow[] = [];
  for (const round of rounds) {
    // Render follows the last round only, so it ends the list.
    const steps = stepsOfRound(round).filter((step) => round === job.round || step !== RENDER_STEP);
    const thisRoundRuns =
      round === job.round ? roundRuns : runs.filter((run) => run.round === round);
    const byStep = currentRuns(thisRoundRuns, steps);
    const group: StepRow[] = [];
    for (const step of steps) {
      group.push(stepRow(step, round, byStep));
      if (step === 1 && round === 0 && generateMark !== null) group.push(generateRow(generateMark));
      if (step === CHECK_STEP && reachedReview) group.push(reviewRow(round, thisRoundRuns));
    }
    const first = group[0];
    if (finished && round > 0 && first !== undefined)
      group[0] = { ...first, heading: roundLabel(round) };
    rows.push(...group);
  }

  function headingLabel(): string {
    // A finished job's folded line already says it, and its rows name each round themselves.
    if (finished) return '';
    if (job.round > 0) return roundLabel(job.round);
    if (runs.length === 0) {
      return job.state === 'arriving' || job.state === 'queued' || job.state === 'held'
        ? STEPS_TEXT.notStarted
        : '';
    }
    if (reachedReview) return workText(roundRuns);
    if (job.state === 'editing') {
      const starts = roundRuns.map((run) => Date.parse(run.startedAt)).filter(Number.isFinite);
      if (starts.length === 0) return '';
      return `started ${when(new Date(Math.min(...starts)).toISOString())}`;
    }
    return '';
  }

  return {
    label: headingLabel(),
    rows,
    summary: finished ? summaryOf(job, runs, generateMark !== null) : null,
  };
}
