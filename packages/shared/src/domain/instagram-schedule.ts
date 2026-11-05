// When the weekly Instagram scan is due (Clients × Instagram, IG4): every Monday at 06:00 local
// time. Pure functions, in shared code so that the engine (which scans) and the page (which says
// "next scan Mon 2 Nov") use the same week.
//
// "Local" is a time zone passed in (the Mac's, `Intl.DateTimeFormat().resolvedOptions().timeZone`),
// never the process's own, so a test can name any zone. The week is read off the wall clock of that
// zone, so Monday 06:00 is Monday 06:00 on both sides of a daylight-saving change, even though the
// weeks around the change are 167 or 169 hours long (Asia/Jerusalem: 27 March and 25 October 2026).
//
//   scanCutoff(now, tz)  the latest Monday 06:00 at or before `now`: a client whose last scan
//                        started before it is due
//   nextScanAt(now, tz)  the first Monday 06:00 after `now`: what the page announces

/** Monday, in `Date#getUTCDay` terms (Sunday is 0). */
const MONDAY = 1;
/** The hour of the day, local time, the weekly scan is due from. */
export const SCAN_HOUR = 6;

/** A time as the engine passes it around: a `Date`, or milliseconds since the epoch. */
export type ScheduleTime = Date | number;

const msOf = (time: ScheduleTime): number => (typeof time === 'number' ? time : time.getTime());

/** A calendar day, month 1 to 12. */
interface CalendarDay {
  year: number;
  month: number;
  day: number;
}

/** The wall clock of a zone at an instant. */
interface WallClock extends CalendarDay {
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** One formatter per zone, `hourCycle: 'h23'` so that midnight is 0 and not 24. Throws on a zone that does not exist. */
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** What the clock on the wall of `timeZone` shows at the instant `ms`. */
function wallClockAt(ms: number, timeZone: string): WallClock {
  const parts: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year as number,
    month: parts.month as number,
    day: parts.day as number,
    hour: parts.hour as number,
    minute: parts.minute as number,
    second: parts.second as number,
  };
}

/** How far the wall clock of `timeZone` is ahead of UTC at the instant `ms`, in milliseconds. */
function offsetAt(ms: number, timeZone: string): number {
  const wall = wallClockAt(ms, timeZone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  // The formatter drops the milliseconds, so compare with the instant cut to the second.
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant at which the wall clock of `timeZone` shows `hour`:00 on `day`. Where that time
 * happens twice (the clocks go back) the first one is taken. Where it does not happen (the clocks
 * go forward) an instant close to the jump is taken: nobody schedules a Monday morning there.
 */
function instantOf(day: CalendarDay, hour: number, timeZone: string): number {
  const wall = Date.UTC(day.year, day.month - 1, day.day, hour, 0, 0);
  // The offset in force at the answer is not known before the answer, so try the one at the wall
  // time read as an instant, then the one at that guess, and settle when the two agree.
  const guess = wall - offsetAt(wall, timeZone);
  const refined = wall - offsetAt(guess, timeZone);
  if (refined === guess) return guess;
  const settled = wall - offsetAt(refined, timeZone);
  return settled === refined ? refined : Math.min(guess, refined);
}

/** `day` moved by `days` whole calendar days (negative: back). */
function addDays(day: CalendarDay, days: number): CalendarDay {
  const moved = new Date(Date.UTC(day.year, day.month - 1, day.day + days));
  return { year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: moved.getUTCDate() };
}

/** The Monday of the week `day` is in (a Monday is its own). Weeks run Monday to Sunday. */
function mondayOf(day: CalendarDay): CalendarDay {
  const weekday = new Date(Date.UTC(day.year, day.month - 1, day.day)).getUTCDay();
  return addDays(day, -((weekday + 7 - MONDAY) % 7));
}

/** The Monday on or before `now` whose 06:00 is at or before `now`, as a calendar day of `timeZone`. */
function cutoffDay(now: number, timeZone: string): CalendarDay {
  const monday = mondayOf(wallClockAt(now, timeZone));
  // Monday before 06:00 is still last week's scan week.
  return instantOf(monday, SCAN_HOUR, timeZone) <= now ? monday : addDays(monday, -7);
}

/**
 * The latest Monday 06:00, local time in `timeZone`, at or before `now`: the start of the scan
 * week. A client whose last scan started before it is due. Throws a `RangeError` for a time zone
 * that does not exist.
 */
export function scanCutoff(now: ScheduleTime, timeZone: string): Date {
  const ms = msOf(now);
  return new Date(instantOf(cutoffDay(ms, timeZone), SCAN_HOUR, timeZone));
}

/**
 * The first Monday 06:00, local time in `timeZone`, after `now`: when the next weekly scan is due
 * (the page says "next scan Mon 2 Nov"). Exactly at a Monday 06:00 it is the one a week on.
 */
export function nextScanAt(now: ScheduleTime, timeZone: string): Date {
  const ms = msOf(now);
  return new Date(instantOf(addDays(cutoffDay(ms, timeZone), 7), SCAN_HOUR, timeZone));
}
