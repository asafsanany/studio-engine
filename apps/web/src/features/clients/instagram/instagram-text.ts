// What the Instagram section writes, as pure functions: numbers, days and the words for a range.
// The views (head-view, tiles-view, plays-view, engagement-view) and the components only lay these
// out. Nothing here reads the clock or the locale on its own: a day is written from a time zone
// (the system's when none is given) and "this year" from `now`, so a test can pin both.

import { type InstagramNumbers, type InstagramRange, localDayOf, weekdayOf } from '@studio/shared';

/** What a number that is not known yet shows. */
export const NO_NUMBER = '—';

/** Middle dot with spaces, as the rest of the app separates facts. */
export const SEPARATOR = ' · ';

/** The minus sign (U+2212), as the Money and Analytics pages write a drop. */
const MINUS = '−';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
export const MONTHS = [
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

/** The time zone and the moment the words are written for; both default to the viewer's. */
export interface TextOptions {
  /** An IANA name such as "Asia/Jerusalem". Default: the system's zone. */
  timeZone?: string;
  /** Milliseconds since the epoch. Default: now. Only decides whether a day names its year. */
  now?: number;
}

/** The labels of the three ranges, in the order the switch shows them. */
export const RANGE_LABELS: Record<InstagramRange, string> = {
  since: 'Since us',
  '90': '90 days',
  '30': '30 days',
};

/** A whole number with a thousands separator: "12,480". */
export function countText(count: number): string {
  return Math.round(count).toLocaleString('en-US');
}

function trimZero(text: string): string {
  return text.replace(/\.0$/, '');
}

/** Plays and likes the short way: "980", "18.4K", "410K", "1.2M". */
export function compactText(count: number): string {
  const n = Math.round(count);
  if (n < 1000) return String(n);
  if (n < 999_500) {
    const thousands = n / 1000;
    return `${thousands < 100 ? trimZero(thousands.toFixed(1)) : Math.round(thousands)}K`;
  }
  return `${trimZero((n / 1_000_000).toFixed(1))}M`;
}

/** A reel's plays the short way, with the word: "980 plays", "27.5K plays", "1 play". */
export function playsText(plays: number): string {
  return `${compactText(plays)} ${Math.round(plays) === 1 ? 'play' : 'plays'}`;
}

/** A change with its sign: "+312", "−42", and "0" for none. */
export function signedText(change: number): string {
  const n = Math.round(change);
  if (n === 0) return '0';
  return `${n > 0 ? '+' : MINUS}${countText(Math.abs(n))}`;
}

/** A multiple of something, to one decimal: "3.6×", "0.8×", "12×" from ten up. */
export function timesText(multiple: number): string {
  return `${multiple < 10 ? multiple.toFixed(1) : Math.round(multiple)}×`;
}

/** The system's time zone, which is where the viewer reads the days. */
function systemZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The calendar day an instant falls on in the zone, YYYY-MM-DD; "" when `iso` is not a time. */
export function localDay(iso: string, options: TextOptions = {}): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  return localDayOf(ms, options.timeZone ?? systemZone());
}

const timeFormatters = new Map<string, Intl.DateTimeFormat>();

/** "19:40": the time of day an instant falls on in the zone, on a 24 hour clock; "" when `iso` is not a time. */
export function timeText(iso: string, options: TextOptions = {}): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const timeZone = options.timeZone ?? systemZone();
  let formatter = timeFormatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      numberingSystem: 'latn',
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
    });
    timeFormatters.set(timeZone, formatter);
  }
  let hour = '';
  let minute = '';
  for (const part of formatter.formatToParts(ms)) {
    if (part.type === 'hour') hour = part.value;
    else if (part.type === 'minute') minute = part.value;
  }
  return `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
}

/** "Mon 26 Oct": a calendar day (YYYY-MM-DD) with its weekday; "" when it is not a day. */
export function dayText(day: string): string {
  if (!CALENDAR_DAY.test(day)) return '';
  const weekday = WEEKDAYS[weekdayOf(day)] ?? '';
  return `${weekday} ${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1] ?? ''}`;
}

/** "Mon 26 Oct": the day an instant falls on, in the viewer's zone; "" when it is not a time. */
export function instantDayText(iso: string, options: TextOptions = {}): string {
  return dayText(localDay(iso, options));
}

/** "3 Aug", or "3 Aug 2025" for a day of another year than `now`'s. */
export function shortDayText(day: string, options: TextOptions = {}): string {
  if (!CALENDAR_DAY.test(day)) return '';
  const text = `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1] ?? ''}`;
  const zone = options.timeZone ?? systemZone();
  const thisYear = localDayOf(options.now ?? Date.now(), zone).slice(0, 4);
  return day.slice(0, 4) === thisYear ? text : `${text} ${day.slice(0, 4)}`;
}

/** "Aug": the month of a calendar day (YYYY-MM-DD); "" when it is not a day. */
export function monthText(day: string): string {
  return CALENDAR_DAY.test(day) ? (MONTHS[Number(day.slice(5, 7)) - 1] ?? '') : '';
}

/**
 * The range as a phrase for a subtitle: "since us (3 Aug)" names the day since us starts on,
 * "last 90 days", "last 30 days".
 */
export function rangeWords(
  numbers: Pick<InstagramNumbers, 'range' | 'sinceUs'>,
  options: TextOptions = {},
): string {
  if (numbers.range === 'since') return `since us (${shortDayText(numbers.sinceUs, options)})`;
  return `last ${numbers.range} days`;
}

/** The first letter in capitals: "since us (3 Aug)" at the start of a subtitle. */
export function sentenceCase(text: string): string {
  return text === '' ? text : `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** "1 reel", "22 reels". */
export function reelsText(count: number): string {
  return `${countText(count)} ${count === 1 ? 'reel' : 'reels'}`;
}
