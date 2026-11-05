// What a generated job looks like on the Jobs row, the job sheet, the phone and the push (Generated
// videos, GN9; boards GNJobs, GNStates, GNSheet, GNPhone). `generate.ts` (GN0) has the words of the
// Generate STAGE (its state, its errors, its History); this file reads a JOB and says which of
// those words it shows now, so the Mac and the phone choose them the same way.
//
// Everything here is pure and works from what a job already carries: `job.generate` (the stage's
// state, only while the Generate switch is on), `job.step` (stays 1 while Generate runs),
// `job.subProgress` (the engine writes the row text into it), `job.error` (the exact sentence of
// `generateErrorMessage` for a coded stop) and `job.formats` / `job.output.outputs`. A job with
// none of these reads exactly as it always did: every function answers "not mine" (`null`).

import { clock, listDetail, type TimeInput } from '../format.ts';
import {
  budgetUsdText,
  type GenerateErrorCode,
  type GenerateErrorContext,
  type GenerateState,
  generateRowError,
  generateRowText,
  type ParsedGenerateError,
  parseGenerateErrorMessage,
  spendUsdText,
} from './generate.ts';
import type { Job } from './job.ts';

/** The Brief step: the job stays on it (step 1) while Generate works. */
const BRIEF_STEP_ID = 1;

/** The name of the stage in the sheet's Steps, in "Retry from Generate" and in the failed row's text. */
export const GENERATE_STEP_NAME = 'Generate';

/** What the Generate stage reads from a job. */
export type GenerateJob = Pick<
  Job,
  'state' | 'step' | 'subProgress' | 'failedAt' | 'stoppedAt' | 'error'
> & { generate?: GenerateState | null | undefined };

/** The sentence the engine stores for a Generate stop that has no code of its own ("Generate stopped: …"). */
const UNCODED_STOP = /^Generate stopped:/;

/**
 * Whether the stage is working right now: the job is editing at step 1 and the engine has written
 * the stage's row text into its progress. Before that first text (the Brief is still being read)
 * and while a Retry runs the Brief again, the job is on the Brief step and Generate has not begun.
 */
export function isGeneratingNow(job: GenerateJob): boolean {
  return (
    job.state === 'editing' &&
    job.step === BRIEF_STEP_ID &&
    job.generate != null &&
    job.generate.phase !== 'done' &&
    (job.subProgress ?? '').startsWith('Generate')
  );
}

/** What a failed job's Generate stop says: the error it came from, or `null` for one with no code. */
export interface GenerateFailure {
  /** `null` for "Generate stopped: …" (the run wrote its own words). */
  error: ParsedGenerateError | null;
}

/**
 * The Generate stop a failed job carries, or `null` for any other failure. The engine stores the
 * exact sentence of `generateErrorMessage(…)` for a coded stop (GN5), so it is read back from the
 * text; a stop with no code starts "Generate stopped:". Both end the job at step 1.
 */
export function generateFailureOf(
  job: Pick<Job, 'state' | 'failedAt' | 'error'>,
): GenerateFailure | null {
  if (job.state !== 'failed' || job.failedAt !== BRIEF_STEP_ID || job.error === null) return null;
  const error = parseGenerateErrorMessage(job.error);
  if (error !== null) return { error };
  return UNCODED_STOP.test(job.error.trim()) ? { error: null } : null;
}

/** The context the error words need, from a parsed stop. */
export function generateErrorContextOf(error: ParsedGenerateError): GenerateErrorContext {
  return {
    service: error.service,
    ...(error.needUsd === undefined ? {} : { needUsd: error.needUsd }),
    ...(error.budgetUsd === undefined ? {} : { budgetUsd: error.budgetUsd }),
  };
}

/** Whether the job is a generated one: it has a Generate stage, or it stopped in one. */
export function isGeneratedJob(job: GenerateJob): boolean {
  return job.generate != null || generateFailureOf(job) !== null;
}

// --- where the stage is, for the Steps and the phone's segments ----------------------------------

/** How the Generate stage reads for a job. */
export type GenerateStageMark = 'pending' | 'running' | 'done' | 'failed' | 'stopped';

/**
 * Where a generated job is in its Generate stage, or `null` for a job that is not generated. The
 * stage sits between Brief (step 1) and Transcribe (step 2): a job at step 2 or later has done it.
 */
export function generateStageMark(job: GenerateJob): GenerateStageMark | null {
  if (!isGeneratedJob(job)) return null;
  const past = (step: Job['step']): boolean => step !== null && step > BRIEF_STEP_ID;
  switch (job.state) {
    case 'editing':
      if (isGeneratingNow(job)) return 'running';
      return past(job.step) ? 'done' : 'pending';
    case 'failed':
      if (generateFailureOf(job) !== null) return 'failed';
      return past(job.failedAt) ? 'done' : 'pending';
    case 'cancelled':
      if (
        job.stoppedAt === BRIEF_STEP_ID &&
        job.generate != null &&
        job.generate.phase !== 'done'
      ) {
        return 'stopped';
      }
      return past(job.stoppedAt) ? 'done' : 'pending';
    case 'review':
    case 'ready':
      return 'done';
    default:
      return 'pending';
  }
}

// --- the bar ---------------------------------------------------------------------------------------

const share = (done: number, total: number): number =>
  total <= 0 ? 0 : Math.min(1, Math.max(0, done / total));

/**
 * How far along the Generate stage is, 0 to 100, for the sheet's bar: planning is the first few
 * percent, the voice, the looks and the keyframes the next stretch, the clips most of the rest.
 * The stage has its own bar (the job stays at step 1), so this is the stage's own progress.
 */
export function generateProgressPct(state: GenerateState): number {
  const { counts } = state;
  switch (state.phase) {
    case 'plan':
      return 3;
    case 'voice':
      return Math.round(5 + 15 * share(counts.voice.done, counts.voice.total));
    case 'looks':
      return Math.round(20 + 10 * share(counts.looks.done, counts.looks.total));
    case 'keyframes':
      return Math.round(30 + 15 * share(counts.keyframes.done, counts.keyframes.total));
    case 'clips':
      return Math.round(45 + 50 * share(counts.clips.done, counts.clips.total));
    case 'sound':
      return 96;
    case 'done':
      return 100;
  }
}

/**
 * Where a stopped stage stopped, after "stopped 14:21 ·" in the Steps: "clips 4/6", "voice 3/7",
 * or "before any clip" when the money was the reason and no clip was made yet (the board's two).
 */
export function generateStopPlace(state: GenerateState, code?: GenerateErrorCode): string {
  const { counts } = state;
  const counted = (name: string, progress: { done: number; total: number }): string =>
    progress.total === 0 ? name : `${name} ${progress.done}/${progress.total}`;
  if (code === 'over_budget') return 'before any clip';
  switch (state.phase) {
    case 'plan':
      return 'planning';
    case 'voice':
      return counted('voice', counts.voice);
    case 'looks':
      return counted('looks', counts.looks);
    case 'keyframes':
      return counted('keyframes', counts.keyframes);
    case 'clips':
      return counts.clips.done > 0 ? counted('clips', counts.clips) : 'before any clip';
    case 'sound':
      return 'sound effects';
    case 'done':
      return '';
  }
}

// --- the Jobs row ----------------------------------------------------------------------------------

/** What the row's detail reads from a job. */
export type GenerateRowJob = GenerateJob &
  Pick<Job, 'preview' | 'output' | 'round' | 'fixing' | 'fixedCount'> & {
    formats?: Job['formats'];
  };

const SEPARATOR = ' · ';

/** "9:16 and 1:1", "9:16, 1:1 and 4:5". */
function andList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** A format id as the app writes the ratio: "9x16" is "9:16". */
function ratioOfId(id: string): string {
  return id.replace('x', ':');
}

/** The labels of the formats a job has, main first: "9:16", "1:1"; empty for a job with one. */
export function formatLabelsOf(job: Pick<Job, 'formats' | 'output'>): string[] {
  if (job.formats !== undefined && job.formats.length >= 2) {
    return job.formats.map((format) => format.label);
  }
  const outputs = job.output?.outputs;
  return outputs === undefined ? [] : outputs.map((file) => ratioOfId(file.format));
}

/** "1 clip below the bar", "2 clips below the bar". */
export function belowBarText(count: number): string {
  return `${count} ${count === 1 ? 'clip' : 'clips'} below the bar`;
}

/**
 * The row's detail for the states a generated job (or one with more than one format) says
 * differently, or `null` when the ordinary row text applies:
 * - generating: "Generate · voice 3/7", "Generate · clips 4/6 · $1.65"
 * - stopped by Generate: "Higgsfield balance is empty", "Needs about $4.10, the budget is $3"
 *   (and "Failed at Generate" for a stop with no code)
 * - ready for review: "Ready to review · 0:35 · 1 clip below the bar" or "· 9:16 and 1:1" (and
 *   " · round 2" after it); Quick fixes' own lines keep priority and are left alone
 * - approved with one file for each format: "2 files · 9:16 and 1:1 · 0:35"
 */
export function generateListDetail(job: GenerateRowJob): string | null {
  if (isGeneratingNow(job) && job.generate != null) return generateRowText(job.generate);

  const failure = generateFailureOf(job);
  if (failure !== null) {
    return failure.error === null
      ? `Failed at ${GENERATE_STEP_NAME}`
      : generateRowError(failure.error.code, generateErrorContextOf(failure.error));
  }

  const labels = formatLabelsOf(job);
  const belowBar = job.generate?.counts.belowBar ?? 0;
  if (job.state === 'review') {
    if (job.fixing !== null || job.fixedCount > 0) return null;
    if (belowBar === 0 && labels.length === 0) return null;
    const { preview } = job;
    return [
      'Ready to review',
      preview === null ? '' : clock(preview.durationSec),
      belowBar > 0 ? belowBarText(belowBar) : andList(labels),
      job.round > 0 ? `round ${job.round + 1}` : '',
    ]
      .filter((part) => part !== '')
      .join(SEPARATOR);
  }
  if (job.state === 'ready' && job.output?.outputs !== undefined && labels.length >= 2) {
    return [
      `${job.output.outputs.length} files`,
      andList(labels),
      clock(job.output.durationSec),
    ].join(SEPARATOR);
  }
  return null;
}

/**
 * The detail of a job's row (`listDetail`) with the words of a generated job and of a job with
 * more than one format. A job with neither reads exactly as `listDetail` says.
 */
export function jobListDetail(
  job: Parameters<typeof listDetail>[0] & GenerateRowJob,
  now: TimeInput,
): string {
  return generateListDetail(job) ?? listDetail(job, now);
}

// --- the push --------------------------------------------------------------------------------------

/** The title and the words of the ping for a job that stopped in Generate. */
export interface GeneratePing {
  title: string;
  body: string;
}

const SERVICE_NAMES = { higgsfield: 'Higgsfield', elevenlabs: 'ElevenLabs' } as const;

/** "The 4 clips made are kept." for the clips that were made before the stop; empty when none. */
function keptText(state: GenerateState | null | undefined): string {
  const made = state?.counts.clips.done ?? 0;
  if (made <= 0) return '';
  return made === 1 ? ' The 1 clip made is kept.' : ` The ${made} clips made are kept.`;
}

/**
 * The ping for a job that stopped in Generate (board GNPhone): "97 Window Ad stopped", and the plain
 * sentence of what to do. Nothing but the job's name and what happened leaves the Mac. `null` for
 * any other failure, which keeps its "Failed at <step>" ping.
 */
export function generatePing(job: GenerateJob & Pick<Job, 'name'>): GeneratePing | null {
  const failure = generateFailureOf(job);
  if (failure === null) return null;
  const title = `${job.name} stopped`;
  const error = failure.error;
  if (error === null) return { title, body: 'Generate stopped. Open the job to see why.' };
  const name = SERVICE_NAMES[error.service];
  const kept = keptText(job.generate);
  switch (error.code) {
    case 'balance_empty':
      return {
        title,
        body:
          error.service === 'higgsfield'
            ? `The Higgsfield balance is empty. Add funds in the Higgsfield console, then press Retry.${kept}`
            : `The ElevenLabs credits are used up. Add credits in ElevenLabs, then press Retry.${kept || ' What was already made is kept.'}`,
      };
    case 'key_rejected':
      return {
        title,
        body:
          error.service === 'higgsfield'
            ? 'Higgsfield did not accept the key. Check HIGGSFIELD_API_KEY in .env, then press Retry.'
            : 'ElevenLabs did not accept the key. Check ELEVENLABS_API_KEY, then press Retry.',
      };
    case 'over_budget':
      return {
        title,
        body: `This video needs about ${spendUsdText(error.needUsd ?? 0)}, over the budget of ${budgetUsdText(error.budgetUsd ?? 0)}. Add a note like “budget $5”, then press Retry.`,
      };
    case 'unavailable':
      return {
        title,
        body: `${name} is not answering. Wait a few minutes, then press Retry.${kept}`,
      };
    case 'bad_request':
      return { title, body: `${name} did not accept a request. Press Retry once.` };
    case 'generation_failed':
      return {
        title,
        body: `${name} could not make a shot. Press Retry, or add a note that says what to change.`,
      };
  }
}

// --- the sheet's bar -------------------------------------------------------------------------------

/** The right side of the sheet's bar while the stage works: the money from the clips on, else "". */
export function generateBarRight(state: GenerateState): string {
  if (state.phase !== 'clips' && state.spendUsd <= 0) return '';
  return `${spendUsdText(state.spendUsd)} of ${budgetUsdText(state.budgetUsd)}`;
}
