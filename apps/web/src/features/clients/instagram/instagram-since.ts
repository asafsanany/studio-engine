// "Working together since", the day field of the Instagram dialog (board CLStates S1): it shows a
// day the way the rest of the section writes one ("1 Aug 2026") and reads what is typed in the
// same words, as YYYY-MM-DD ("2026-08-01") or day first with slashes ("1/8/2026", as the Mac writes
// it). Pure functions; nothing here reads the clock.

import { isCalendarDay } from '@studio/shared';
import { MONTHS } from './instagram-text';

const FULL_MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
] as const;

/** "1 Aug 2026": a calendar day (YYYY-MM-DD) as the field shows it, with its year; "" when it is no day. */
export function sinceDayText(day: string): string {
  if (!isCalendarDay(day)) return '';
  return `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`;
}

/** What the field holds: nothing, a real calendar day (YYYY-MM-DD), or text that is no day. */
export type SinceReading = { kind: 'empty' } | { kind: 'day'; day: string } | { kind: 'invalid' };

/** The month a word names ("aug", "August", "sept"), 1 to 12, or `null`. A word needs three letters. */
function monthOf(word: string): number | null {
  const name = word.toLowerCase();
  if (name.length < 3) return null;
  const index = FULL_MONTHS.findIndex((month) => month.startsWith(name));
  return index === -1 ? null : index + 1;
}

function dayOf(year: string, month: number, date: string): string | null {
  const day = `${year}-${String(month).padStart(2, '0')}-${date.padStart(2, '0')}`;
  return isCalendarDay(day) ? day : null;
}

const ISO_DAY = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
const DAY_FIRST = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/;
const DAY_MONTH_NAME = /^(\d{1,2}) ([a-z]+),? (\d{4})$/i;

/** The day the text says, YYYY-MM-DD, or `null` when it says none. */
function dayIn(typed: string): string | null {
  const iso = ISO_DAY.exec(typed);
  if (iso) return dayOf(iso[1] ?? '', Number(iso[2]), iso[3] ?? '');
  const dayFirst = DAY_FIRST.exec(typed);
  if (dayFirst) return dayOf(dayFirst[3] ?? '', Number(dayFirst[2]), dayFirst[1] ?? '');
  const named = DAY_MONTH_NAME.exec(typed);
  if (!named) return null;
  const month = monthOf(named[2] ?? '');
  return month === null ? null : dayOf(named[3] ?? '', month, named[1] ?? '');
}

/** The field's text as a day: "1 Aug 2026", "1 August 2026", "2026-08-01" and "1/8/2026" (also with dots or dashes). */
export function readSinceText(text: string): SinceReading {
  const typed = text.trim().replace(/\s+/g, ' ');
  if (typed === '') return { kind: 'empty' };
  const day = dayIn(typed);
  return day === null ? { kind: 'invalid' } : { kind: 'day', day };
}
