import {
  type AnalyticsCredits,
  type AnalyticsPlan,
  type AnalyticsSpendList,
  type AnalyticsSpendRow,
  API_CREDITS_START,
} from '@studio/shared';

// What the two budget cards and the two "what used it" lists draw, worked out from the answer so
// the cards themselves are only layout: the words, the figures and the order of the rows.
// Pure functions.

const MONTHS_SHORT = [
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
];

const MONTHS_FULL = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** The month of a day written YYYY-MM-DD, in full ("August"); `null` for a day that is not one. */
export function monthName(day: string): string | null {
  return MONTHS_FULL[Number(day.slice(5, 7)) - 1] ?? null;
}

/** A day as "30 Oct". */
export function dayMonth(day: string): string {
  const month = MONTHS_SHORT[Number(day.slice(5, 7)) - 1];
  return month === undefined ? day : `${Number(day.slice(8, 10))} ${month}`;
}

/** Dollars as the board writes them: "$470", "$39", "$3.41", "$0.06", "$1,036", "$0.00". */
export function usdText(value: number): string {
  if (value >= 10) return `$${Math.round(value).toLocaleString('en-US')}`;
  return `$${value.toFixed(2)}`;
}

/** Dollars and cents, always: a price such as "$11.50". */
function priceText(value: number): string {
  return `$${value.toFixed(2)}`;
}

/** A share of a total as a percent: "75%", "6.8%", "2.2%", "<0.5%", "0%". */
export function shareText(share: number): string {
  const percent = share * 100;
  if (percent <= 0) return '0%';
  if (percent < 0.5) return '<0.5%';
  if (percent < 10) return `${percent.toFixed(1)}%`;
  return `${Math.round(percent)}%`;
}

const whole = (share: number) => `${Math.round(share * 100)}%`;

// --- the chips ----------------------------------------------------------------------------------

/** How a status chip is tinted: `warn` amber, `bad` red, `good` green. */
export type ChipTone = 'warn' | 'bad' | 'good';
export interface Chip {
  label: string;
  tone: ChipTone;
}

/** A use at or above this share of the weekly limit is "Near the limit". */
export const NEAR_THE_LIMIT = 0.8;

// --- the stats beside a gauge -------------------------------------------------------------------

/** A line of figures beside a gauge: a small label, the figure and a note under it. */
export interface Stat {
  label: string;
  value: string;
  note: string | null;
  /** Draw the value in the warning colour. */
  warn?: boolean;
}

/** What a gauge card draws on the left: the number in the middle, a caption, the arc and the tick. */
export interface GaugeView {
  percent: string;
  caption: string;
  /** The share used, 0 to 1 (more when over). */
  used: number;
  /** How much of the month or week has passed, 0 to 1; `null` for no tick. */
  tick: number | null;
  tickLabel: string | null;
  ariaLabel: string;
}

// --- API credits --------------------------------------------------------------------------------

export interface CreditsView {
  subtitle: string;
  chip: Chip | null;
  gauge: GaugeView;
  stats: Stat[];
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** What the credits card draws. */
export function creditsView(credits: AnalyticsCredits): CreditsView {
  const month = monthName(credits.monthStart) ?? '';
  const chip: Chip | null =
    credits.status === 'spending-fast'
      ? { label: 'Spending fast', tone: 'warn' }
      : credits.status === 'used-up'
        ? { label: 'Used up', tone: 'bad' }
        : credits.status === 'on-pace'
          ? { label: 'On pace', tone: 'good' }
          : null;

  const gone = whole(credits.monthShare);
  const gauge: GaugeView = {
    percent: whole(credits.usedShare),
    caption: `${usdText(credits.spentUsd)} of ${usdText(credits.budgetUsd)}`,
    used: credits.usedShare,
    tick: credits.monthShare,
    tickLabel: `${gone} of the month gone`,
    ariaLabel: `API credits used: ${whole(credits.usedShare)}`,
  };

  const left: Stat = {
    label: 'Left',
    value: usdText(credits.leftUsd),
    note:
      credits.leftUsd <= 0
        ? 'nothing left until the credits reset on the 1st'
        : credits.firstPasses >= 1
          ? `about ${credits.firstPasses} more first ${credits.firstPasses === 1 ? 'pass' : 'passes'} at ${priceText(credits.firstPassUsd)} each`
          : `less than one first pass at ${priceText(credits.firstPassUsd)}`,
  };

  const sinceSwitch = credits.since === API_CREDITS_START;
  const spending: Stat = {
    label: 'Spending',
    value: credits.perDayUsd === null ? 'Nothing yet' : `${usdText(credits.perDayUsd)} a day`,
    note: sinceSwitch
      ? `since ${dayMonth(credits.since)}, when the app moved to the API key`
      : `since ${dayMonth(credits.since)}, the start of the month`,
  };

  const daysLeft = credits.monthDays - credits.nowX;
  const projected =
    credits.perDayUsd === null
      ? null
      : credits.spentUsd + credits.perDayUsd * Math.max(0, daysLeft);
  const pace: Stat =
    credits.status === 'used-up'
      ? {
          label: 'At this pace',
          value: 'used up',
          note: 'the credits reset on the 1st',
          warn: true,
        }
      : credits.runOutDay !== null && credits.runOutDaysBeforeEnd !== null
        ? {
            label: 'At this pace',
            value: `runs out about ${dayMonth(credits.runOutDay)}`,
            note:
              credits.runOutDaysBeforeEnd === 1
                ? 'a day before the month ends'
                : `${credits.runOutDaysBeforeEnd} days before the month ends`,
            warn: true,
          }
        : {
            label: 'At this pace',
            value: credits.status === 'idle' ? 'nothing spent yet' : 'lasts the month',
            note: projected === null ? null : `about ${usdText(projected)} by the end of the month`,
          };

  return {
    subtitle: `The app’s own runs: edits, re-edits, renders · ${month}`,
    chip,
    gauge,
    stats: [left, spending, pace],
  };
}

// --- Max plan -----------------------------------------------------------------------------------

export interface PlanView {
  subtitle: string;
  chip: Chip | null;
  gauge: GaugeView;
  /** The five-hour window's bar; `null` when no reading has an open one. */
  fiveHour: { percent: string; share: number } | null;
  stats: Stat[];
  /** The card has no reading for this week: the gauge is empty and says so. */
  empty: boolean;
}

function formatIn(iso: string, timeZone: string, options: Intl.DateTimeFormatOptions): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '–';
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone, hour12: false, ...options }).format(date);
  } catch {
    return '–';
  }
}

/** When the window resets: "Sat 21:00". */
export function resetText(iso: string, timeZone: string): string {
  return formatIn(iso, timeZone, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

/** When a reading was taken: "23 Oct, 12:09". */
export function readingText(iso: string, timeZone: string): string {
  return formatIn(iso, timeZone, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** How long before `nowIso` a moment was: "just now", "3 minutes ago", "2 hours ago", "2 days ago". */
export function agoText(iso: string, nowIso: string): string {
  const minutes = Math.max(0, Math.floor((Date.parse(nowIso) - Date.parse(iso)) / 60_000));
  if (Number.isNaN(minutes)) return '';
  if (minutes < 2) return 'just now';
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${plural(hours, 'hour', 'hours')} ago`;
  return `${plural(Math.floor(hours / 24), 'day', 'days')} ago`;
}

/** A reading this old, at the time the answer was worked out, is one the page asks the engine to renew. */
export const READING_STALE_MS = 10 * 60_000;

/** Whether the plan's newest reading is older than {@link READING_STALE_MS} when the answer was made. */
export function planReadingIsStale(
  plan: Pick<AnalyticsPlan, 'lastReadingAt'>,
  generatedAt: string,
): boolean {
  if (plan.lastReadingAt === null) return true;
  return Date.parse(generatedAt) - Date.parse(plan.lastReadingAt) > READING_STALE_MS;
}

/** What the plan card draws. */
export function planView(plan: AnalyticsPlan, generatedAt: string, timeZone: string): PlanView {
  const week = plan.week;
  const reading: Stat = {
    label: 'Last reading',
    value: plan.lastReadingAt === null ? 'None yet' : readingText(plan.lastReadingAt, timeZone),
    note:
      plan.lastReadingAt === null
        ? 'the plan is read when this page is opened'
        : agoText(plan.lastReadingAt, generatedAt),
  };
  const covered: Stat = {
    label: week === null ? 'Covered, last 7 days' : 'Covered this week',
    value: `${usdText(plan.coveredUsd)} of API value`,
    note: `for a ${usdText(plan.monthlyUsd)}-a-month plan, about ${usdText(plan.weeklyUsd)} a week`,
  };

  if (week === null) {
    return {
      subtitle: 'Your Claude Code sessions',
      chip: null,
      gauge: {
        percent: '–',
        caption: 'no reading for this week yet',
        used: 0,
        tick: null,
        tickLabel: null,
        ariaLabel: 'Weekly plan limit: no reading for this week yet',
      },
      fiveHour: null,
      stats: [covered, reading],
      empty: true,
    };
  }

  const chip: Chip | null =
    week.utilization >= 1 ||
    (plan.status !== null && !['allowed', 'allowed_warning'].includes(plan.status))
      ? { label: 'Limit reached', tone: 'bad' }
      : week.utilization >= NEAR_THE_LIMIT
        ? { label: 'Near the limit', tone: 'warn' }
        : null;

  return {
    subtitle: `Your Claude Code sessions · resets ${resetText(week.resetsAt, timeZone)}`,
    chip,
    gauge: {
      percent: whole(week.utilization),
      caption: 'of the weekly limit',
      used: week.utilization,
      tick: week.weekShare,
      tickLabel: `${whole(week.weekShare)} of the week gone`,
      ariaLabel: `Weekly plan limit used: ${whole(week.utilization)}`,
    },
    fiveHour:
      plan.fiveHour === null
        ? null
        : { percent: whole(plan.fiveHour.utilization), share: plan.fiveHour.utilization },
    stats: [covered, reading],
    empty: false,
  };
}

// --- "what used it" lists -----------------------------------------------------------------------

/** One row of a list. */
export interface SpendRowView {
  label: string;
  /** The bar's width as a share of the biggest row of its group, 0 to 100. */
  barPercent: number;
  usd: string;
  share: string;
  /** The last column, its slice of the budget: "≈ 12% of credits", "≈ 44% of limit". */
  extra: string;
  /** Nothing used it: drawn faded, with "nothing yet" for a bar. */
  nothing: boolean;
}

/** The "N smaller tags" row and what opens under it. */
export interface FoldView {
  title: string;
  preview: string;
  rows: SpendRowView[];
}

export interface SpendListView {
  rows: SpendRowView[];
  fold: FoldView | null;
  /** Nothing was spent: the card says so instead of listing rows. */
  empty: boolean;
}

/** What the last column is a slice of: the month's API credits, or the plan's weekly limit. */
export type ExtraKind = 'credits' | 'limit';

function sliceText(slice: number | null, kind: ExtraKind): string {
  if (slice === null || slice <= 0) return '';
  return slice * 100 < 0.5 ? `< 1% of ${kind}` : `≈ ${Math.round(slice * 100)}% of ${kind}`;
}

function rowView(row: AnalyticsSpendRow, top: number, extra: ExtraKind): SpendRowView {
  return {
    label: row.label,
    barPercent: top > 0 ? Math.round((row.usd / top) * 1000) / 10 : 0,
    usd: usdText(row.usd),
    share: shareText(row.share),
    extra: sliceText(row.limitShare, extra),
    nothing: row.usd <= 0,
  };
}

const PREVIEW_NAMES = 4;

/**
 * A list as the cards draw it: the rows that are big enough, biggest first, with bars as long as
 * their spend next to the biggest; and, when some are small, one "N smaller tags" row that opens
 * to them (their bars next to the biggest of them). `noun` is "tag"; a list of jobs has no fold.
 */
export function spendListView(
  list: AnalyticsSpendList,
  options: { noun?: string; extra: ExtraKind },
): SpendListView {
  const noun = options.noun ?? 'tag';
  const top = list.rows[0]?.usd ?? 0;
  const rows = list.rows.map((row) => rowView(row, top, options.extra));
  const foldTop = list.folded[0]?.usd ?? 0;
  const fold: FoldView | null =
    list.folded.length === 0
      ? null
      : {
          title: `${list.folded.length} smaller ${noun}${list.folded.length === 1 ? '' : 's'} · ${shareText(list.foldedShare)}`,
          preview: `${list.folded
            .slice(0, PREVIEW_NAMES)
            .map((row) => row.label)
            .join(', ')}${list.folded.length > PREVIEW_NAMES ? ' …' : ''}`,
          rows: list.folded.map((row) => rowView(row, foldTop, options.extra)),
        };
  return { rows, fold, empty: list.totalUsd <= 0 };
}

const CREDIT_WORDS: Readonly<Record<string, string>> = {
  revise: 'Re-edits',
  edit: 'First edits',
  render: 'Renders',
};

/** The line under the credits list when one tag took most of it ("Re-edits took 75%."); else `null`. */
export function creditsSummary(tags: AnalyticsSpendList): string | null {
  const top = tags.rows[0];
  if (top === undefined || top.share < 0.5) return null;
  return `${CREDIT_WORDS[top.label] ?? `The ${top.label} runs`} took ${whole(top.share)}.`;
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The line under the plan list: the two biggest tags and what they used, and how a slice is worked out. */
export function planSummary(plan: AnalyticsPlan): string | null {
  const [first, second] = plan.tags.rows;
  if (first === undefined) return null;
  const week = plan.week;
  if (week === null) {
    return 'There is no reading of the plan for this week yet, so the list shows the last 7 days of sessions without a share of the limit.';
  }
  const both = first.share + (second?.share ?? 0);
  const names = second === undefined ? first.label : `${first.label} and ${second.label}`;
  const used = whole(both * week.utilization);
  return `${capitalize(names)} alone used about ${used} of this week’s limit. Each tag’s slice is its share of session use, times the ${whole(week.utilization)} the plan reports.`;
}
