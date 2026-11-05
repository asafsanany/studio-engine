// What the phone job sheet says about a job above its menu (boards MJobSheet*, canvas page Mobile):
// the pill and the line next to it, the step segments with the line under them, and the button of
// the next step. Pure: the clock and the job list are parameters, so a test pins them. The words
// come from the same places the Mac's sheet and list read them (`sheetStatus`, `statusDetail`,
// `deliveryDetail`, `nextStepAction`); this file only chooses and orders them for a narrow screen.

import {
  clock,
  editingDetail,
  GENERATE_STEP_NAME,
  generateBarRight,
  generateFailureOf,
  generateStageMark,
  isGeneratingNow,
  type Job,
  relativeTime,
  resolution,
  STEP_IDS,
  STEP_LABELS,
  type StepId,
  statusDetail,
  stepLabel,
  type TimeInput,
} from '@studio/shared';
import { sheetStatus } from '@/features/job-sheet/job-sheet-status';
import { jobAhead } from '@/features/job-sheet/sheet-now';
import { type NextStepAction, nextStepAction } from '@/features/jobs/cells/row-actions';
import {
  archivedDay,
  deliveredDay,
  deliveredToday,
  deliveryMoneyDetail,
  TODAY_TEXT,
} from '@/features/jobs/delivery-text';

const SEPARATOR = ' · ';

const joinParts = (parts: readonly (string | null | undefined)[]): string =>
  parts
    .filter((part): part is string => part !== null && part !== undefined && part !== '')
    .join(SEPARATOR);

// --- the pill -----------------------------------------------------------------------------------

/** How the pill is drawn: red for a failure, amber for a hold, muted once the job is paid. */
export type PhonePillTone = 'default' | 'amber' | 'red' | 'muted';

export interface PhonePill {
  /** "Queued · #1 in line", "Failed at Render", "Editing", "Held". */
  label: string;
  /** The dot's background colour (a utility class, so Tailwind finds it). */
  dot: string;
  tone: PhonePillTone;
}

/**
 * The status pill of the sheet: the Mac header's badge (`sheetStatus`: its word and its dot), with
 * what the boards add to the word where the job has it: the place in line for a queued job, the
 * step a failed or stopped one stopped at.
 */
export function phonePill(job: Job): PhonePill {
  const status = sheetStatus(job);
  const tone: PhonePillTone =
    job.state === 'failed'
      ? 'red'
      : job.state === 'held'
        ? 'amber'
        : status.label === 'Paid'
          ? 'muted'
          : 'default';
  let label = status.label;
  if (job.state === 'queued' && job.placeInLine !== null) {
    label = `Queued${SEPARATOR}#${job.placeInLine} in line`;
  } else if (job.state === 'failed' && job.failedAt !== null) {
    // A job that stopped in Generate (Generated videos) says so, not "Failed at Brief".
    label =
      generateFailureOf(job) === null
        ? `Failed at ${STEP_LABELS[job.failedAt]}`
        : `Failed at ${GENERATE_STEP_NAME}`;
  } else if (job.state === 'cancelled' && job.stoppedAt !== null) {
    label =
      generateStageMark(job) === 'stopped'
        ? `Cancelled at ${GENERATE_STEP_NAME}`
        : `Cancelled at ${STEP_LABELS[job.stoppedAt]}`;
  }
  return { label, dot: status.dot, tone };
}

// --- the line next to it -------------------------------------------------------------------------

/**
 * The muted line next to the pill, by state (boards): an arriving job's settle timer, "Starts after
 * <the job ahead>" for a queued one, how long ago a held, failed or stopped job last changed, the
 * time left of an edit, the length and frame size of a cut in review (and its round), and for a
 * ready job its delivery line ("Delivered 21 Oct · ₪40 not paid", "Today · ₪40 not paid" for one
 * delivered today, as the board's Delivered sheet has it, "Paid 23 Oct · ₪40") or its length, frame
 * size and file size. An archived job adds when. `timeZone` pins the zone of the
 * days (tests); the browser's own by default.
 */
export function phoneMeta(
  job: Job,
  jobs: readonly Job[],
  now: TimeInput,
  timeZone?: string,
): string {
  const archived =
    job.archivedAt === null ? '' : `Archived ${archivedDay(job.archivedAt, timeZone)}`;
  switch (job.state) {
    case 'arriving':
      return statusDetail(job, now);
    case 'queued': {
      const ahead = jobAhead(job, jobs);
      return ahead === null ? 'Starts next' : `Starts after ${ahead.name}`;
    }
    case 'held':
    case 'failed':
    case 'cancelled':
      return relativeTime(job.updatedAt, now, timeZone);
    case 'editing':
      // The stage works on its own money: "$1.65 of $3" from the clips on (no time left to say).
      return isGeneratingNow(job) && job.generate != null
        ? generateBarRight(job.generate)
        : editingDetail(job);
    case 'review': {
      const { preview } = job;
      const round = sheetStatus(job).round;
      if (preview === null) return round ?? '';
      return joinParts([
        clock(preview.durationSec),
        resolution(preview.width, preview.height),
        round,
      ]);
    }
    case 'ready':
      return joinParts([deliveredLine(job, now, timeZone) ?? statusDetail(job, now), archived]);
  }
}

/**
 * The delivery line of a ready job, with "Delivered <day>" said as "Today" for a video delivered
 * today and not paid yet (board MJobSheetDelivered: the pill already says Delivered).
 */
function deliveredLine(job: Job, now: TimeInput, timeZone?: string): string | null {
  const line = deliveryMoneyDetail(job, timeZone);
  const { delivery } = job;
  if (line === null || delivery === null || delivery.paidOn != null) return line;
  if (!deliveredToday(delivery, now, timeZone)) return line;
  return line.replace(`Delivered ${deliveredDay(delivery, timeZone)}`, TODAY_TEXT);
}

// --- the segments ---------------------------------------------------------------------------------

/** How the segment after the finished ones is drawn: running (a lighter blue), failed (red) or stopped (grey). */
export type PhoneStepMark = 'running' | 'failed' | 'stopped';

export interface PhoneSteps {
  /** How many segments there are when it is not eight: nine for a generated job (Generate is one more). */
  total?: number;
  /** How many of them are done: the first `done` segments are solid. */
  done: number;
  /** The segment at index `done`, when the job is on it or stopped at it; `null` for none. */
  mark: PhoneStepMark | null;
  /** The line under the segments: "Cut · graphics 2/5 · step 5 of 8", "7 of 8 done, stopped at Render". */
  text: string;
}

const TOTAL = STEP_IDS.length;

/** "7 of 8 done, stopped at Render". */
function stoppedText(step: StepId, word: string): string {
  return `${step - 1} of ${TOTAL} done, ${word} at ${STEP_LABELS[step]}`;
}

/**
 * The segments of a generated job (Generated videos): Generate is a segment of its own between
 * Brief and Transcribe, so there are nine and the steps after Brief count one more ("Cut · graphics
 * 2/5 · step 6 of 9"). `null` for a job that is not generated.
 */
function generatedSteps(job: Job): PhoneSteps | null {
  const mark = generateStageMark(job);
  if (mark === null) return null;
  const total = TOTAL + 1;
  /** The segments before the one a stop or a run is at: Brief, Generate, then each step after. */
  const doneBefore = (step: StepId): number => (step === 1 ? 0 : step);
  switch (job.state) {
    case 'editing': {
      if (job.step === null) return { total, done: 0, mark: 'running', text: 'Starting the edit' };
      if (mark === 'running') {
        return {
          total,
          done: 1,
          mark: 'running',
          // The engine writes the stage's own words into the progress: "Generate · voice 3/7".
          text: joinParts([job.subProgress ?? GENERATE_STEP_NAME, `step 2 of ${total}`]),
        };
      }
      const at = doneBefore(job.step);
      return {
        total,
        done: at,
        mark: 'running',
        text: joinParts([stepLabel(job), `step ${at + 1} of ${total}`]),
      };
    }
    case 'failed':
    case 'cancelled': {
      const step = job.state === 'failed' ? job.failedAt : job.stoppedAt;
      if (step === null) return null;
      const stoppedInGenerate = mark === 'failed' || mark === 'stopped';
      const done = stoppedInGenerate ? 1 : doneBefore(step);
      const name = stoppedInGenerate ? GENERATE_STEP_NAME : STEP_LABELS[step];
      return {
        total,
        done,
        mark: job.state === 'failed' ? 'failed' : 'stopped',
        text: `${done} of ${total} done, stopped at ${name}`,
      };
    }
    default:
      return null;
  }
}

/**
 * The eight step segments and their line. An editing job is on its step (the render run is on the
 * last); a failed or stopped one shows how far it got and where it stopped. A job in no run (queued,
 * held, in review, ready) has none, as on the boards, and so does one that failed or stopped
 * without naming a step.
 */
export function phoneSteps(job: Job): PhoneSteps | null {
  const generated = generatedSteps(job);
  if (generated !== null) return generated;
  switch (job.state) {
    case 'editing': {
      if (job.step === null) return { done: 0, mark: 'running', text: 'Starting the edit' };
      return {
        done: job.step - 1,
        mark: 'running',
        text: joinParts([stepLabel(job), `step ${job.step} of ${TOTAL}`]),
      };
    }
    case 'failed':
      return job.failedAt === null
        ? null
        : { done: job.failedAt - 1, mark: 'failed', text: stoppedText(job.failedAt, 'stopped') };
    case 'cancelled':
      return job.stoppedAt === null
        ? null
        : { done: job.stoppedAt - 1, mark: 'stopped', text: stoppedText(job.stoppedAt, 'stopped') };
    default:
      return null;
  }
}

/** One of the segments with the colour class it is drawn in. `id` is its place, from 1. */
export interface PhoneSegment {
  id: number;
  className: string;
}

/** The segments (eight, nine for a generated job), in order: solid when done, lighter when running, red when failed, grey when stopped. */
export function segmentClasses(steps: PhoneSteps): PhoneSegment[] {
  return Array.from({ length: steps.total ?? TOTAL }, (_, index) => {
    const id = index + 1;
    let className = 'bg-muted';
    if (index < steps.done) className = 'bg-status-editing';
    else if (index === steps.done && steps.mark === 'running') className = 'bg-status-editing/45';
    else if (index === steps.done && steps.mark === 'failed') className = 'bg-status-failed';
    else if (index === steps.done && steps.mark === 'stopped') className = 'bg-zinc-500';
    return { id, className };
  });
}

// --- the next step --------------------------------------------------------------------------------

/**
 * Share video (Mobile 4): an Approved job's next step on the phone, in place of the Mac's Mark
 * delivered. The video goes to the client from the phone's share sheet, and the sheet then asks
 * whether it was sent (share-video.ts). Mark delivered stays in the sheet's list.
 */
export interface ShareStep {
  kind: 'share';
  label: 'Share video';
}

export const SHARE_STEP: ShareStep = { kind: 'share', label: 'Share video' };

/** The phone's next step: the Mac's, with Share video in place of Mark delivered. */
export type PhoneNextStep = NextStepAction | ShareStep;

/**
 * The one big button, and the row's icon: the Mac's next step (`nextStepAction`: Start now,
 * Release, Resume, Retry from Render, Review, Mark paid…), with Share video for an Approved job
 * instead of Mark delivered. Review opens the phone Review.
 */
export function phoneNextStep(job: Job, admin = true): PhoneNextStep | null {
  // An Approved job is shared by whoever looks (an editor sends it on); Mark delivered is the admin's.
  if (nextStepAction(job)?.kind === 'deliver') return SHARE_STEP;
  return nextStepAction(job, admin);
}
