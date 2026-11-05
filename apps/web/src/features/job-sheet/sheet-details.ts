// What the job sheet's Details part says, as plain rows (design canvas page "Job sheet", board
// JSSheet): money, video, file, inputs, added and folder, each only when the job has a value for it.
// Pure: the clock and the time zone are parameters, so a test pins both. The shared formatters do
// the sizes, durations, frame sizes, prices and delivery days; what they do not have (the inputs
// line, "Today, 13:01", the history's "13:01" or "21 Oct") is here, and History reuses it.

import {
  clock,
  fileSize,
  type InputCounts,
  inputTooltip,
  type Job,
  jobStage,
  type MusicView,
  paidAmountOf,
  resolution,
  type TimeInput,
} from '@studio/shared';
import {
  deliveredDay,
  formatPrice,
  isPriced,
  type PricedDelivery,
  paidDay,
  postedDay,
} from '@/features/jobs/delivery-text';
import { type InstagramRowLinks, instagramRow, type SheetInstagram } from './sheet-instagram';
import { musicDetailRow } from './sheet-music';

/** The middle dot the rows separate their parts with. */
const SEPARATOR = ' · ';

/** Where the exports are shown: the export's path in the job is relative to this folder. */
export const EXPORTS_FOLDER = '_Exports';
/** Where the job folders are shown: a job's `relPath` is relative to this folder. */
export const INBOX_FOLDER = 'Studio Inbox';

export type DetailLabel =
  | 'Money'
  | 'Video'
  | 'File'
  | 'Inputs'
  | 'Music'
  | 'Added'
  | 'Folder'
  | 'Effort'
  | 'Steps'
  | 'Approved'
  | 'Delivered'
  | 'Posted'
  | 'On Instagram'
  | 'Price'
  | 'Paid'
  | 'Amount paid';

export interface DetailRow {
  label: DetailLabel;
  value: string;
  /** Paths are shown in the muted colour; the other values in the normal one. */
  muted: boolean;
  /** A second line under the value, always muted and a little smaller (the Music row's). */
  sub?: string;
  /** `failure` shows the value in the failure colour (red), as the Music row does for music that could not be made. */
  tone?: 'failure';
  /** The On Instagram row's links ("Open reel", the client's page), which the sheet draws in its text. */
  instagram?: InstagramRowLinks;
}

// --- inputs -------------------------------------------------------------------------------------

const INPUT_TYPES = [
  'video',
  'audio',
  'image',
  'doc',
] as const satisfies readonly (keyof InputCounts)[];

/**
 * The kinds of file a job folder holds, each with its count and noun, in the order video, audio,
 * image, document, leaving out the kinds that have none: "8 video clips", "1 audio file", ...
 */
export function inputParts(inputs: InputCounts): string[] {
  return INPUT_TYPES.filter((type) => inputs[type] > 0).map((type) =>
    inputTooltip(type, inputs[type]),
  );
}

/**
 * The inputs as one line: "8 video clips · 1 audio file · 3 images". The Details row joins with
 * the middle dot, the history's "Settled: 3 video clips, 2 images" with a comma. "" for no files.
 */
export function inputsText(inputs: InputCounts, separator: string = SEPARATOR): string {
  return inputParts(inputs).join(separator);
}

// --- days and times -----------------------------------------------------------------------------

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

interface LocalParts {
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

function toMs(time: TimeInput): number {
  if (time instanceof Date) return time.getTime();
  return typeof time === 'number' ? time : Date.parse(time);
}

/** The wall clock of an instant in `timeZone` (an IANA name) or, without one, the browser's own. */
function localParts(time: TimeInput, timeZone: string | undefined): LocalParts | null {
  const ms = toMs(time);
  if (!Number.isFinite(ms)) return null;
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
  const result: LocalParts = { year: 0, month: 0, day: 0, hour: 0, minute: 0 };
  for (const part of formatterFor(timeZone).formatToParts(ms)) {
    if (
      part.type === 'year' ||
      part.type === 'month' ||
      part.type === 'day' ||
      part.type === 'hour' ||
      part.type === 'minute'
    ) {
      result[part.type] = Number(part.value);
    }
  }
  // Some engines report midnight as 24 even with hourCycle h23.
  result.hour %= 24;
  return result;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

const clockOf = (p: LocalParts): string => `${pad2(p.hour)}:${pad2(p.minute)}`;
const dayOf = (p: LocalParts): string => `${p.day} ${MONTHS[p.month - 1]}`;
const dayNumber = (p: LocalParts): number =>
  Math.floor(Date.UTC(p.year, p.month - 1, p.day) / MS_PER_DAY);

/**
 * How many calendar days before `now` an instant is (0 is today; a time after `now`, from clock
 * skew, counts as today), or `null` when either cannot be read.
 */
function daysBefore(
  time: TimeInput,
  now: TimeInput,
  timeZone: string | undefined,
): { days: number; parts: LocalParts } | null {
  const parts = localParts(time, timeZone);
  const today = localParts(now, timeZone);
  if (parts === null || today === null) return null;
  return { days: Math.max(0, dayNumber(today) - dayNumber(parts)), parts };
}

/**
 * When the job was added: "Today, 13:01", "Yesterday, 16:19", or "21 Oct, 10:01" for any earlier
 * day. 24-hour clock, English month names. "" when a time cannot be read.
 */
export function addedText(iso: TimeInput, now: TimeInput, timeZone?: string): string {
  const found = daysBefore(iso, now, timeZone);
  if (found === null) return '';
  const { days, parts } = found;
  const day = days === 0 ? 'Today' : days === 1 ? 'Yesterday' : dayOf(parts);
  return `${day}, ${clockOf(parts)}`;
}

/**
 * The time of a history row: "13:01" for a moment today, "21 Oct" for any earlier day. "" when a
 * time cannot be read.
 */
export function historyTime(iso: TimeInput, now: TimeInput, timeZone?: string): string {
  const found = daysBefore(iso, now, timeZone);
  if (found === null) return '';
  return found.days === 0 ? clockOf(found.parts) : dayOf(found.parts);
}

// --- the rows -----------------------------------------------------------------------------------

/**
 * "₪40 · delivered 21 Oct · not paid" or "₪40 · delivered 21 Oct · paid 23 Oct", the amount of a
 * paid video being what was paid for it.
 */
function moneyText(delivery: PricedDelivery, timeZone: string | undefined): string {
  return [
    formatPrice(paidAmountOf(delivery), delivery.currency),
    `delivered ${deliveredDay(delivery, timeZone)}`,
    delivery.paidOn == null ? 'not paid' : `paid ${paidDay(delivery.paidOn)}`,
  ].join(SEPARATOR);
}

/**
 * The rows of the Details part, in order:
 * - Money: "₪40 · delivered 21 Oct · not paid", while the job is delivered, uploaded or paid
 *   (`jobStage`: a job that left ready keeps its delivery, and the Jobs page does not show it then
 *   either)
 * - Posted: "Tue 20 Oct", the day the reel linked to the job was posted, only while one is linked
 *   (with Clients × Instagram on, the On Instagram row below says it instead)
 * - On Instagram (`instagram` given, Clients × Instagram on, `instagramRow`): the linked reel's
 *   numbers with its day, or "No reel linked yet." for a delivered job, in Posted's place
 * - Video: "0:30 · 1080×1920 · 27 MB", from the export
 * - File: the export's path, "_Exports/Client/Job.mp4" (muted)
 * - Inputs: "8 video clips · 1 audio file · 3 images", with " so far" while the files still arrive
 * - Music: the job's music (Soundtrack, `musicDetailRow`), only while `music` is given
 * - Added: "Today, 13:01", "Yesterday, 16:19" or "21 Oct, 10:01"
 * - Folder: "Studio Inbox/Client/Job" (muted), only until there is an MP4
 *
 * A row is left out when it has no value (no delivery, no export, no files, no music).
 */
export function detailRows(
  job: Job,
  now: TimeInput,
  timeZone?: string,
  music?: MusicView | null,
  instagram?: SheetInstagram | null,
): DetailRow[] {
  const rows: DetailRow[] = [];
  const { delivery, output } = job;

  // An editor's job has no money, so it has no Money row.
  if (delivery !== null && isPriced(delivery) && jobStage(job) !== null) {
    rows.push({ label: 'Money', value: moneyText(delivery, timeZone), muted: false });
  }
  const onInstagram = instagramRow(job, instagram, timeZone);
  if (onInstagram !== null) {
    rows.push(onInstagram);
  } else if (delivery !== null && delivery.uploadedAt !== undefined && jobStage(job) !== null) {
    rows.push({ label: 'Posted', value: postedDay(delivery, timeZone), muted: false });
  }
  if (output !== null) {
    const video = [
      clock(output.durationSec),
      resolution(output.width, output.height),
      fileSize(output.sizeBytes),
    ].join(SEPARATOR);
    rows.push({ label: 'Video', value: video, muted: false });
    rows.push({ label: 'File', value: `${EXPORTS_FOLDER}/${output.fileName}`, muted: true });
  }
  const files = inputsText(job.inputs);
  if (files !== '') {
    rows.push({
      label: 'Inputs',
      value: job.state === 'arriving' ? `${files} so far` : files,
      muted: false,
    });
  }
  const musicRow = musicDetailRow(music);
  if (musicRow !== null) rows.push(musicRow);
  const added = addedText(job.addedAt, now, timeZone);
  if (added !== '') rows.push({ label: 'Added', value: added, muted: false });
  if (output === null) {
    rows.push({ label: 'Folder', value: `${INBOX_FOLDER}/${job.relPath}`, muted: true });
  }
  return rows;
}

// --- the phone's rows ---------------------------------------------------------------------------

/** What the phone's Paid row says while the video is delivered and not paid. */
export const NOT_PAID_YET_TEXT = 'Not yet';

/** The export's file name without its client folder: "RGM/Name.mp4" is "Name.mp4". */
function fileNameOf(output: NonNullable<Job['output']>): string {
  return output.fileName.slice(output.fileName.lastIndexOf('/') + 1);
}

/**
 * The phone sheet's Details for a finished job (boards MJobSheet, MJobSheetDelivered and
 * MJobSheetPaid, canvas page Mobile; the owner's call in CVP-277), or `null` for a job that is not
 * finished, which keeps `detailRows`:
 * - Approved: Steps ("All 8 steps done · 26 min of work", `stepsSummary`, left out until the steps
 *   are loaded), Inputs, Music (Soundtrack, while `music` is given), Approved ("Today, 13:58"), File
 *   ("Name.mp4")
 * - Delivered: Delivered ("Today, 12:10"), Price ("₪40"), Paid ("Not yet"), File
 * - Uploaded: the Delivered rows with Posted ("Tue 20 Oct") after Delivered, while a reel is linked
 *   (with Clients × Instagram on, the On Instagram row is there instead, and a delivered job no
 *   reel links has it too: "No reel linked yet.")
 * - Paid: Delivered ("19 Oct, 17:40"), Paid ("20 Oct"), Price, File (with Posted after Delivered
 *   when a reel is linked)
 *
 * Delivered and Paid have no Music row: their boards are the short money list the owner chose in
 * CVP-277 (exactly four rows, pinned by a test), and the Soundtrack boards add the row only to
 * Ready to review (the Mac's `detailRows`, which the phone uses there) and so to Approved. The
 * Mac's rows keep it for every stage.
 *
 * A row is left out when it has no value, as in `detailRows`.
 */
export function phoneDetailRows(
  job: Job,
  now: TimeInput,
  timeZone?: string,
  stepsSummary?: string | null,
  music?: MusicView | null,
  instagram?: SheetInstagram | null,
): DetailRow[] | null {
  const stage = jobStage(job);
  if (stage === null) return null;
  const rows: DetailRow[] = [];
  const push = (label: DetailLabel, value: string) => {
    if (value !== '') rows.push({ label, value, muted: false });
  };
  const { delivery, output } = job;
  const file = output === null ? '' : fileNameOf(output);

  if (stage === 'approved' || delivery === null) {
    push('Steps', stepsSummary ?? '');
    push('Inputs', inputsText(job.inputs));
    const musicRow = musicDetailRow(music);
    if (musicRow !== null) rows.push(musicRow);
    push('Approved', job.approvedAt === null ? '' : addedText(job.approvedAt, now, timeZone));
    push('File', file);
    return rows;
  }
  const delivered = addedText(delivery.deliveredAt, now, timeZone);
  const posted = delivery.uploadedAt === undefined ? '' : postedDay(delivery, timeZone);
  // Clients × Instagram: the On Instagram row takes the place of Posted (and of nothing, for a
  // delivered job no reel links yet).
  const onInstagram = instagramRow(job, instagram, timeZone);
  const pushPosted = () => {
    if (onInstagram !== null) rows.push(onInstagram);
    else push('Posted', posted);
  };
  if (!isPriced(delivery)) {
    // An editor's job has no money: no Price and no Paid row.
    push('Delivered', delivered);
    pushPosted();
    push('File', file);
    return rows;
  }
  const price = formatPrice(delivery.price, delivery.currency);
  if (delivery.paidOn == null) {
    push('Delivered', delivered);
    pushPosted();
    push('Price', price);
    push('Paid', NOT_PAID_YET_TEXT);
  } else {
    push('Delivered', delivered);
    pushPosted();
    push('Paid', paidDay(delivery.paidOn));
    push('Price', price);
    // What the client paid, when it is not the price (₪0 for a client who pays nothing for now).
    const amount = paidAmountOf(delivery);
    if (amount !== delivery.price) push('Amount paid', formatPrice(amount, delivery.currency));
  }
  push('File', file);
  return rows;
}
