import type { AnalyticsPeriod, AnalyticsTileKey } from '@studio/shared';

// The words of the Analytics page, as the design canvas (page "Analytics", board ANPage) has them:
// the three section headings with their one line, and the title and subtitle of every card (the
// two budgets of Claude use are from the board ANBudgets). Cards
// take them from here, so the page says each thing once.
//
// `ANALYTICS_TILE_COPY` and `ANALYTICS_CARDS` are the words of the month period (the board's); the
// week period says "7 days" for "30 days" and "day" for "week" (`tileCopy` and `cardCopy` pick the
// ones for a period).

export const ANALYTICS_SECTIONS = {
  jobs: { title: 'Jobs', subtitle: 'How much gets done and how long it takes' },
  reviews: {
    title: 'Reviews',
    subtitle: 'How often you approve first time, and what your notes are about',
  },
  claudeUse: {
    title: 'Claude use',
    subtitle:
      'Two budgets: API credits pay for the app’s own runs, and your Claude plan covers your Claude Code sessions',
  },
} as const;

/**
 * The Services section and its card (CLAUDE.md › APIs and services). Not on the design canvas's
 * board: The owner asked for it on 26 Oct. The card's subtitle also says the period.
 */
export const SERVICES_SECTION = {
  title: 'Services',
  subtitle: 'Every API the app uses, paid or free, and what the paid ones cost',
} as const;

export const SERVICES_CARD = {
  title: 'APIs and subscriptions',
  subtitle: 'What each is for, its plan in money.json and what it cost',
} as const;

/** The five tiles of the top row. */
export const ANALYTICS_TILE_COPY = {
  'jobs-finished': { title: 'Jobs finished', subtitle: 'Last 30 days' },
  clients: { title: 'Clients', subtitle: 'With a job finished, last 30 days' },
  'files-in-ready': { title: 'Files in → ready', subtitle: 'Typical job, last 30 days' },
  'editing-time': { title: 'Editing time', subtitle: 'The editor’s time on a typical job' },
  'approved-first-time': { title: 'Approved first time', subtitle: 'Reviewed jobs, last 30 days' },
} as const satisfies Record<AnalyticsTileKey, { title: string; subtitle: string }>;

/** The cards below the tiles. */
export const ANALYTICS_CARDS = {
  deliveredPerDay: { title: 'Jobs delivered per day', subtitle: 'Last 13 weeks' },
  footagePerWeek: {
    title: 'Footage edited per week',
    subtitle: 'Hours of raw footage the editor went through',
  },
  typicalJob: {
    title: 'A typical job, step by step',
    subtitle: 'The median job, last 30 days; “vs before” is the 30 days before',
  },
  rerunsPerApproved: {
    title: 'Re-runs per approved job, by week',
    subtitle: 'Median rounds of notes before you approved',
  },
  approvedFirstTime: {
    title: 'Approved first time, by week',
    subtitle: 'Share of reviewed jobs you approved without notes',
  },
  noteTopics: {
    title: 'What your notes are about',
    subtitle: 'Your review notes, most common first, with who got them',
  },
  apiCredits: {
    title: 'API credits',
    subtitle: 'The app’s own runs: edits, re-edits, renders',
  },
  maxPlan: {
    title: 'Max plan, this week',
    subtitle: 'Your Claude Code sessions',
  },
  creditsPaidFor: {
    title: 'What the API credits paid for',
    subtitle: 'The app’s runs this month, biggest first',
  },
  planUsage: {
    title: 'What used the plan this week',
    subtitle: 'Your sessions by tag, biggest first',
  },
  creditsThroughMonth: {
    title: 'API credits and plan through the month',
    subtitle: 'The share of each budget used so far',
  },
  busiestWeek: {
    title: 'Busiest week, last 8 weeks',
    subtitle: 'The plan’s weekly peak, and what the app spent of the month’s credits',
  },
} as const;

/** The words of the week period's tiles: the window is the last 7 days. */
const WEEK_TILE_COPY = {
  'jobs-finished': { title: 'Jobs finished', subtitle: 'Last 7 days' },
  clients: { title: 'Clients', subtitle: 'With a job finished, last 7 days' },
  'files-in-ready': { title: 'Files in → ready', subtitle: 'Typical job, last 7 days' },
  'editing-time': ANALYTICS_TILE_COPY['editing-time'],
  'approved-first-time': { title: 'Approved first time', subtitle: 'Reviewed jobs, last 7 days' },
} as const satisfies Record<AnalyticsTileKey, { title: string; subtitle: string }>;

/** The words of the week period's cards: by day, the last 7 days against the 7 before. */
const WEEK_CARDS = {
  deliveredPerDay: { title: 'Jobs delivered per day', subtitle: 'Last 14 days' },
  footagePerWeek: {
    title: 'Footage edited per day',
    subtitle: 'Hours of raw footage the editor went through',
  },
  typicalJob: {
    title: 'A typical job, step by step',
    subtitle: 'The median job, last 7 days; “vs before” is the 7 days before',
  },
  rerunsPerApproved: {
    title: 'Re-runs per approved job, by day',
    subtitle: 'Median rounds of notes before you approved',
  },
  approvedFirstTime: {
    title: 'Approved first time, by day',
    subtitle: 'Share of reviewed jobs you approved without notes',
  },
  noteTopics: ANALYTICS_CARDS.noteTopics,
  apiCredits: ANALYTICS_CARDS.apiCredits,
  maxPlan: ANALYTICS_CARDS.maxPlan,
  creditsPaidFor: ANALYTICS_CARDS.creditsPaidFor,
  planUsage: ANALYTICS_CARDS.planUsage,
  creditsThroughMonth: {
    title: 'API credits and plan through the week',
    subtitle: 'The share of each budget used, last 7 days',
  },
  busiestWeek: {
    title: 'Busiest day, last 14 days',
    subtitle: 'The plan’s peak five-hour use, and what the app spent of the month’s credits',
  },
} as const satisfies Record<keyof typeof ANALYTICS_CARDS, { title: string; subtitle: string }>;

/** The word under the last column of a chart: this week is not over ("now"), nor is today. */
export const NOW_LABEL: Record<AnalyticsPeriod, string> = { month: 'now', week: 'today' };

/** A title and the line under it. */
interface Words {
  title: string;
  subtitle: string;
}

/** The words of the five tiles for `period`. */
export function tileCopy(period: AnalyticsPeriod): Record<AnalyticsTileKey, Words> {
  return period === 'week' ? WEEK_TILE_COPY : ANALYTICS_TILE_COPY;
}

/** The words of the cards below the tiles for `period`. */
export function cardCopy(period: AnalyticsPeriod): Record<keyof typeof ANALYTICS_CARDS, Words> {
  return period === 'week' ? WEEK_CARDS : ANALYTICS_CARDS;
}

const MONTHS = [
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
];

/**
 * The subtitle of "What your notes are about": on the board it names the month the oldest note was
 * sent in ("Your review notes since September, …"). `since` is the day of the oldest note
 * (`reviews.notesSince`); without one the subtitle leaves the month out.
 */
export function noteTopicsSubtitle(since: string | null): string {
  const month = since === null ? undefined : MONTHS[Number(since.slice(5, 7)) - 1];
  return month === undefined
    ? ANALYTICS_CARDS.noteTopics.subtitle
    : `Your review notes since ${month}, most common first, with who got them`;
}

/** What a card says while it has nothing to show. */
export const NO_DATA_YET = 'No data yet';
