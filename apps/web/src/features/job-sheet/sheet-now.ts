// What the job sheet's "Now" part says: the one sentence under the title, the bar while the job
// waits, edits or renders, the failed job's error, and its buttons. Pure: the component
// (`JobSheetNow`) reads the clock, the job list and the actions, and hands them in. Design: canvas
// page "Job sheet", boards JSSheet, JSStatesA and JSStatesB.
//
// Rules the boards follow, and this file too:
// - Say only what the job's own data says. A time, a count or a name that is not there is left
//   out of the sentence (never made up), so every sentence reads whole without it.
// - Times of day (HH:MM, 24-hour) and days (21 Oct) are on the browser's clock; `timeZone` pins
//   one for tests. The wording of sizes, lengths and delivery days is the app's: the shared
//   formatters and `delivery-text.ts`.

import {
  absoluteTime,
  belowBarText,
  budgetUsdText,
  type CameraLutWait,
  clock,
  eta,
  fileSize,
  formatLabelsOf,
  GENERATE_STEP_NAME,
  type GenerateHistoryEvent,
  generateBarRight,
  generateErrorContextOf,
  generateErrorHelp,
  generateErrorLine,
  generateErrorTitle,
  generateFailureOf,
  generateNowText,
  generateProgressLabel,
  generateProgressPct,
  generateStoppedText,
  isFolderDeleted,
  isGeneratingNow,
  isMusicVersionId,
  type Job,
  jobStage,
  type MusicView,
  paidAmountOf,
  parseCameraLutWait,
  RENDER_STEP,
  reviewExportFileName,
  STEP_IDS,
  STEP_LABELS,
  type StepId,
  type TimeInput,
} from '@studio/shared';
import { downloadUrl, formatDownloadUrl } from '@/data';
import { type NextStepAction, nextStepAction } from '../jobs/cells/row-actions';
import {
  archivedDay,
  deliveredDay,
  formatPrice,
  isPriced,
  paidDay,
  postedDay,
} from '../jobs/delivery-text';
import { CAMERA_WAIT_DETAIL } from '../luts/camera/camera-wait';
import { SONG_SHEET_TEXT } from './sheet-songs';

/** The bar's colour: grey while the job waits, blue while the engine works on it. */
export type SheetBarTone = 'grey' | 'blue';

/** The bar under the sentence: how far along, what it is called, and a note on the right. */
export interface SheetNowProgress {
  /** 0 to 100. */
  pct: number;
  /** "Cut · graphics 2 of 5", "Render", "Waiting for the last files". */
  label: string;
  /** "~4 min left", "starts in 0:42"; "" when there is nothing to say. */
  right: string;
  tone: SheetBarTone;
}

export interface SheetNow {
  sentence: string;
  /** Only an arriving, editing or rendering job has a bar. */
  progress?: SheetNowProgress;
}

export interface SheetNowOptions {
  /** An IANA zone to read times and days in (tests); the browser's own by default. */
  timeZone?: string;
  /**
   * How many notes were sent in the round this review job is the result of ("It has your 3 notes
   * from round 1"). Left out of the sentence when it is not known.
   */
  sentNotes?: number | null;
  /**
   * The job's music (Soundtrack; `null` or left out for a job with none): the sentence says when the
   * music is being written, and whether the first cut came with music or without (boards SDSheet).
   */
  music?: MusicView | null;
  /**
   * Both files of a video whose music is a song are made (Songs, `hasTwoFiles`): an approved job's
   * sentence then says so, in place of "The MP4 is ready: …". Left out (every job without a song,
   * and Songs off) the sentence is what it always was.
   */
  twoFiles?: boolean;
  /**
   * What the Generate stage did (`GET /api/jobs/:id/generate/history`), for a generated job: the
   * bar says when the stage began ("started 14:01") from its first event. Left out, it does not.
   */
  generateHistory?: readonly GenerateHistoryEvent[];
}

/** The settle wait the engine starts with, for an arriving job that does not say when it ends. */
const DEFAULT_SETTLE_SEC = 60;

/** Each step in the words of the sentence. Step 8 is the render, which has a sentence of its own. */
const STEP_WORDS = {
  1: 'Writing the brief',
  2: 'Transcribing the speech',
  3: 'Looking through the footage',
  4: 'Planning the cut',
  5: 'Cutting the video',
  6: 'Building the preview',
  7: 'Checking the cut',
  8: 'Making the MP4',
} as const satisfies Record<StepId, string>;

function toMs(time: TimeInput): number {
  if (time instanceof Date) return time.getTime();
  return typeof time === 'number' ? time : Date.parse(time);
}

/** "12:52": the 24-hour time of day of a moment ("" when it cannot be read). */
export function timeOfDay(iso: TimeInput, timeZone?: string): string {
  return absoluteTime(iso, timeZone).slice(-5);
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

// --- the bar ------------------------------------------------------------------------------------

const COUNT = /(\d+)\s*\/\s*(\d+)/;

/** "graphics 2/5" is 2 of 5 done: the share of the step that is behind the job, 0 to 1. */
function shareDone(sub: string | null): number {
  const match = COUNT.exec(sub ?? '');
  if (match === null) return 0;
  const total = Number(match[2]);
  return total > 0 ? Math.min(1, Number(match[1]) / total) : 0;
}

/**
 * How far along an edit is: each of the eight steps is an eighth, and the count inside the current
 * step fills part of it. Cut with graphics 2 of 5 is (4 steps + 2/5) / 8 = 55%.
 */
function stepPct(step: StepId, sub: string | null): number {
  return Math.round(((step - 1 + shareDone(sub)) / STEP_IDS.length) * 100);
}

/** "Cut · graphics 2 of 5": the step, then the count inside it the way the sentence says it. */
function stepBarLabel(step: StepId, sub: string | null): string {
  const name = STEP_LABELS[step];
  return sub === null ? name : `${name} · ${sub.replace(COUNT, '$1 of $2')}`;
}

// --- the sentences ------------------------------------------------------------------------------

/** What the count inside a step means, in words; `null` when it is not one the engine writes. */
function stepDetail(step: StepId, sub: string | null): string | null {
  if (sub === null) return null;
  const count = (pattern: RegExp) => pattern.exec(sub.trim());
  switch (step) {
    case 2: {
      const match = count(/^(\d+)\/(\d+)$/);
      return match && `${match[1]} of ${match[2]} files done`;
    }
    case 5: {
      const match = count(/^graphics (\d+)\/(\d+)$/);
      return match && `adding graphic ${match[1]} of ${match[2]}`;
    }
    case 7: {
      const match = count(/^pass (\d+)\/(\d+)$/);
      return match && `pass ${match[1]} of ${match[2]}`;
    }
    default:
      return null;
  }
}

function arrivingNow(job: Job, now: TimeInput): SheetNow {
  const settlesMs = job.settlesAt === null ? Number.NaN : Date.parse(job.settlesAt);
  const windowMs = settlesMs - Date.parse(job.lastChangeAt);
  const hasWindow = Number.isFinite(windowMs) && windowMs > 0;
  const seconds = hasWindow ? Math.round(windowMs / 1000) : DEFAULT_SETTLE_SEC;
  const sentence = `Files are still coming in. The edit starts once nothing new has landed for ${seconds} seconds.`;
  if (!Number.isFinite(settlesMs)) return { sentence };

  const nowMs = toMs(now);
  // Rounded up, like the row's "settles in 0:42": the timer shows 0:01 until it fires.
  const remaining = Math.max(0, Math.ceil((settlesMs - nowMs) / 1000));
  const elapsedShare = hasWindow ? (nowMs - Date.parse(job.lastChangeAt)) / windowMs : 1;
  return {
    sentence,
    progress: {
      pct: Math.round(Math.min(1, Math.max(0, elapsedShare)) * 100),
      label: 'Waiting for the last files',
      right: `starts in ${clock(remaining)}`,
      tone: 'grey',
    },
  };
}

/** "in about 4 minutes", "in under a minute"; `null` when the engine has no estimate. */
function minutesText(etaSec: number | null): string | null {
  if (etaSec === null || !Number.isFinite(etaSec)) return null;
  if (etaSec < 60) return 'in under a minute';
  const minutes = Math.ceil(etaSec / 60);
  return `in about ${plural(minutes, 'minute', 'minutes')}`;
}

/**
 * The job a queued job waits for: when it is first in line, the editing job that finishes first
 * (the engine can edit two at once; one with no estimate counts as finishing last), else the
 * queued job one place ahead. `null` when there is nobody.
 */
export function jobAhead(job: Job, jobs: readonly Job[]): Job | null {
  const place = job.placeInLine;
  if (place === null) return null;
  if (place > 1) {
    const ahead = jobs.find((other) => other.state === 'queued' && other.placeInLine === place - 1);
    return ahead === undefined || ahead.id === job.id ? null : ahead;
  }
  const editing = jobs.filter((other) => other.state === 'editing' && other.id !== job.id);
  const left = (other: Job) => other.etaSec ?? Number.POSITIVE_INFINITY;
  return editing.reduce<Job | null>(
    (soonest, other) => (soonest === null || left(other) < left(soonest) ? other : soonest),
    null,
  );
}

function queuedNow(job: Job, jobs: readonly Job[]): SheetNow {
  if (job.placeInLine === null) return { sentence: 'Waiting in line.' };
  const lead = `#${job.placeInLine} in line.`;
  const ahead = jobAhead(job, jobs);
  if (ahead === null) return { sentence: `${lead} It starts next.` };
  // Only the job that is editing has an estimate; one that is still queued has none.
  const wait = ahead.state === 'editing' ? minutesText(ahead.etaSec) : null;
  return { sentence: `${lead} It starts when ${ahead.name} is done${wait ? `, ${wait}` : ''}.` };
}

/**
 * What the sentence says while the first music is being written (Soundtrack, board SDSheet, Making):
 * the cut is planned and ElevenLabs is writing music to its shape. Only the Preview step, and only
 * for the first version of an edit; later versions are made in Review.
 */
function writingMusic(job: Job, music: MusicView | null | undefined): string | null {
  if (job.step !== 6 || job.runKind === 'render') return null;
  if (music === null || music === undefined || music.making === null) return null;
  if (music.versions.length > 0) return null;
  return 'The cut is planned. ElevenLabs is writing its music now, to the cut’s shape.';
}

/**
 * The Generate stage at work (board GNSheet, voice and clips): the sentence says what is being made,
 * and the bar is the stage's own (the job stays at step 1): "Generate · clips 4/6", with the money
 * on the right from the clips on and "started 14:01" before.
 */
function generatingNow(
  job: Job,
  timeZone: string | undefined,
  history: readonly GenerateHistoryEvent[] | undefined,
): SheetNow | null {
  const state = job.generate;
  if (!isGeneratingNow(job) || state == null) return null;
  const began = history?.[0]?.at;
  const money = generateBarRight(state);
  return {
    sentence: generateNowText(state),
    progress: {
      pct: generateProgressPct(state),
      label: generateProgressLabel(state),
      right:
        money !== '' ? money : began === undefined ? '' : `started ${timeOfDay(began, timeZone)}`,
      tone: 'blue',
    },
  };
}

function editingNow(
  job: Job,
  timeZone: string | undefined,
  music?: MusicView | null,
  history?: readonly GenerateHistoryEvent[],
): SheetNow {
  const generating = generatingNow(job, timeZone, history);
  if (generating !== null) return generating;
  const { step, subProgress } = job;
  const right = eta(job.etaSec);
  // The render run, or the last step of an edit that renders on its own (the Review switch is off).
  if (job.runKind === 'render' || step === RENDER_STEP) {
    const approved = job.approvedAt === null ? null : timeOfDay(job.approvedAt, timeZone);
    return {
      sentence: approved
        ? `You approved it at ${approved}. Making the MP4 now.`
        : 'Making the MP4 now.',
      progress: {
        pct: stepPct(RENDER_STEP, step === RENDER_STEP ? subProgress : null),
        label: 'Render',
        right,
        tone: 'blue',
      },
    };
  }
  // A revise run applies the notes of the round that was just sent.
  const revising = job.runKind === 'revise' ? `Applying your notes from round ${job.round}. ` : '';
  if (step === null) return { sentence: `${revising}The edit is starting.` };
  const detail = stepDetail(step, subProgress);
  const writing = job.runKind === 'revise' ? null : writingMusic(job, music);
  return {
    sentence: writing ?? `${revising}${STEP_WORDS[step]}${detail ? `: ${detail}` : ''}.`,
    progress: {
      pct: stepPct(step, subProgress),
      label: stepBarLabel(step, subProgress),
      right,
      tone: 'blue',
    },
  };
}

/**
 * What the first cut's sentence says about its music (boards SDSheet, Ready to review): a cut that
 * came with music made for it, or that has none because the first make failed, and why. Anything
 * else (the folder's file, a rule, the series' music, No music) says nothing here: the Music row
 * does.
 */
function firstCutMusic(music: MusicView | null | undefined): { with?: string; without?: string } {
  if (music === null || music === undefined || music.source !== 'made') return {};
  if (music.versions.length > 0) {
    const playing = music.picked !== null && isMusicVersionId(music.picked);
    return playing ? { with: ', with music made for it' } : {};
  }
  const { failure } = music;
  if (failure === null || music.picked !== null) return {};
  const why =
    failure.code === 'no_credits'
      ? 'ElevenLabs had no credits left. You can make it in Review once they are back.'
      : 'it couldn’t be made. You can try again in Review.';
  return { without: `, but without music: ${why}` };
}

/**
 * What a generated job adds to its review sentence (board GNSheet, Budget ran out): the budget ran
 * out with clips below the bar, which kept their best take. Empty for any other job.
 */
function belowBarSentence(job: Job): string {
  const state = job.generate;
  const count = state?.counts.belowBar ?? 0;
  if (state == null || count === 0) return '';
  return ` The ${budgetUsdText(state.budgetUsd)} budget ran out with ${belowBarText(count)}; ${
    count === 1 ? 'it kept its best take' : 'they kept their best takes'
  }. Say in a note if ${count === 1 ? 'it needs' : 'they need'} another.`;
}

function reviewNow(job: Job, sentNotes: number | null, music?: MusicView | null): SheetNow {
  const length = job.preview === null ? '' : `, ${clock(job.preview.durationSec)}`;
  const formats = formatLabelsOf(job);
  const inFormats = formats.length >= 2 ? `, in ${formats.join(' and ')}` : '';
  const below = belowBarSentence(job);
  if (job.round === 0) {
    const said = firstCutMusic(music);
    if (said.without !== undefined) {
      return { sentence: `The first cut is ready${length}${inFormats}${said.without}${below}` };
    }
    const made = formats.length >= 2 ? 'Both files are made' : 'The MP4 is made';
    return {
      sentence: `The first cut is ready${length}${inFormats}${said.with ?? ''}. ${made} after you approve it.${below}`,
    };
  }
  // `Job.round` counts the rounds of notes sent: round 1's notes made the second cut.
  const notes = sentNotes ? plural(sentNotes, 'note', 'notes') : 'notes';
  return {
    sentence: `Round ${job.round + 1} is ready${length}${inFormats}. It has your ${notes} from round ${job.round}.${below}`,
  };
}

/**
 * A job that stopped in Generate (board GNSheet, Balance empty and Over the budget): when, why, and
 * what Retry keeps. Its error sentence is the engine's own words for the code (`generateErrorMessage`).
 */
function generateStoppedNow(job: Job, timeZone: string | undefined): SheetNow | null {
  const failure = generateFailureOf(job);
  if (failure === null) return null;
  const at = timeOfDay(job.updatedAt, timeZone);
  if (failure.error === null) {
    return {
      sentence: `${GENERATE_STEP_NAME} stopped at ${at}. The Brief is kept, so Retry starts at ${GENERATE_STEP_NAME}.`,
    };
  }
  const clips = job.generate?.counts.clips;
  return {
    sentence: generateStoppedText(failure.error.code, {
      ...generateErrorContextOf(failure.error),
      at,
      ...(clips === undefined ? {} : { clipsKept: clips.done, clipsTotal: clips.total }),
    }),
  };
}

function failedNow(job: Job, timeZone: string | undefined): SheetNow {
  const stopped = generateStoppedNow(job, timeZone);
  if (stopped !== null) return stopped;
  const at = timeOfDay(job.updatedAt, timeZone);
  const step = job.failedAt;
  if (step === null) return { sentence: `It stopped at ${at}.` };
  const kept = step - 1;
  const keptText =
    kept === 0
      ? 'Nothing was finished yet'
      : kept === 1
        ? 'Step 1 is kept'
        : `Steps 1 to ${kept} are kept`;
  const retry =
    step === RENDER_STEP
      ? 'Retry only makes the MP4 again'
      : `Retry starts at ${STEP_LABELS[step]}`;
  return { sentence: `${STEP_LABELS[step]} stopped at ${at}. ${keptText}, so ${retry}.` };
}

function cancelledNow(job: Job, timeZone: string | undefined): SheetNow {
  const at = timeOfDay(job.updatedAt, timeZone);
  const step = job.stoppedAt;
  if (step === null) return { sentence: `You stopped it at ${at}. Resume picks it up again.` };
  const name = STEP_LABELS[step];
  return {
    sentence: `You stopped it during ${name} at ${at}. Resume picks it up again at ${name}.`,
  };
}

function readyNow(job: Job, timeZone: string | undefined, twoFiles: boolean): SheetNow {
  const { archivedAt, delivery, output } = job;
  if (archivedAt !== null) {
    const counted = delivery === null ? '' : ' It still counts in income.';
    return {
      sentence: `Archived on ${archivedDay(archivedAt, timeZone)}, so it only shows with Show archived on.${counted}`,
    };
  }
  const stage = jobStage(job);
  if (delivery !== null && stage === 'delivered') {
    const sent = deliveredDay(delivery, timeZone);
    // An editor's job has no money: the sentence says only that it was sent.
    if (!isPriced(delivery)) return { sentence: `Sent to ${job.client} on ${sent}.` };
    return {
      sentence: `Sent to ${job.client} on ${sent}. ${formatPrice(delivery.price, delivery.currency)} isn’t paid yet.`,
    };
  }
  if (delivery !== null && stage === 'uploaded') {
    const posted = `Posted on Instagram ${postedDay(delivery, timeZone)}.`;
    // An editor's job has no money: the sentence says only where it went.
    if (!isPriced(delivery)) return { sentence: posted };
    return {
      sentence: `${posted} ${formatPrice(delivery.price, delivery.currency)} isn’t paid yet.`,
    };
  }
  if (delivery?.paidOn && isPriced(delivery) && stage === 'paid') {
    const paid = formatPrice(paidAmountOf(delivery), delivery.currency);
    return { sentence: `Paid ${paid} on ${paidDay(delivery.paidOn)}. Nothing left to do.` };
  }
  if (twoFiles) return { sentence: SONG_SHEET_TEXT.twoFiles };
  // Generated videos (GN7): one file for each format the brief asked for.
  const files = output?.outputs?.length ?? 0;
  if (files >= 2) {
    const count = files === 2 ? 'Two' : files === 3 ? 'Three' : String(files);
    return {
      sentence: `Approved and rendered. ${count} files, one for each format the brief asked for. They haven’t been sent to ${job.client} yet.`,
    };
  }
  const made =
    output === null
      ? 'The MP4 is ready.'
      : `The MP4 is ready: ${clock(output.durationSec)}, ${fileSize(output.sizeBytes)}.`;
  return { sentence: `${made} It hasn’t been sent to ${job.client} yet.` };
}

/**
 * The sentence under the job's title, and the bar when it has one. One shape per state:
 *
 * - arriving: files are still coming in; a grey bar fills over the settle wait, "starts in 0:42"
 * - queued: "#2 in line. It starts when <the job ahead> is done, in about 4 minutes." The job ahead
 *   is found in `jobs`; only a job that is editing has an estimate
 * - held: "On hold since 11:20." (the time the job last changed)
 * - editing: one sentence per step ("Cutting the video: adding graphic 2 of 5."), and a blue bar
 *   with the step, its count and the time left; a revise run says whose notes it applies; while
 *   the first music is being written (Preview) it says so
 * - rendering (an editing job on the render run): "You approved it at 15:10. Making the MP4 now."
 * - review: the first cut ("…, with music made for it" or "…, but without music: …"), or "Round 2
 *   is ready, 0:41. It has your 3 notes from round 1."
 * - failed and cancelled: what stopped, when, and where Retry or Resume starts again
 * - ready: approved, delivered, paid or archived; an approved job with both files of a song says
 *   "Approved and rendered. Two files: …" (`twoFiles`)
 *
 * `now` is a parameter so the result is a pure function of its inputs.
 */
export function sheetNow(
  job: Job,
  jobs: readonly Job[],
  now: TimeInput,
  {
    timeZone,
    sentNotes = null,
    music = null,
    twoFiles = false,
    generateHistory,
  }: SheetNowOptions = {},
): SheetNow {
  switch (job.state) {
    case 'arriving':
      return arrivingNow(job, now);
    case 'queued':
      return queuedNow(job, jobs);
    case 'held':
      return {
        sentence: `On hold since ${timeOfDay(job.updatedAt, timeZone)}. It won’t start until you release it.`,
      };
    case 'editing':
      return editingNow(job, timeZone, music, generateHistory);
    case 'review':
      return reviewNow(job, sentNotes, music);
    case 'failed':
      return failedNow(job, timeZone);
    case 'cancelled':
      return cancelledNow(job, timeZone);
    case 'ready':
      return readyNow(job, timeZone, twoFiles);
  }
}

// --- the error ----------------------------------------------------------------------------------

/** The red box of a failed job: "Failed at Render · 12:52", and the whole error text. */
export interface SheetError {
  title: string;
  /** The whole error text: what Copy puts on the clipboard, and what the box shows when it has no `line`. */
  text: string;
  /**
   * A job that stopped in Generate (GN9, board GNSheet): the code line the box shows in place of
   * the whole text ("HTTP 403 · Insufficient balance"), and the help under it. Both or neither.
   */
  line?: string | undefined;
  help?: string | undefined;
  /**
   * The job waits for a camera LUT (LU10): its error is the engine's sentence for that. Its box is
   * amber, not red, titled "Waiting for a camera LUT · 12:52", and carries an Import LUT button.
   */
  cameraWait?: CameraLutWait | undefined;
  /** The job's id, for the Import LUT button of a job that waits for a camera LUT. */
  jobId?: string | undefined;
}

/** `null` unless the job failed with an error text (nothing to show or copy without one). */
export function sheetError(job: Job, timeZone?: string): SheetError | null {
  if (job.state !== 'failed' || job.error === null) return null;
  const cameraWait = parseCameraLutWait(job.error);
  if (cameraWait !== null) {
    return {
      title: `${CAMERA_WAIT_DETAIL} · ${timeOfDay(job.updatedAt, timeZone)}`,
      text: job.error,
      cameraWait,
      jobId: job.id,
    };
  }
  const failure = generateFailureOf(job);
  if (failure?.error != null) {
    // The board's box: the error's own title (no time), its code line, and what to do.
    const context = generateErrorContextOf(failure.error);
    return {
      title: generateErrorTitle(failure.error.code, context),
      text: job.error,
      line: generateErrorLine(failure.error.code, context),
      help: generateErrorHelp(failure.error.code, context),
    };
  }
  const where =
    failure !== null
      ? `${GENERATE_STEP_NAME} stopped`
      : job.failedAt === null
        ? 'Failed'
        : `Failed at ${STEP_LABELS[job.failedAt]}`;
  return { title: `${where} · ${timeOfDay(job.updatedAt, timeZone)}`, text: job.error };
}

// --- the buttons --------------------------------------------------------------------------------

/** Download MP4: a link to the finished export. */
export interface SheetDownload {
  label: string;
  href: string;
}

export interface SheetButtons {
  /** The step that moves the job on (the same one as the row's icon button), with its name. */
  primary: NextStepAction | null;
  /** Beside it once there is an MP4 (a ready job). A video whose folder was deleted has none. */
  download: SheetDownload | null;
}

/**
 * The sheet's buttons: queued, editing and rendering jobs have none. An editor (`admin` false) has
 * no Mark delivered or Mark paid….
 */
export function sheetButtons(job: Job, admin = true): SheetButtons {
  return {
    primary: nextStepAction(job, admin),
    download:
      job.state === 'ready' && !isFolderDeleted(job)
        ? { label: 'Download MP4', href: downloadUrl(job.id) }
        : null,
  };
}

/** One file of a job with a video for each format (board GNSheet, Approved): its name, what it is, where it downloads from. */
export interface SheetFile {
  /** The format's id, "9x16". */
  format: string;
  /** The file's name as it downloads: "97 Window Ad.mp4", "97 Window Ad (1x1).mp4". */
  name: string;
  /** "9:16 · 1080 × 1920 · 0:35 · 27 MB". */
  sub: string;
  href: string;
  /** "Download 9:16": the button's accessible name. */
  label: string;
}

/**
 * The files of an approved job that has one for each format (Generated videos, GN7), main first;
 * none for every other job, whose one file is `sheetButtons().download`. A video whose folder was
 * deleted has none.
 */
export function sheetFiles(job: Job): SheetFile[] {
  const { output } = job;
  const outputs = output?.outputs;
  if (job.state !== 'ready' || isFolderDeleted(job) || output === null || outputs === undefined) {
    return [];
  }
  const labels = formatLabelsOf(job);
  return outputs.map((file, index) => {
    const format = job.formats?.find((one) => one.id === file.format);
    const label = labels[index] ?? file.format.replace('x', ':');
    return {
      format: file.format,
      name: reviewExportFileName(job.name, index === 0 ? null : file.format),
      sub: [
        label,
        format === undefined ? '' : `${format.width} × ${format.height}`,
        clock(output.durationSec),
        fileSize(file.bytes),
      ]
        .filter((part) => part !== '')
        .join(' · '),
      href: formatDownloadUrl(job.id, file.format),
      label: `Download ${label}`,
    };
  });
}
