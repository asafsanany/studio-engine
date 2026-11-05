// Every string the Jobs table shows comes from one of these functions, so the exact wording
// (approved design canvas, boards "Jobs" and "Jobs · empty") lives in one tested place.
// Pure and dependency-free: no Date.now(), no locale lookups, no date library.
//
// Decisions the canvas does not spell out:
// - Times are shown in the viewer's local time zone. Pass `timeZone` (an IANA name such as
//   "Asia/Jerusalem") to pin one, which is what the tests do. Without it the system zone is read
//   on every call, so a machine that changes zone is followed without a reload.
// - Month and weekday names are English whatever the system locale; they come from tables here,
//   not from Intl, so ICU data (e.g. "Sep" vs "Sept") can never change the text.
// - Sizes are decimal (1 MB = 1,000,000 bytes, 1 GB = 1,000 MB), as in Finder and the canvas
//   (3,100 MB shows as "3.1 GB"; a 1,024 base would give "3.0 GB").
// - A bad input (NaN, an unparsable timestamp) gives the empty or zero form, never "NaN".

import type { InputCounts, Job } from './domain/job.ts';
import { STEP_LABELS } from './domain/steps.ts';

/** A point in time: an ISO string, epoch milliseconds, or a `Date`. */
export type TimeInput = string | number | Date;

/** Middle dot with spaces: "Cut · graphics 2/5", "0:45 · 1080×1920 · 62 MB". */
const SEPARATOR = ' · ';
/** Multiplication sign U+00D7, not the letter x. */
const TIMES = '×';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

const MS_PER_DAY = 86_400_000;

function toMs(time: TimeInput): number {
  if (time instanceof Date) return time.getTime();
  return typeof time === 'number' ? time : Date.parse(time);
}

interface CalendarParts {
  year: number;
  /** 1-12 */
  month: number;
  day: number;
  /** 0-23 */
  hour: number;
  minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** The wall-clock fields of an instant, in `timeZone` or, when omitted, the system zone. */
function calendarParts(ms: number, timeZone: string | undefined): CalendarParts {
  if (timeZone === undefined) {
    const date = new Date(ms);
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
    };
  }
  const parts: CalendarParts = { year: 0, month: 0, day: 0, hour: 0, minute: 0 };
  for (const part of formatterFor(timeZone).formatToParts(ms)) {
    if (
      part.type === 'year' ||
      part.type === 'month' ||
      part.type === 'day' ||
      part.type === 'hour' ||
      part.type === 'minute'
    ) {
      parts[part.type] = Number(part.value);
    }
  }
  // Some engines report midnight as 24 even with hourCycle h23.
  parts.hour %= 24;
  return parts;
}

/** The calendar date as a day count, so two dates can be subtracted. */
function dayNumber({ year, month, day }: CalendarParts): number {
  return Math.floor(Date.UTC(year, month - 1, day) / MS_PER_DAY);
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * How long ago `iso` was, relative to `now`, for the Added and Last updated columns.
 *
 * - under 60 s: "Just now" (a time in the future, from clock skew, counts as "Just now" too)
 * - under 60 min: "1 min ago", "12 min ago" (minutes rounded down)
 * - an hour or more, same calendar day: "1 h ago", "4 h ago" (hours rounded down)
 * - the previous calendar day: "Yesterday"
 * - earlier: "2 days ago", "3 days ago" (calendar days, not 24 h blocks)
 *
 * The minutes rule comes first: 00:10 is "20 min ago" for 23:50 the evening before, but 23:10
 * that evening is already "Yesterday". Returns "" when either time cannot be parsed.
 */
export function relativeTime(iso: TimeInput, now: TimeInput, timeZone?: string): string {
  const then = toMs(iso);
  const at = toMs(now);
  if (!Number.isFinite(then) || !Number.isFinite(at)) return '';

  const seconds = Math.floor((at - then) / 1000);
  if (seconds < 60) return 'Just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;

  const days = dayNumber(calendarParts(at, timeZone)) - dayNumber(calendarParts(then, timeZone));
  if (days <= 0) return `${Math.floor(minutes / 60)} h ago`;
  if (days === 1) return 'Yesterday';
  return `${days} days ago`;
}

/**
 * The exact moment for the tooltip on Added and Last updated: "Tue 20 Oct 2026, 13:41". English,
 * 24-hour clock, day without a leading zero ("Mon 5 Oct 2026, 09:05"). Returns "" when `iso`
 * cannot be parsed.
 */
export function absoluteTime(iso: TimeInput, timeZone?: string): string {
  const ms = toMs(iso);
  if (!Number.isFinite(ms)) return '';
  const parts = calendarParts(ms, timeZone);
  const weekday = WEEKDAYS[new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay()];
  const month = MONTHS[parts.month - 1];
  return `${weekday} ${parts.day} ${month} ${parts.year}, ${pad2(parts.hour)}:${pad2(parts.minute)}`;
}

/**
 * A byte count the way the table shows it: whole megabytes ("48 MB", "640 MB"), or gigabytes with
 * one decimal from 1,000 MB up ("1.1 GB", "2.0 GB"). Decimal units (1 MB = 1,000,000 bytes).
 * Anything under 1 MB is "< 1 MB" rather than a misleading "0 MB"; zero, negative and non-finite
 * values give "0 MB". GB is the largest unit.
 */
export function fileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  if (bytes < 1_000_000) return '< 1 MB';
  const megabytes = Math.round(bytes / 1e6);
  if (megabytes < 1000) return `${megabytes} MB`;
  // Rounded to tenths as an integer first, so 999.6 MB reads "1.0 GB", never "1000 MB".
  return `${(Math.round(bytes / 1e8) / 10).toFixed(1)} GB`;
}

/**
 * A duration as a clock: "0:42", "1:12", "10:00", and "1:02:05" from one hour up. Rounded to the
 * nearest second; negative and non-finite values give "0:00".
 */
export function clock(sec: number): string {
  const total = Number.isFinite(sec) && sec > 0 ? Math.round(sec) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = pad2(total % 60);
  return hours > 0 ? `${hours}:${pad2(minutes)}:${seconds}` : `${minutes}:${seconds}`;
}

/**
 * A length of time in words, the way the Analytics page says it: "45 s" under a minute, "52 min"
 * under an hour, then "2 h 40 m" (or "2 h" on the hour), and "1 d 4 h" (or "1 d") once it is a day
 * or more. Rounded to the nearest second, minute, minute and hour in turn. Negative and non-finite
 * values read as "0 s".
 */
export function spanText(sec: number): string {
  const seconds = Number.isFinite(sec) && sec > 0 ? Math.round(sec) : 0;
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest === 0 ? `${hours} h` : `${hours} h ${rest} m`;
  }
  const days = Math.floor(hours / 24);
  const restHours = Math.round((minutes - days * 24 * 60) / 60);
  // 23 h 40 m more rounds up to a whole extra day.
  if (restHours >= 24) return `${days + 1} d`;
  return restHours === 0 ? `${days} d` : `${days} d ${restHours} h`;
}

/** Frame size as "1080×1920" (the multiplication sign, U+00D7). */
export function resolution(width: number, height: number): string {
  return `${width}${TIMES}${height}`;
}

/** What `statusDetail` reads from a job. */
export type StatusDetailJob = Pick<
  Job,
  'state' | 'placeInLine' | 'settlesAt' | 'output' | 'failedAt' | 'stoppedAt' | 'preview' | 'round'
>;

/** "at Plan" for a stopped job; "" when the step is unknown. */
function atStep(step: Job['failedAt']): string {
  return step === null ? '' : `at ${STEP_LABELS[step]}`;
}

/**
 * The grey text next to the status badge:
 * - arriving: "settles in 0:42" (time left on the settle timer at `now`, never below 0:00)
 * - queued: "#2 in line"
 * - review: "0:28 · 1080×1920" (duration and frame size of the preview), then " · round 2" once notes were sent
 *   (the cut is numbered as the job sheet does, one more than the rounds of notes sent: see `cutRound`)
 * - ready: "0:45 · 1080×1920 · 62 MB" (duration, frame size, file size of the export)
 * - failed: "at Render" (the step it stopped at); cancelled: "at Plan"
 * - held: ""
 * - editing: "" (the cell shows `stepLabel` and `editingDetail` instead)
 *
 * Also "" when the field the state needs is missing (no settle time, no place in line, no
 * output, no step). `now` is a parameter so the result is a pure function of its inputs.
 */
export function statusDetail(job: StatusDetailJob, now: TimeInput): string {
  switch (job.state) {
    case 'arriving': {
      if (job.settlesAt === null) return '';
      // Rounded up: the timer shows 0:01 until it fires.
      const remaining = Math.ceil((toMs(job.settlesAt) - toMs(now)) / 1000);
      return `settles in ${clock(Math.max(0, remaining))}`;
    }
    case 'queued':
      return job.placeInLine === null ? '' : `#${job.placeInLine} in line`;
    case 'review': {
      const { preview } = job;
      if (preview === null) return '';
      const parts = [clock(preview.durationSec), resolution(preview.width, preview.height)];
      if (job.round > 0) parts.push(`round ${cutRound(job)}`);
      return parts.join(SEPARATOR);
    }
    case 'ready': {
      const { output } = job;
      if (output === null) return '';
      return [
        clock(output.durationSec),
        resolution(output.width, output.height),
        fileSize(output.sizeBytes),
      ].join(SEPARATOR);
    }
    case 'failed':
      return atStep(job.failedAt);
    case 'cancelled':
      return atStep(job.stoppedAt);
    case 'held':
    case 'editing':
      return '';
  }
}

/**
 * The step name with its progress inside the step: "Cut · graphics 2/5", "Transcribe · 6/14",
 * "Render". "" when the job has no current step. Reads `step` as it is, so a failed or cancelled
 * job (which keeps its step) gets a label too; the table only shows it while editing.
 */
export function stepLabel(job: Pick<Job, 'step' | 'subProgress'>): string {
  if (job.step === null) return '';
  const label = STEP_LABELS[job.step];
  return job.subProgress ? `${label}${SEPARATOR}${job.subProgress}` : label;
}

/**
 * Time left on an edit: "~4 min left". Whole minutes, rounded up, so it never promises to be done
 * sooner than it will be. Under a minute is "< 1 min left" (including 0). "" when there is no
 * estimate (`null`, `undefined`, NaN or infinite), which hides the slot in the table.
 */
export function eta(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return '';
  if (sec < 60) return '< 1 min left';
  return `~${Math.ceil(sec / 60)} min left`;
}

/**
 * Which cut a job is on, as the list and the job sheet both say it: the first cut is round 1 and
 * the cut made from the first round of notes is round 2. `Job.round` counts the rounds of notes
 * that were sent (0 until the first Send notes), so the cut is one more. (The notes themselves
 * keep the round they were sent in: "Review notes – round 1.md", "Your notes in round 1".)
 */
export function cutRound(job: Pick<Job, 'round'>): number {
  return job.round + 1;
}

/** The run a job is on, for the editing row: "" for an edit, "round 2" for a revise run, "approved" for the render. */
export function runKindDetail(job: Pick<Job, 'runKind' | 'round'>): string {
  if (job.runKind === 'revise') return `round ${cutRound(job)}`;
  return job.runKind === 'render' ? 'approved' : '';
}

/** The grey text on the right of an editing row: "round 2 · ~4 min left", "approved", "~4 min left" or "". */
export function editingDetail(job: Pick<Job, 'runKind' | 'round' | 'etaSec'>): string {
  return [runKindDetail(job), eta(job.etaSec)].filter((part) => part !== '').join(SEPARATOR);
}

/** What `listDetail` reads from a job. */
export type ListDetailJob = StatusDetailJob &
  Pick<Job, 'step' | 'subProgress' | 'runKind' | 'etaSec' | 'fixing' | 'fixedCount'>;

/** The parts that are not empty, joined with the middle dot. */
function joinParts(parts: readonly string[]): string {
  return parts.filter((part) => part !== '').join(SEPARATOR);
}

/** "Failed at Render": the word, a space, the step it stopped at; the bare word without a step. */
function wordAtStep(word: string, step: Job['failedAt']): string {
  return step === null ? word : `${word} ${atStep(step)}`;
}

/**
 * The one line of detail a job's row has after its name on the Jobs page (the quiet list). Every
 * state reads in the same shape, what it is and then what is worth knowing about it, and there is
 * no frame size anywhere:
 * - arriving: "Arriving · settles in 0:42" (see `statusDetail`); "Arriving" with no settle time
 * - queued: "Queued · #2 in line"; "Queued" with no place in line
 * - held: "Held"
 * - editing: the step, then the run: "Cut · graphics 2/5 · ~4 min left", "Plan · round 2 · ~4 min
 *   left", "Render · approved · ~3 min left", "Transcribe" when there is nothing more to say;
 *   "Editing" with no step
 * - review: "Ready to review · 0:44" (the preview's length), then " · round 2" once notes were
 *   sent; "Ready to review" with no preview. With Quick fixes, a fix under way says so instead,
 *   "Review · fixing a note at 0:12…", and a round with notes fixed here says how many, "Review ·
 *   cut 2 · 1 fixed here" (board QFEffort, "The Jobs list while a fix runs"; the job stays in
 *   Review and only this line changes)
 * - ready: "0:30 · 27 MB" (the export's length and file size); "Approved" with no export record
 * - failed: "Failed at Render"; "Failed" with no step
 * - cancelled: "Cancelled at Plan"; "Cancelled" with no step
 *
 * `now` is a parameter so the result is a pure function of its inputs.
 */
export function listDetail(job: ListDetailJob, now: TimeInput): string {
  switch (job.state) {
    case 'arriving':
      return joinParts(['Arriving', statusDetail(job, now)]);
    case 'queued':
      return joinParts(['Queued', statusDetail(job, now)]);
    case 'held':
      return 'Held';
    case 'editing': {
      const step = stepLabel(job);
      return step === '' ? 'Editing' : joinParts([step, editingDetail(job)]);
    }
    case 'review': {
      // Quick fixes: what the fixes of this round are doing outranks the usual line.
      if (job.fixing !== null) {
        // The note's time is rounded down, as Review labels it (`noteTime`): 12.9 s is "0:12".
        return joinParts(['Review', `fixing a note at ${clock(Math.floor(job.fixing.atSec))}…`]);
      }
      if (job.fixedCount > 0) {
        return joinParts(['Review', `cut ${cutRound(job)}`, `${job.fixedCount} fixed here`]);
      }
      const { preview } = job;
      if (preview === null) return 'Ready to review';
      return joinParts([
        'Ready to review',
        clock(preview.durationSec),
        job.round > 0 ? `round ${cutRound(job)}` : '',
      ]);
    }
    case 'ready': {
      const { output } = job;
      if (output === null) return 'Approved';
      return joinParts([clock(output.durationSec), fileSize(output.sizeBytes)]);
    }
    case 'failed':
      return wordAtStep('Failed', job.failedAt);
    case 'cancelled':
      return wordAtStep('Cancelled', job.stoppedAt);
  }
}

const INPUT_NOUNS: Record<keyof InputCounts, readonly [singular: string, plural: string]> = {
  video: ['video clip', 'video clips'],
  audio: ['audio file', 'audio files'],
  image: ['image', 'images'],
  doc: ['document', 'documents'],
};

/** Tooltip for one input icon: "14 video clips", "1 audio file", "0 images", "1 document". */
export function inputTooltip(type: keyof InputCounts, n: number): string {
  const [singular, plural] = INPUT_NOUNS[type];
  return `${n} ${n === 1 ? singular : plural}`;
}

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });
const INITIAL_CHARACTER = /[\p{L}\p{N}\p{Extended_Pictographic}\p{Regional_Indicator}]/u;

/** The first letter, digit or emoji of a word, skipping leading punctuation; "" if it has none. */
function firstInitial(word: string): string {
  for (const { segment } of graphemes.segment(word)) {
    if (INITIAL_CHARACTER.test(segment)) return segment;
  }
  return '';
}

/**
 * The avatar letters for a client: the first character of the first two words, upper-cased
 * ("Arc Fitness" → "AF", "arc fitness" → "AF", "מאפיית הצפון" → "מה"). One word gives one letter.
 * Words are split on whitespace; a word with no letter, digit or emoji (the "&" in "Fish & Chips")
 * is skipped, and an emoji or a letter with its combining marks counts as one character.
 * "" when the name has nothing to take.
 */
export function initials(client: string): string {
  const letters: string[] = [];
  for (const word of client.split(/\s+/u)) {
    const letter = firstInitial(word);
    if (letter === '') continue;
    letters.push(letter.toUpperCase());
    if (letters.length === 2) break;
  }
  return letters.join('');
}

/**
 * A hue (0–359) for a client's avatar, generated from its name: the same client always gets the
 * same colour, whatever the case or surrounding spaces ("Arc Fitness" and " arc fitness " match).
 * A 32-bit FNV-1a hash of the name, taken modulo 360.
 */
export function clientHue(client: string): number {
  let hash = 0x811c9dc5;
  for (const char of client.trim().normalize('NFC').toLowerCase()) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 360;
}
